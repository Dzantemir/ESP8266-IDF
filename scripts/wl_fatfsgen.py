#!/usr/bin/env python
# SPDX-FileCopyrightText: 2021-2026 Espressif Systems (Shanghai) CO LTD
# SPDX-License-Identifier: Apache-2.0

import os
import struct
import sys
from datetime import datetime
from typing import Optional

from fatfs_utils.exceptions import NoFreeClusterException, WLNotInitialized
from fatfs_utils.long_filename_utils import get_required_lfn_entries_count
from fatfs_utils.utils import BYTES_PER_DIRECTORY_ENTRY, FULL_BYTE, UINT32_MAX
from fatfs_utils.utils import FATDefaults, FATFS_MIN_ALLOC_UNIT
from fatfs_utils.utils import crc32
from fatfs_utils.utils import generate_4bytes_random
from fatfs_utils.utils import get_args_for_partition_generator
from fatfs_utils.utils import get_fat_sectors_count
from fatfs_utils.utils import get_non_data_sectors_cnt
from fatfs_utils.utils import required_clusters_count
from fatfs_utils.utils import RESERVED_CLUSTERS_COUNT
from fatfsgen import FATFS, _collect_entries, _print_progress, calculate_min_space, count_root_entries


def remove_wl(binary_image):
    # type: (bytes) -> bytes
    partition_size = len(binary_image)
    total_sectors = partition_size // FATDefaults.WL_SECTOR_SIZE
    wl_state_size = WLFATFS.WL_STATE_HEADER_SIZE + WLFATFS.WL_STATE_RECORD_SIZE * total_sectors
    wl_state_sectors_cnt = (wl_state_size + FATDefaults.WL_SECTOR_SIZE - 1) // FATDefaults.WL_SECTOR_SIZE
    wl_state_total_size = wl_state_sectors_cnt * FATDefaults.WL_SECTOR_SIZE
    wl_sectors_size = (
        wl_state_sectors_cnt * FATDefaults.WL_SECTOR_SIZE * WLFATFS.WL_STATE_COPY_COUNT + FATDefaults.WL_SECTOR_SIZE
    )

    correct_wl_configuration = binary_image[-wl_sectors_size:]

    # Parse WL state header: pos(4) max_pos(4) move_count(4) access_count(4) max_count(4) block_size(4) version(4) device_id(4) reserved(28)
    state_data = correct_wl_configuration[:WLFATFS.WL_STATE_HEADER_SIZE]
    pos = struct.unpack_from('<I', state_data, 0)[0]
    max_pos = struct.unpack_from('<I', state_data, 4)[0]
    move_count = struct.unpack_from('<I', state_data, 8)[0]
    access_count = struct.unpack_from('<I', state_data, 12)[0]
    max_count = struct.unpack_from('<I', state_data, 16)[0]
    block_size = struct.unpack_from('<I', state_data, 20)[0]
    version = struct.unpack_from('<I', state_data, 24)[0]
    device_id = struct.unpack_from('<I', state_data, 28)[0]

    data_ = {
        'pos': pos,
        'max_pos': max_pos,
        'move_count': move_count,
        'access_count': access_count,
        'max_count': max_count,
        'block_size': block_size,
        'version': version,
        'device_id': device_id,
    }

    total_records = 0
    # iterating over records field of the first copy of the state sector
    for i in range(WLFATFS.WL_STATE_HEADER_SIZE, wl_state_total_size, WLFATFS.WL_STATE_RECORD_SIZE):
        if correct_wl_configuration[i: i + WLFATFS.WL_STATE_RECORD_SIZE] != WLFATFS.WL_STATE_RECORD_SIZE * b'\xff':
            total_records += 1
        else:
            break
    before_dummy = binary_image[: total_records * FATDefaults.WL_SECTOR_SIZE]
    after_dummy = binary_image[total_records * FATDefaults.WL_SECTOR_SIZE + FATDefaults.WL_SECTOR_SIZE:]
    new_image = before_dummy + after_dummy

    # remove wl sectors
    new_image = new_image[: len(new_image) - (FATDefaults.WL_SECTOR_SIZE + 2 * wl_state_total_size)]

    # reorder to preserve original order
    move_count = data_['move_count']
    if move_count < 0 or move_count * FATDefaults.WL_SECTOR_SIZE > len(new_image):
        raise ValueError(f'Invalid WL move_count: {move_count}')
    if move_count > 0:
        new_image = (
            new_image[-move_count * FATDefaults.WL_SECTOR_SIZE:]
            + new_image[: -move_count * FATDefaults.WL_SECTOR_SIZE]
        )
    return new_image


def _compute_wl_overhead_sectors(total_sectors, wl_mode):
    # type: (int, Optional[str]) -> int
    """Compute the number of WL overhead sectors for a given total sector count and mode."""
    wl_state_size = WLFATFS.WL_STATE_HEADER_SIZE + WLFATFS.WL_STATE_RECORD_SIZE * total_sectors
    wl_state_sectors = (wl_state_size + FATDefaults.WL_SECTOR_SIZE - 1) // FATDefaults.WL_SECTOR_SIZE
    wl_sectors = (
        WLFATFS.WL_DUMMY_SECTORS_COUNT
        + WLFATFS.WL_CFG_SECTORS_COUNT
        + wl_state_sectors * WLFATFS.WL_STATE_COPY_COUNT
    )
    if wl_mode is not None and wl_mode == 'safe':
        wl_sectors += WLFATFS.WL_SAFE_MODE_DUMP_SECTORS
    return wl_sectors


def _compute_available_data_clusters(partition_size, sector_size, sectors_per_cluster,
                                     root_entry_count, fat_tables_cnt, wl_mode):
    # type: (int, int, int, int, int, Optional[str]) -> int
    """Compute how many data clusters are available in the plain FATFS after WL overhead."""
    total_sectors = partition_size // FATDefaults.WL_SECTOR_SIZE
    wl_overhead = _compute_wl_overhead_sectors(total_sectors, wl_mode)
    plain_fat_sectors = total_sectors - wl_overhead

    root_dir_sectors = (root_entry_count * BYTES_PER_DIRECTORY_ENTRY) // sector_size
    # Estimate FAT sectors iteratively
    est_data_sectors = max(1, plain_fat_sectors - FATDefaults.RESERVED_SECTORS_COUNT - fat_tables_cnt - root_dir_sectors)
    est_clusters = est_data_sectors // sectors_per_cluster + RESERVED_CLUSTERS_COUNT
    fat_sectors = get_fat_sectors_count(est_clusters, sector_size)
    # Refine
    actual_data_sectors = plain_fat_sectors - get_non_data_sectors_cnt(
        FATDefaults.RESERVED_SECTORS_COUNT, fat_sectors, fat_tables_cnt, root_dir_sectors)
    actual_clusters = actual_data_sectors // sectors_per_cluster + RESERVED_CLUSTERS_COUNT
    fat_sectors = get_fat_sectors_count(actual_clusters, sector_size)
    actual_data_sectors = plain_fat_sectors - get_non_data_sectors_cnt(
        FATDefaults.RESERVED_SECTORS_COUNT, fat_sectors, fat_tables_cnt, root_dir_sectors)
    data_clusters = actual_data_sectors // sectors_per_cluster
    return data_clusters


def _optimize_root_entry_count(input_directory, partition_size, sector_size,
                               sectors_per_cluster, fat_tables_cnt, root_entry_count,
                               long_names_enabled, wl_mode):
    # type: (str, int, int, int, int, int, bool, Optional[str]) -> int
    """
    Optimize root_entry_count to free up data space when the partition is small.
    Returns the optimal root_entry_count that provides enough root entries for the
    files while maximizing data area.
    """
    entries_per_sector = sector_size // BYTES_PER_DIRECTORY_ENTRY

    # Calculate minimum root entries needed by the actual files
    min_root_entries = count_root_entries(input_directory, long_file_names=long_names_enabled)
    # Round up to sector alignment, at least 1 sector worth
    min_aligned = max(entries_per_sector,
                      ((min_root_entries + entries_per_sector - 1) // entries_per_sector) * entries_per_sector)

    # Calculate data clusters with current root_entry_count
    current_data_clusters = _compute_available_data_clusters(
        partition_size, sector_size, sectors_per_cluster, root_entry_count, fat_tables_cnt, wl_mode)

    # Calculate data clusters with minimum root_entry_count
    min_data_clusters = _compute_available_data_clusters(
        partition_size, sector_size, sectors_per_cluster, min_aligned, fat_tables_cnt, wl_mode)

    if min_data_clusters > current_data_clusters:
        return min_aligned

    return root_entry_count


def _calculate_min_wl_partition_size(input_directory, sector_size, sectors_per_cluster,
                                     fat_tables_cnt, root_entry_count, long_names_enabled, wl_mode):
    # type: (str, int, int, int, int, bool, Optional[str]) -> int
    """
    Calculate the minimum WL partition size needed to fit all files from input_directory.
    Uses a two-phase approach:
      1. Quick estimate based on file sizes + FATFS + WL overhead
      2. Try-and-grow loop for an exact result (guaranteed correct)
    """
    entries_per_sector = sector_size // BYTES_PER_DIRECTORY_ENTRY

    # --- Phase 1: pre-estimate ---
    # Optimize root_entry_count for the data we have
    min_root_entries = count_root_entries(input_directory, long_file_names=long_names_enabled)
    optimized_root = max(entries_per_sector,
                         ((min_root_entries + entries_per_sector - 1) // entries_per_sector) * entries_per_sector)
    # Don't go below the specified root_entry_count
    optimized_root = max(optimized_root, root_entry_count)

    # Estimate data clusters needed
    base_dir = os.path.dirname(input_directory) or '.'
    dir_name = os.path.basename(input_directory)
    try:
        data_clusters = calculate_min_space(
            [base_dir], dir_name,
            sector_size=sector_size,
            sectors_per_cluster=sectors_per_cluster,
            long_file_names=long_names_enabled,
            is_root=True)
    except Exception:
        data_clusters = 16  # safe fallback

    total_clusters = data_clusters + RESERVED_CLUSTERS_COUNT
    fat_sectors = get_fat_sectors_count(total_clusters, sector_size)
    root_dir_sectors = (optimized_root * BYTES_PER_DIRECTORY_ENTRY) // sector_size
    non_data = get_non_data_sectors_cnt(FATDefaults.RESERVED_SECTORS_COUNT, fat_sectors, fat_tables_cnt, root_dir_sectors)
    data_sectors = data_clusters * sectors_per_cluster
    min_plain_fat_sectors = data_sectors + non_data

    # Add WL overhead estimate
    wl_overhead = _compute_wl_overhead_sectors(min_plain_fat_sectors, wl_mode)
    start_total_sectors = min_plain_fat_sectors + wl_overhead
    start_partition_size = start_total_sectors * sector_size

    # Add 10% margin for estimation errors
    start_partition_size = int(start_partition_size * 1.1)
    # Round up to sector boundary
    if start_partition_size % sector_size != 0:
        start_partition_size += sector_size - (start_partition_size % sector_size)

    # Minimum: at least enough for a valid WL FATFS
    start_partition_size = max(start_partition_size, FATDefaults.WL_SECTOR_SIZE * 8)

    # --- Phase 2: try-and-grow ---
    partition_size = start_partition_size
    max_partition_size = 16 * 1024 * 1024  # 16 MB sanity limit

    while partition_size <= max_partition_size:
        # Optimize root_entry_count for current size
        opt_root = _optimize_root_entry_count(
            input_directory, partition_size, sector_size,
            sectors_per_cluster, fat_tables_cnt, optimized_root,
            long_names_enabled, wl_mode)

        # Align root_entry_count
        root_entry_count_aligned = opt_root
        if (root_entry_count_aligned * BYTES_PER_DIRECTORY_ENTRY) % sector_size != 0:
            eps = sector_size // BYTES_PER_DIRECTORY_ENTRY
            root_entry_count_aligned = ((root_entry_count_aligned + eps - 1) // eps) * eps
        if root_entry_count_aligned > 128:
            rds = (root_entry_count_aligned * BYTES_PER_DIRECTORY_ENTRY) // sector_size
            if rds % 2 != 0:
                root_entry_count_aligned = (rds + 1) * sector_size // BYTES_PER_DIRECTORY_ENTRY

        # Try to fit the data
        try:
            wl_fatfs = WLFATFS(
                size=partition_size,
                sector_size=sector_size,
                fat_tables_cnt=fat_tables_cnt,
                sectors_per_cluster=sectors_per_cluster,
                long_names_enabled=long_names_enabled,
                use_default_datetime=True,
                root_entry_count=root_entry_count_aligned,
                wl_mode=wl_mode,
            )
            _populate_wl_fatfs(wl_fatfs, _collect_entries(input_directory), quiet=True)
            # Success! Data fits
            return partition_size
        except NoFreeClusterException:
            # Doesn't fit — grow by one WL sector and retry
            partition_size += sector_size
            continue

    raise RuntimeError('Could not fit files in partition up to %d bytes' % max_partition_size)


class WLFATFS:
    # pylint: disable=too-many-instance-attributes
    WL_CFG_SECTORS_COUNT = 1
    WL_DUMMY_SECTORS_COUNT = 1
    WL_CONFIG_HEADER_SIZE = 48
    WL_STATE_RECORD_SIZE = 16
    WL_STATE_HEADER_SIZE = 64
    WL_STATE_COPY_COUNT = 2  # always 2 copies for power failure safety
    WL_SECTOR_SIZE = 0x1000
    WL_SAFE_MODE_DUMP_SECTORS = 2

    # WL_STATE_T_DATA layout (little-endian):
    # pos          uint32  (offset 0)
    # max_pos      uint32  (offset 4)
    # move_count   uint32  (offset 8)
    # access_count uint32  (offset 12)
    # max_count    uint32  (offset 16)
    # block_size   uint32  (offset 20)
    # version      uint32  (offset 24)
    # device_id    uint32  (offset 28)
    # reserved     28 bytes (offset 32)
    WL_STATE_T_FORMAT = '<IIIIIIII28s'

    # WL_CONFIG_T_DATA layout (little-endian):
    # start_addr     uint32
    # full_mem_size  uint32
    # page_size      uint32
    # sector_size    uint32
    # updaterate     uint32
    # wr_size        uint32
    # version        uint32
    # temp_buff_size uint32
    WL_CONFIG_T_FORMAT = '<IIIIIIII'

    def __init__(
        self,
        size=FATDefaults.SIZE,
        sector_size=FATDefaults.SECTOR_SIZE,
        reserved_sectors_cnt=FATDefaults.RESERVED_SECTORS_COUNT,
        fat_tables_cnt=FATDefaults.FAT_TABLES_COUNT,
        sectors_per_cluster=FATDefaults.SECTORS_PER_CLUSTER,
        explicit_fat_type=None,
        hidden_sectors=FATDefaults.HIDDEN_SECTORS,
        long_names_enabled=False,
        num_heads=FATDefaults.NUM_HEADS,
        oem_name=FATDefaults.OEM_NAME,
        sec_per_track=FATDefaults.SEC_PER_TRACK,
        volume_label=FATDefaults.VOLUME_LABEL,
        file_sys_type=FATDefaults.FILE_SYS_TYPE,
        use_default_datetime=True,
        version=FATDefaults.VERSION,
        temp_buff_size=FATDefaults.TEMP_BUFFER_SIZE,
        device_id=None,
        root_entry_count=FATDefaults.ROOT_ENTRIES_COUNT,
        media_type=FATDefaults.MEDIA_TYPE,
        wl_mode=None,
    ):
        # type: (int, int, int, int, int, Optional[int], int, bool, int, str, int, str, str, bool, int, int, Optional[int], int, int, Optional[str]) -> None
        self._initialized = False
        self._version = version
        self._temp_buff_size = temp_buff_size
        self._device_id = device_id
        self.partition_size = size
        self.total_sectors = self.partition_size // FATDefaults.WL_SECTOR_SIZE
        self.wl_state_size = WLFATFS.WL_STATE_HEADER_SIZE + WLFATFS.WL_STATE_RECORD_SIZE * self.total_sectors
        self.wl_mode = wl_mode

        # determine the number of required sectors (roundup to sector size)
        self.wl_state_sectors = (self.wl_state_size + FATDefaults.WL_SECTOR_SIZE - 1) // FATDefaults.WL_SECTOR_SIZE

        wl_sectors = (
            WLFATFS.WL_DUMMY_SECTORS_COUNT
            + WLFATFS.WL_CFG_SECTORS_COUNT
            + self.wl_state_sectors * WLFATFS.WL_STATE_COPY_COUNT
        )
        if self.wl_mode is not None and self.wl_mode == 'safe':
            wl_sectors += WLFATFS.WL_SAFE_MODE_DUMP_SECTORS

        self.boot_sector_start = FATDefaults.WL_SECTOR_SIZE  # shift by one "dummy" sector
        self.fat_table_start = self.boot_sector_start + reserved_sectors_cnt * FATDefaults.WL_SECTOR_SIZE

        self.plain_fat_sectors = self.total_sectors - wl_sectors
        self.plain_fatfs = FATFS(
            explicit_fat_type=explicit_fat_type,
            size=self.plain_fat_sectors * FATDefaults.WL_SECTOR_SIZE,
            reserved_sectors_cnt=reserved_sectors_cnt,
            fat_tables_cnt=fat_tables_cnt,
            sectors_per_cluster=sectors_per_cluster,
            sector_size=sector_size,
            root_entry_count=root_entry_count,
            hidden_sectors=hidden_sectors,
            long_names_enabled=long_names_enabled,
            num_heads=num_heads,
            use_default_datetime=use_default_datetime,
            oem_name=oem_name,
            sec_per_track=sec_per_track,
            volume_label=volume_label,
            file_sys_type=file_sys_type,
            media_type=media_type,
        )

        self.fatfs_binary_image = self.plain_fatfs.state.binary_image

    def init_wl(self):
        # type: () -> None
        self.fatfs_binary_image = self.plain_fatfs.state.binary_image
        self._add_dummy_sector()
        # config must be added after state, do not change the order of these two calls!
        self._add_state_sectors()
        self._add_config_sector()
        self._initialized = True

    def _add_dummy_sector(self):
        # type: () -> None
        self.fatfs_binary_image = FATDefaults.WL_SECTOR_SIZE * FULL_BYTE + self.fatfs_binary_image

    def _add_config_sector(self):
        # type: () -> None
        wl_config_data = struct.pack(
            WLFATFS.WL_CONFIG_T_FORMAT,
            0,                                          # start_addr
            self.partition_size,                        # full_mem_size
            FATDefaults.WL_SECTOR_SIZE,                 # page_size
            FATDefaults.WL_SECTOR_SIZE,                 # sector_size
            FATDefaults.UPDATE_RATE,                    # updaterate
            FATDefaults.WR_SIZE,                        # wr_size
            self._version,                              # version
            self._temp_buff_size,                       # temp_buff_size
        )

        crc_val = crc32(list(wl_config_data), UINT32_MAX)
        wl_config_crc = struct.pack('<I', crc_val)

        # adding three 4 byte zeros to align the structure
        wl_config = wl_config_data + wl_config_crc + struct.pack('<I', 0) + struct.pack('<I', 0) + struct.pack('<I', 0)

        self.fatfs_binary_image += wl_config + (FATDefaults.WL_SECTOR_SIZE - WLFATFS.WL_CONFIG_HEADER_SIZE) * FULL_BYTE

    def _add_state_sectors(self):
        # type: () -> None
        wl_state_data = struct.pack(
            WLFATFS.WL_STATE_T_FORMAT,
            0,      # pos
            (   # max_pos
                self.plain_fat_sectors
                + WLFATFS.WL_DUMMY_SECTORS_COUNT
                + (WLFATFS.WL_SAFE_MODE_DUMP_SECTORS if self.wl_mode == 'safe' else 0)
            ),
            0,      # move_count
            0,      # access_count
            FATDefaults.UPDATE_RATE,  # max_count
            FATDefaults.WL_SECTOR_SIZE,  # block_size
            self._version,  # version
            self._device_id or generate_4bytes_random(),  # device_id
            b'\x00' * 28,  # reserved
        )

        crc_val = crc32(list(wl_state_data), UINT32_MAX)
        wl_state_crc = struct.pack('<I', crc_val)
        wl_state = wl_state_data + wl_state_crc
        wl_state_sector_padding = (FATDefaults.WL_SECTOR_SIZE - WLFATFS.WL_STATE_HEADER_SIZE) * FULL_BYTE
        wl_state_sectors = (
            wl_state + wl_state_sector_padding + (self.wl_state_sectors - 1) * FATDefaults.WL_SECTOR_SIZE * FULL_BYTE
        )

        # add 2 extra state-preservation sectors in 'Safe' mode
        if self.wl_mode is not None and self.wl_mode == 'safe':
            wl_safe_dummy_sec = WLFATFS.WL_SAFE_MODE_DUMP_SECTORS * FATDefaults.WL_SECTOR_SIZE * FULL_BYTE
            self.fatfs_binary_image += wl_safe_dummy_sec

        self.fatfs_binary_image += WLFATFS.WL_STATE_COPY_COUNT * wl_state_sectors

    def wl_write_filesystem(self, output_path):
        # type: (str) -> None
        if not self._initialized:
            raise WLNotInitialized('FATFS is not initialized with WL. First call method WLFATFS.init_wl!')
        with open(output_path, 'wb') as output:
            output.write(bytearray(self.fatfs_binary_image))


def _populate_wl_fatfs(wl_fatfs, entries, quiet=False):
    # type: (WLFATFS, list, bool) -> None
    """Populate the WLFATFS with files/directories from entries list.

    When quiet=True, progress output is suppressed (used during size calculation).
    """
    total = len(entries)
    done = 0

    for rel_path, full_path, is_dir in entries:
        normal_path = os.path.normpath(rel_path)
        split_path = normal_path.split(os.sep)
        object_timestamp = datetime.fromtimestamp(os.path.getctime(full_path))

        if is_dir:
            wl_fatfs.plain_fatfs.create_directory(
                name=split_path[-1],
                path_from_root=split_path[:-1] if len(split_path) > 1 else None,
                object_timestamp_=object_timestamp)
        else:
            with open(full_path, 'rb') as f:
                content = f.read()
            file_name, extension = os.path.splitext(split_path[-1])
            extension = extension[1:] if extension else ''
            wl_fatfs.plain_fatfs.create_file(
                name=file_name,
                extension=extension,
                path_from_root=split_path[:-1] if len(split_path) > 1 else None,
                object_timestamp_=object_timestamp,
                is_empty=len(content) == 0)
            if content:
                wl_fatfs.plain_fatfs.write_content(split_path, content)

        done += 1
        if not quiet:
            _print_progress(done, total, rel_path)


if __name__ == '__main__':
    desc = 'Create a FAT filesystem with support for wear levelling and populate it with directory content'
    args = get_args_for_partition_generator(desc, wl=True)

    # ── Calculate minimum partition size from data ──
    min_size = _calculate_min_wl_partition_size(
        args.input_directory, args.sector_size, args.sectors_per_cluster,
        args.fat_count, args.root_entry_count, args.long_name_support, args.wl_mode)

    if args.partition_size == -1:
        # ── Auto/detect mode: use the calculated minimum ──
        partition_size = min_size
        print('[wl_fatfsgen] Auto-calculated partition size: %d bytes (0x%X, %d KB)'
              % (partition_size, partition_size, partition_size // 1024))
    else:
        # ── Explicit size: check if it's large enough ──
        if args.partition_size < min_size:
            print('[wl_fatfsgen] Error: specified partition size %d bytes (0x%X) is too small for the data.'
                  % (args.partition_size, args.partition_size))
            print('[wl_fatfsgen] Minimum required size: %d bytes (0x%X, %d KB)'
                  % (min_size, min_size, min_size // 1024))
            sys.exit(2)
        partition_size = args.partition_size
        print('[wl_fatfsgen] Partition size: %d bytes (0x%X, %d KB)'
              % (partition_size, partition_size, partition_size // 1024))

    # ── Optimize root_entry_count for the final partition size ──
    root_entry_count = _optimize_root_entry_count(
        args.input_directory, partition_size, args.sector_size,
        args.sectors_per_cluster, args.fat_count, args.root_entry_count,
        args.long_name_support, args.wl_mode)

    # Validate root_entry_count alignment constraints
    if (root_entry_count * BYTES_PER_DIRECTORY_ENTRY) % args.sector_size != 0:
        entries_per_sector = args.sector_size // BYTES_PER_DIRECTORY_ENTRY
        root_entry_count = ((root_entry_count + entries_per_sector - 1) // entries_per_sector) * entries_per_sector
    if root_entry_count > 128:
        root_dir_sectors = (root_entry_count * BYTES_PER_DIRECTORY_ENTRY) // args.sector_size
        if root_dir_sectors % 2 != 0:
            root_entry_count = (root_dir_sectors + 1) * args.sector_size // BYTES_PER_DIRECTORY_ENTRY

    # ── Print configuration ──
    print('[wl_fatfsgen] Configuration:')
    print('  Sector size:       %d  (0x%X)' % (args.sector_size, args.sector_size))
    print('  Partition size:    %d  (0x%X)' % (partition_size, partition_size))
    print('  Sectors/cluster:   %d' % args.sectors_per_cluster)
    print('  FAT tables:        %d' % args.fat_count)
    print('  Root entries:      %d' % root_entry_count)
    print('  Long names:        %s' % ('enabled' if args.long_name_support else 'disabled'))
    print('  WL mode:           %s' % (args.wl_mode or 'none'))

    # ── Build the WL FATFS image (guaranteed to fit) ──
    wl_fatfs = WLFATFS(
        size=partition_size,
        sector_size=args.sector_size,
        fat_tables_cnt=args.fat_count,
        sectors_per_cluster=args.sectors_per_cluster,
        explicit_fat_type=args.fat_type,
        long_names_enabled=args.long_name_support,
        use_default_datetime=args.use_default_datetime,
        root_entry_count=root_entry_count,
        wl_mode=args.wl_mode,
    )
    _populate_wl_fatfs(wl_fatfs, _collect_entries(args.input_directory))

    # ── Finalize — write WL sectors and output ──
    wl_fatfs.init_wl()
    wl_fatfs.wl_write_filesystem(args.output_file)

    print('[wl_fatfsgen] Image written (%d bytes, WL %s) -> %s'
          % (partition_size, args.wl_mode or 'none', args.output_file))
