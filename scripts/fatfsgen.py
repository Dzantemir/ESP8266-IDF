#!/usr/bin/env python
# SPDX-FileCopyrightText: 2021-2024 Espressif Systems (Shanghai) CO LTD
# SPDX-License-Identifier: Apache-2.0
import os
import sys
from datetime import datetime
from typing import Any, List, Optional

from fatfs_utils.boot_sector import BootSector
from fatfs_utils.exceptions import NoFreeClusterException
from fatfs_utils.fat import FAT
from fatfs_utils.fatfs_state import FATFSState
from fatfs_utils.fs_object import Directory
from fatfs_utils.long_filename_utils import get_required_lfn_entries_count
from fatfs_utils.utils import BYTES_PER_DIRECTORY_ENTRY
from fatfs_utils.utils import FATDefaults
from fatfs_utils.utils import FATFS_INCEPTION
from fatfs_utils.utils import FATFS_MIN_ALLOC_UNIT
from fatfs_utils.utils import get_args_for_partition_generator
from fatfs_utils.utils import get_fat_sectors_count
from fatfs_utils.utils import get_non_data_sectors_cnt
from fatfs_utils.utils import read_filesystem
from fatfs_utils.utils import required_clusters_count
from fatfs_utils.utils import RESERVED_CLUSTERS_COUNT


# ─── Progress bar helper (same format as spiffsgen.py / littlefsgen.py) ─────
def _print_progress(done, total, path):
    pct = int(done * 100 / total) if total else 100
    bar_len = 30
    filled = bar_len * done // total if total else bar_len
    bar = '#' * filled + '-' * (bar_len - filled)
    sys.stderr.write('[%s] %3d%% (%d/%d)  %s\n' % (bar, pct, done, total, path))
    sys.stderr.flush()


def _collect_entries(base_dir):
    """Return sorted list of (relative_path, full_path, is_dir) for all entries."""
    result = []
    for dirpath, dirnames, filenames in os.walk(base_dir):
        dirnames.sort()  # sort in-place so os.walk visits them in order
        for d in dirnames:
            full = os.path.join(dirpath, d)
            rel = os.path.relpath(full, base_dir).replace('\\', '/')
            result.append((rel, full, True))
        for f in sorted(filenames):
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, base_dir).replace('\\', '/')
            result.append((rel, full, False))
    return result


def duplicate_fat_decorator(func):
    def wrapper(self, *args, **kwargs):
        result = func(self, *args, **kwargs)
        if isinstance(self, FATFS):
            self.duplicate_fat()
        return result
    return wrapper


class FATFS:
    """
    The class FATFS provides API for generating FAT file system.
    It contains reference to the FAT table and to the root directory.
    """

    def __init__(self,
                 binary_image_path=None,
                 size=FATDefaults.SIZE,
                 reserved_sectors_cnt=FATDefaults.RESERVED_SECTORS_COUNT,
                 fat_tables_cnt=FATDefaults.FAT_TABLES_COUNT,
                 sectors_per_cluster=FATDefaults.SECTORS_PER_CLUSTER,
                 sector_size=FATDefaults.SECTOR_SIZE,
                 hidden_sectors=FATDefaults.HIDDEN_SECTORS,
                 long_names_enabled=False,
                 use_default_datetime=True,
                 num_heads=FATDefaults.NUM_HEADS,
                 oem_name=FATDefaults.OEM_NAME,
                 sec_per_track=FATDefaults.SEC_PER_TRACK,
                 volume_label=FATDefaults.VOLUME_LABEL,
                 file_sys_type=FATDefaults.FILE_SYS_TYPE,
                 root_entry_count=FATDefaults.ROOT_ENTRIES_COUNT,
                 explicit_fat_type=None,
                 media_type=FATDefaults.MEDIA_TYPE):
        # type: (Optional[str], int, int, int, int, int, int, bool, bool, int, str, int, str, str, int, Optional[int], int) -> None
        # root directory bytes should be aligned by sector size
        assert (int(root_entry_count) * BYTES_PER_DIRECTORY_ENTRY) % sector_size == 0
        # number of bytes in the root dir must be even multiple of BPB_BytsPerSec
        if (int(root_entry_count) > 128):
            assert ((int(root_entry_count) * BYTES_PER_DIRECTORY_ENTRY) // sector_size) % 2 == 0

        root_dir_sectors_cnt = (int(root_entry_count) * BYTES_PER_DIRECTORY_ENTRY) // sector_size

        self.state = FATFSState(sector_size=sector_size,
                                explicit_fat_type=explicit_fat_type,
                                reserved_sectors_cnt=reserved_sectors_cnt,
                                root_dir_sectors_cnt=root_dir_sectors_cnt,
                                size=size,
                                file_sys_type=file_sys_type,
                                num_heads=num_heads,
                                fat_tables_cnt=fat_tables_cnt,
                                sectors_per_cluster=sectors_per_cluster,
                                media_type=media_type,
                                hidden_sectors=hidden_sectors,
                                sec_per_track=sec_per_track,
                                long_names_enabled=long_names_enabled,
                                volume_label=volume_label,
                                oem_name=oem_name,
                                use_default_datetime=use_default_datetime)
        binary_image = bytearray(
            read_filesystem(binary_image_path) if binary_image_path else self.create_empty_fatfs())
        self.state.binary_image = binary_image

        self.fat = FAT(boot_sector_state=self.state.boot_sector_state, init_=True)

        root_dir_size = self.state.boot_sector_state.root_dir_sectors_cnt * self.state.boot_sector_state.sector_size
        self.root_directory = Directory(name='A',  # the name is not important, must be string
                                        size=root_dir_size,
                                        fat=self.fat,
                                        cluster=self.fat.clusters[1],
                                        fatfs_state=self.state)
        self.root_directory.init_directory()

    @duplicate_fat_decorator
    def create_file(self, name, extension='', path_from_root=None,
                    object_timestamp_=FATFS_INCEPTION, is_empty=False):
        # type: (str, str, Optional[List[str]], datetime, bool) -> None
        """
        This method allocates necessary clusters and creates a new file record in the directory required.
        The directory must exists.

        When path_from_root is None the dir is root.
        """
        self.root_directory.new_file(name=name,
                                     extension=extension,
                                     path_from_root=path_from_root,
                                     object_timestamp_=object_timestamp_,
                                     is_empty=is_empty)

    @duplicate_fat_decorator
    def create_directory(self, name, path_from_root=None,
                         object_timestamp_=FATFS_INCEPTION):
        # type: (str, Optional[List[str]], datetime) -> None
        """
        Initially recursively finds a parent of the new directory
        and then create a new directory inside the parent.
        """
        parent_dir = self.root_directory
        if path_from_root:
            parent_dir = self.root_directory.recursive_search(path_from_root, self.root_directory)

        self.root_directory.new_directory(name=name,
                                          parent=parent_dir,
                                          path_from_root=path_from_root,
                                          object_timestamp_=object_timestamp_)

    @duplicate_fat_decorator
    def write_content(self, path_from_root, content):
        # type: (List[str], bytes) -> None
        """
        fat fs invokes root directory to recursively find the required file and writes the content
        """
        self.root_directory.write_to_file(path_from_root, content)

    def create_empty_fatfs(self):
        # type: () -> Any
        boot_sector_ = BootSector(boot_sector_state=self.state.boot_sector_state)
        boot_sector_.generate_boot_sector()
        return boot_sector_.binary_image

    def duplicate_fat(self):
        # type: () -> None
        """
        Duplicate FAT table if 2 FAT tables are required
        """
        boot_sec_st = self.state.boot_sector_state
        if boot_sec_st.fat_tables_cnt == 2:
            fat_start = boot_sec_st.reserved_sectors_cnt * boot_sec_st.sector_size
            fat_end = fat_start + boot_sec_st.sectors_per_fat_cnt * boot_sec_st.sector_size
            second_fat_shift = boot_sec_st.sectors_per_fat_cnt * boot_sec_st.sector_size
            self.state.binary_image[fat_start + second_fat_shift: fat_end + second_fat_shift] = (
                self.state.binary_image[fat_start: fat_end]
            )

    def write_filesystem(self, output_path):
        # type: (str) -> None
        with open(output_path, 'wb') as output:
            output.write(bytearray(self.state.binary_image))

    @duplicate_fat_decorator
    def _generate_partition_from_folder(self,
                                        folder_relative_path,
                                        folder_path='',
                                        is_dir=False):
        # type: (str, str, bool) -> None
        """
        Given path to folder and folder name recursively encodes folder into binary image.
        Used by method generate.
        """
        real_path = os.path.join(folder_path, folder_relative_path)
        lower_path = folder_relative_path

        folder_relative_path = folder_relative_path.upper()

        normal_path = os.path.normpath(folder_relative_path)
        split_path = normal_path.split(os.sep)
        object_timestamp = datetime.fromtimestamp(os.path.getctime(real_path))

        if os.path.isfile(real_path):
            with open(real_path, 'rb') as file:
                content = file.read()
            file_name, extension = os.path.splitext(split_path[-1])
            extension = extension[1:]  # remove the dot from the extension
            self.create_file(name=file_name,
                             extension=extension,
                             path_from_root=split_path[1:-1] or None,
                             object_timestamp_=object_timestamp,
                             is_empty=len(content) == 0)
            self.write_content(split_path[1:], content)
        elif os.path.isdir(real_path):
            if not is_dir:
                self.create_directory(name=split_path[-1],
                                      path_from_root=split_path[1:-1],
                                      object_timestamp_=object_timestamp)

            # sorting files for better testability
            dir_content = list(sorted(os.listdir(real_path)))
            for path_ in dir_content:
                self._generate_partition_from_folder(os.path.join(lower_path, path_), folder_path=folder_path)

    def generate(self, input_directory):
        # type: (str) -> None
        """
        Normalize path to folder and recursively encode folder to binary image
        """
        path_to_folder, folder_name = os.path.split(input_directory)
        self._generate_partition_from_folder(folder_name, folder_path=path_to_folder, is_dir=True)


def calculate_min_space(path, fs_entity, sector_size=0x1000, sectors_per_cluster=1,
                        long_file_names=False, is_root=False):
    # type: (List[str], str, int, int, bool, bool) -> int
    cluster_size = sector_size * sectors_per_cluster
    if os.path.isfile(os.path.join(*path, fs_entity)):
        with open(os.path.join(*path, fs_entity), 'rb') as file_:
            content = file_.read()
        # Return number of CLUSTERS needed for the file content
        res = required_clusters_count(cluster_size, content)
        return res
    buff = 0
    dir_size = 2 * FATDefaults.ENTRY_SIZE  # record for symlinks "." and ".."
    for file_ in sorted(os.listdir(os.path.join(*path, fs_entity))):
        if long_file_names:
            # LFN entries + one short entry
            dir_size += (get_required_lfn_entries_count(file_) + 1) * FATDefaults.ENTRY_SIZE
        else:
            dir_size += FATDefaults.ENTRY_SIZE
        buff += calculate_min_space(path + [fs_entity], file_, sector_size, sectors_per_cluster,
                                    long_file_names, is_root=False)
    if is_root and dir_size // FATDefaults.ENTRY_SIZE > FATDefaults.ROOT_ENTRIES_COUNT:
        raise NoFreeClusterException('Not enough space in root!')

    # Directory metadata occupies whole clusters; roundup cluster count, at least one
    dir_clusters = (dir_size + cluster_size - 1) // cluster_size
    buff += dir_clusters
    return buff


def count_root_entries(input_directory, long_file_names=False):
    # type: (str, bool) -> int
    """Count the number of directory entries needed in the root directory."""
    count = 0  # no volume label directory entry is created (only BS_VolLab in boot sector)
    try:
        for entry in sorted(os.listdir(input_directory)):
            count += 1  # short entry
            if long_file_names:
                # LFN entries (each holds 13 characters)
                count += get_required_lfn_entries_count(entry)
    except OSError:
        pass
    return count


def _calculate_min_partition_size(input_directory, sector_size, sectors_per_cluster,
                                  fat_tables_cnt, root_entry_count, long_names_enabled):
    # type: (str, int, int, int, int, bool) -> int
    """
    Calculate the minimum partition size needed to fit all files from input_directory.
    Uses a two-phase approach:
      1. Quick estimate based on file sizes + FATFS overhead
      2. Try-and-grow loop for an exact result (guaranteed correct)
    """
    entries_per_sector = sector_size // BYTES_PER_DIRECTORY_ENTRY

    # --- Phase 1: pre-estimate ---
    min_root_entries = count_root_entries(input_directory, long_file_names=long_names_enabled)
    optimized_root = max(entries_per_sector,
                         ((min_root_entries + entries_per_sector - 1) // entries_per_sector) * entries_per_sector)
    optimized_root = max(optimized_root, root_entry_count)

    data_clusters = calculate_min_space(
        [os.path.dirname(input_directory)] if os.path.dirname(input_directory) else ['.'],
        os.path.basename(input_directory), sector_size,
        sectors_per_cluster, long_file_names=long_names_enabled, is_root=True)
    total_clusters = data_clusters + RESERVED_CLUSTERS_COUNT
    fats = get_fat_sectors_count(total_clusters, sector_size)
    root_dir_sectors = (optimized_root * BYTES_PER_DIRECTORY_ENTRY) // sector_size
    non_data = get_non_data_sectors_cnt(FATDefaults.RESERVED_SECTORS_COUNT,
                                        fats, fat_tables_cnt, root_dir_sectors)
    data_sectors = data_clusters * sectors_per_cluster
    start_partition_size = max(FATFS_MIN_ALLOC_UNIT * sector_size,
                               (data_sectors + non_data) * sector_size)
    # Add 10% margin for estimation errors
    start_partition_size = int(start_partition_size * 1.1)
    if start_partition_size % sector_size != 0:
        start_partition_size += sector_size - (start_partition_size % sector_size)

    # --- Phase 2: try-and-grow ---
    partition_size = start_partition_size
    max_partition_size = 16 * 1024 * 1024  # 16 MB sanity limit

    while partition_size <= max_partition_size:
        # Optimize root_entry_count for current size
        opt_root = max(optimized_root, root_entry_count)
        # Align root_entry_count
        if (opt_root * BYTES_PER_DIRECTORY_ENTRY) % sector_size != 0:
            eps = sector_size // BYTES_PER_DIRECTORY_ENTRY
            opt_root = ((opt_root + eps - 1) // eps) * eps
        if opt_root > 128:
            rds = (opt_root * BYTES_PER_DIRECTORY_ENTRY) // sector_size
            if rds % 2 != 0:
                opt_root = (rds + 1) * sector_size // BYTES_PER_DIRECTORY_ENTRY

        try:
            fatfs = FATFS(size=partition_size,
                          fat_tables_cnt=fat_tables_cnt,
                          sectors_per_cluster=sectors_per_cluster,
                          sector_size=sector_size,
                          long_names_enabled=long_names_enabled,
                          use_default_datetime=True,
                          root_entry_count=opt_root,
                          explicit_fat_type=None)
            entries = _collect_entries(input_directory)
            for rel_path, full_path, is_dir in entries:
                normal_path = os.path.normpath(rel_path)
                split_path = normal_path.split(os.sep)
                object_timestamp = datetime.fromtimestamp(os.path.getctime(full_path))
                if is_dir:
                    fatfs.create_directory(name=split_path[-1],
                                           path_from_root=split_path[:-1] if len(split_path) > 1 else None,
                                           object_timestamp_=object_timestamp)
                else:
                    with open(full_path, 'rb') as f:
                        content = f.read()
                    file_name, extension = os.path.splitext(split_path[-1])
                    extension = extension[1:] if extension else ''
                    fatfs.create_file(name=file_name,
                                      extension=extension,
                                      path_from_root=split_path[:-1] if len(split_path) > 1 else None,
                                      object_timestamp_=object_timestamp,
                                      is_empty=len(content) == 0)
                    if content:
                        fatfs.write_content(split_path, content)
            # Success! Data fits
            return partition_size
        except NoFreeClusterException:
            partition_size += sector_size
            continue

    raise RuntimeError('Could not fit files in partition up to %d bytes' % max_partition_size)


def main():
    args = get_args_for_partition_generator('Create a FAT filesystem and populate it with directory content', wl=False)

    is_auto = (args.partition_size == -1)

    if is_auto:
        # ── Auto/detect mode: calculate the minimum partition size ──
        args.partition_size = _calculate_min_partition_size(
            args.input_directory, args.sector_size, args.sectors_per_cluster,
            args.fat_count, args.root_entry_count, args.long_name_support)
        print('[fatfsgen] Auto-calculated partition size: %d bytes (0x%X, %d KB)'
              % (args.partition_size, args.partition_size, args.partition_size // 1024))

    # Print configuration
    print('[fatfsgen] Configuration:')
    print('  Sector size:       %d  (0x%X)' % (args.sector_size, args.sector_size))
    print('  Partition size:    %d  (0x%X)' % (args.partition_size, args.partition_size))
    print('  Sectors/cluster:   %d' % args.sectors_per_cluster)
    print('  FAT tables:        %d' % args.fat_count)
    print('  Root entries:      %d' % args.root_entry_count)
    print('  Long names:        %s' % ('enabled' if args.long_name_support else 'disabled'))

    # Optimize root_entry_count for the final partition size
    entries_per_sector = args.sector_size // BYTES_PER_DIRECTORY_ENTRY
    min_root_entries = count_root_entries(args.input_directory, long_file_names=args.long_name_support)
    optimized_root = max(entries_per_sector,
                         ((min_root_entries + entries_per_sector - 1) // entries_per_sector) * entries_per_sector)
    args.root_entry_count = max(optimized_root, args.root_entry_count)

    # Align root_entry_count
    if (args.root_entry_count * BYTES_PER_DIRECTORY_ENTRY) % args.sector_size != 0:
        eps = args.sector_size // BYTES_PER_DIRECTORY_ENTRY
        args.root_entry_count = ((args.root_entry_count + eps - 1) // eps) * eps
    if args.root_entry_count > 128:
        rds = (args.root_entry_count * BYTES_PER_DIRECTORY_ENTRY) // args.sector_size
        if rds % 2 != 0:
            args.root_entry_count = (rds + 1) * args.sector_size // BYTES_PER_DIRECTORY_ENTRY

    fatfs = FATFS(size=args.partition_size,
                  fat_tables_cnt=args.fat_count,
                  sectors_per_cluster=args.sectors_per_cluster,
                  sector_size=args.sector_size,
                  long_names_enabled=args.long_name_support,
                  use_default_datetime=args.use_default_datetime,
                  root_entry_count=args.root_entry_count,
                  explicit_fat_type=args.fat_type)

    # Collect entries and generate with progress
    entries = _collect_entries(args.input_directory)
    total = len(entries)

    try:
        done = 0
        for rel_path, full_path, is_dir in entries:
            normal_path = os.path.normpath(rel_path)
            split_path = normal_path.split(os.sep)
            object_timestamp = datetime.fromtimestamp(os.path.getctime(full_path))

            if is_dir:
                fatfs.create_directory(name=split_path[-1],
                                       path_from_root=split_path[:-1] if len(split_path) > 1 else None,
                                       object_timestamp_=object_timestamp)
            else:
                with open(full_path, 'rb') as f:
                    content = f.read()
                file_name, extension = os.path.splitext(split_path[-1])
                extension = extension[1:] if extension else ''
                fatfs.create_file(name=file_name,
                                  extension=extension,
                                  path_from_root=split_path[:-1] if len(split_path) > 1 else None,
                                  object_timestamp_=object_timestamp,
                                  is_empty=len(content) == 0)
                if content:
                    fatfs.write_content(split_path, content)

            done += 1
            _print_progress(done, total, rel_path)

        fatfs.write_filesystem(args.output_file)
    except NoFreeClusterException:
        if is_auto:
            raise  # auto-mode uses try-and-grow, should never fail
        # Explicit size is too small — calculate minimum and exit
        min_size = _calculate_min_partition_size(
            args.input_directory, args.sector_size, args.sectors_per_cluster,
            args.fat_count, args.root_entry_count, args.long_name_support)
        print('[fatfsgen] Error: specified partition size %d bytes (0x%X) is too small for the data.'
              % (args.partition_size, args.partition_size))
        print('[fatfsgen] Minimum required size: %d bytes (0x%X, %d KB)'
              % (min_size, min_size, min_size // 1024))
        sys.exit(2)

    print('[fatfsgen] Image written (%d bytes, %d sectors) -> %s'
          % (args.partition_size, args.partition_size // args.sector_size, args.output_file))


if __name__ == '__main__':
    main()
