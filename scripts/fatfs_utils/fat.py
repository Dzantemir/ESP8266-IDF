# SPDX-FileCopyrightText: 2021-2022 Espressif Systems (Shanghai) CO LTD
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional

from .cluster import Cluster
from .exceptions import NoFreeClusterException
from .fatfs_state import BootSectorState


class FAT:
    """
    The FAT represents the FAT region in file system. It is responsible for storing clusters
    and chaining them in case we need to extend file or directory to more clusters.
    """

    def allocate_root_dir(self):
        # type: () -> None
        self.clusters[Cluster.ROOT_BLOCK_ID].allocate_cluster()

    def __init__(self, boot_sector_state, init_):
        # type: (BootSectorState, bool) -> None
        self._first_free_cluster_id = 1
        self.boot_sector_state = boot_sector_state
        self.clusters = [Cluster(cluster_id=i,
                                 boot_sector_state=self.boot_sector_state,
                                 init_=init_) for i in range(self.boot_sector_state.clusters)]  # type: List[Cluster]
        if init_:
            self.allocate_root_dir()

    def get_cluster_value(self, cluster_id_):
        # type: (int) -> int
        fat_cluster_value_ = self.clusters[cluster_id_].get_from_fat()
        return fat_cluster_value_

    def is_cluster_last(self, cluster_id_):
        # type: (int) -> bool
        value_ = self.get_cluster_value(cluster_id_)
        is_cluster_last_ = value_ == (1 << self.boot_sector_state.fatfs_type) - 1
        return is_cluster_last_

    def get_chained_content(self, cluster_id_, size=None):
        # type: (int, Optional[int]) -> bytearray
        binary_image = self.boot_sector_state.binary_image
        cluster_size = self.boot_sector_state.sectors_per_cluster * self.boot_sector_state.sector_size

        # Bad cluster markers
        FAT12_BAD_CLUSTER = 0xFF7
        FAT16_BAD_CLUSTER = 0xFFF7

        data_address_ = Cluster.compute_cluster_data_address(self.boot_sector_state, cluster_id_)
        content_ = binary_image[data_address_: data_address_ + cluster_size]

        visited = {cluster_id_}  # track visited clusters for cycle detection

        while not self.is_cluster_last(cluster_id_):
            cluster_id_ = self.get_cluster_value(cluster_id_)
            # Check for bad cluster markers
            bad_marker = FAT12_BAD_CLUSTER if self.boot_sector_state.fatfs_type == FAT12 else FAT16_BAD_CLUSTER
            if cluster_id_ == bad_marker:
                raise RuntimeError(f'Bad cluster marker (0x{bad_marker:X}) encountered in FAT chain')
            # Cycle detection for corrupted FAT images
            if cluster_id_ in visited:
                raise RuntimeError(f'Circular reference in FAT chain (cluster {cluster_id_} revisited)')
            visited.add(cluster_id_)
            data_address_ = Cluster.compute_cluster_data_address(self.boot_sector_state, cluster_id_)
            content_ += binary_image[data_address_: data_address_ + cluster_size]
        # the size is None if the object is directory
        if size is None:
            return content_
        return content_[:size]

    def find_free_cluster(self):
        # type: () -> Cluster
        for i in range(self._first_free_cluster_id + 1, len(self.clusters)):
            if self.clusters[i].is_empty:
                self._first_free_cluster_id = i
                self.clusters[i].allocate_cluster()
                return self.clusters[i]
        raise NoFreeClusterException('No free cluster available!')

    def allocate_chain(self, first_cluster, size):
        # type: (Cluster, int) -> None
        current = first_cluster
        for _ in range(size - 1):
            free_cluster = self.find_free_cluster()
            current.next_cluster = free_cluster
            current.set_in_fat(free_cluster.id)
            current = free_cluster
