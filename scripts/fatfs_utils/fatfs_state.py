# SPDX-FileCopyrightText: 2021-2022 Espressif Systems (Shanghai) CO LTD
# SPDX-License-Identifier: Apache-2.0

from textwrap import dedent
from typing import Optional

from .exceptions import InconsistentFATAttributes
from .utils import (ALLOWED_SECTOR_SIZES, FAT12, FAT12_MAX_CLUSTERS, FAT16, FAT16_MAX_CLUSTERS,
                    RESERVED_CLUSTERS_COUNT, FATDefaults, get_fat_sectors_count, get_fatfs_type,
                    get_non_data_sectors_cnt, number_of_clusters)


class FATFSState:
    """
    The class represents the state and the configuration of the FATFS.
    """

    def __init__(self,
                 sector_size,
                 reserved_sectors_cnt,
                 root_dir_sectors_cnt,
                 size,
                 media_type,
                 sectors_per_cluster,
                 volume_label,
                 oem_name,
                 fat_tables_cnt,
                 sec_per_track,
                 num_heads,
                 hidden_sectors,
                 file_sys_type,
                 use_default_datetime,
                 explicit_fat_type=None,
                 long_names_enabled=False):
        # type: (int, int, int, int, int, int, str, str, int, int, int, int, str, bool, Optional[int], bool) -> None
        self.boot_sector_state = BootSectorState(oem_name=oem_name,
                                                 sector_size=sector_size,
                                                 sectors_per_cluster=sectors_per_cluster,
                                                 reserved_sectors_cnt=reserved_sectors_cnt,
                                                 fat_tables_cnt=fat_tables_cnt,
                                                 root_dir_sectors_cnt=root_dir_sectors_cnt,
                                                 sectors_count=size // sector_size,
                                                 media_type=media_type,
                                                 sec_per_track=sec_per_track,
                                                 num_heads=num_heads,
                                                 hidden_sectors=hidden_sectors,
                                                 volume_label=volume_label,
                                                 file_sys_type=file_sys_type,
                                                 volume_uuid=-1)

        self._explicit_fat_type = explicit_fat_type
        self.long_names_enabled = long_names_enabled
        self.use_default_datetime = use_default_datetime

        # Warn if the cluster count is near the FAT12/FAT16 boundary
        # clusters_count will be computed later, so we estimate it here
        _estimated_clusters = (size // sector_size - reserved_sectors_cnt - root_dir_sectors_cnt) // sectors_per_cluster + RESERVED_CLUSTERS_COUNT
        if _estimated_clusters in (FAT12_MAX_CLUSTERS - 1, FAT12_MAX_CLUSTERS, FAT16_MAX_CLUSTERS - 1, FAT16_MAX_CLUSTERS):
            print('WARNING: It is not recommended to create FATFS with bounding '
                  'count of clusters: %d or %d' % (FAT12_MAX_CLUSTERS, FAT16_MAX_CLUSTERS))
        self.check_fat_type()

    @property
    def binary_image(self):
        # type: () -> bytearray
        return self.boot_sector_state.binary_image

    @binary_image.setter
    def binary_image(self, value):
        # type: (bytearray) -> None
        self.boot_sector_state.binary_image = value

    def check_fat_type(self):
        # type: () -> None
        _type = self.boot_sector_state.fatfs_type
        if self._explicit_fat_type is not None and self._explicit_fat_type != _type:
            raise InconsistentFATAttributes(dedent(
                'FAT type you specified is inconsistent with other attributes of the system.\n'
                'The specified FATFS type: FAT%d\n'
                'The actual FATFS type: FAT%d' % (self._explicit_fat_type, _type)))
        if _type not in (FAT12, FAT16):
            raise NotImplementedError('FAT32 is currently not supported.')


class BootSectorState:
    # pylint: disable=too-many-instance-attributes
    def __init__(self,
                 oem_name,
                 sector_size,
                 sectors_per_cluster,
                 reserved_sectors_cnt,
                 fat_tables_cnt,
                 root_dir_sectors_cnt,
                 sectors_count,
                 media_type,
                 sec_per_track,
                 num_heads,
                 hidden_sectors,
                 volume_label,
                 file_sys_type,
                 volume_uuid=-1):
        # type: (str, int, int, int, int, int, int, int, int, int, int, str, str, int) -> None
        self.oem_name = oem_name
        self.sector_size = sector_size
        assert self.sector_size in ALLOWED_SECTOR_SIZES
        self.sectors_per_cluster = sectors_per_cluster
        self.reserved_sectors_cnt = reserved_sectors_cnt
        self.fat_tables_cnt = fat_tables_cnt
        self.root_dir_sectors_cnt = root_dir_sectors_cnt
        self.sectors_count = sectors_count
        self.media_type = media_type
        # Estimate clusters_count for FAT size calculation (circular dependency:
        # clusters_count depends on sectors_per_fat_cnt, which depends on clusters_count)
        # We estimate by assuming minimal FAT overhead first, then refine
        estimated_data_sectors = sectors_count - reserved_sectors_cnt - root_dir_sectors_cnt - 2  # rough FAT estimate
        estimated_clusters = number_of_clusters(max(estimated_data_sectors, 1), sectors_per_cluster) + RESERVED_CLUSTERS_COUNT
        self.sectors_per_fat_cnt = get_fat_sectors_count(estimated_clusters, sector_size)
        # Now refine with the actual FAT size
        actual_data_sectors = sectors_count - get_non_data_sectors_cnt(
            reserved_sectors_cnt, self.sectors_per_fat_cnt, fat_tables_cnt, root_dir_sectors_cnt
        )
        actual_clusters = number_of_clusters(max(actual_data_sectors, 1), sectors_per_cluster) + RESERVED_CLUSTERS_COUNT
        self.sectors_per_fat_cnt = get_fat_sectors_count(actual_clusters, sector_size)
        self.sec_per_track = sec_per_track
        self.num_heads = num_heads
        self.hidden_sectors = hidden_sectors
        self.volume_label = volume_label
        self.file_sys_type = file_sys_type
        self.volume_uuid = volume_uuid
        self._binary_image = bytearray(b'')

    @property
    def binary_image(self):
        # type: () -> bytearray
        return self._binary_image

    @binary_image.setter
    def binary_image(self, value):
        # type: (bytearray) -> None
        self._binary_image = value

    @property
    def size(self):
        # type: () -> int
        return self.sector_size * self.sectors_count

    @property
    def data_region_start(self):
        # type: () -> int
        return self.non_data_sectors * self.sector_size

    @property
    def fatfs_type(self):
        # type: () -> int
        typed_fatfs_type = get_fatfs_type(self.clusters)
        return typed_fatfs_type

    @property
    def clusters(self):
        # type: () -> int
        clusters_cnt_ = number_of_clusters(self.data_sectors, self.sectors_per_cluster) + RESERVED_CLUSTERS_COUNT
        return clusters_cnt_

    @property
    def data_sectors(self):
        # type: () -> int
        return (self.size // self.sector_size) - self.non_data_sectors

    @property
    def non_data_sectors(self):
        # type: () -> int
        non_data_sectors_ = get_non_data_sectors_cnt(self.reserved_sectors_cnt,
                                                      self.sectors_per_fat_cnt,
                                                      self.fat_tables_cnt,
                                                      self.root_dir_sectors_cnt)
        return non_data_sectors_

    @property
    def fat_table_start_address(self):
        # type: () -> int
        return self.sector_size * self.reserved_sectors_cnt

    @property
    def entries_root_count(self):
        # type: () -> int
        entries_root_count_ = (self.root_dir_sectors_cnt * self.sector_size) // FATDefaults.ENTRY_SIZE
        return entries_root_count_

    @property
    def root_directory_start(self):
        # type: () -> int
        root_dir_start = (self.reserved_sectors_cnt + self.sectors_per_fat_cnt * self.fat_tables_cnt) * self.sector_size
        return root_dir_start
