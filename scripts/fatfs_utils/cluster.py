# SPDX-FileCopyrightText: 2021-2022 Espressif Systems (Shanghai) CO LTD
# SPDX-License-Identifier: Apache-2.0

import struct
from typing import Dict, Optional

from .fatfs_state import BootSectorState
from .utils import EMPTY_BYTE, FAT12, FAT16, build_byte, merge_by_half_byte_12_bit_little_endian, \
                    split_by_half_byte_12_bit_little_endian


def get_dir_size(is_root, boot_sector):
    # type: (bool, BootSectorState) -> int
    dir_size_ = boot_sector.root_dir_sectors_cnt * boot_sector.sector_size if is_root else boot_sector.sectors_per_cluster * boot_sector.sector_size
    return dir_size_


class Cluster:
    """
    class Cluster handles values in FAT table and allocates sectors in data region.
    """
    RESERVED_BLOCK_ID = 0
    ROOT_BLOCK_ID = 1
    ALLOCATED_BLOCK_FAT12 = 0xFFF
    ALLOCATED_BLOCK_FAT16 = 0xFFFF
    ALLOCATED_BLOCK_SWITCH = {FAT12: ALLOCATED_BLOCK_FAT12, FAT16: ALLOCATED_BLOCK_FAT16}
    INITIAL_BLOCK_SWITCH = {FAT12: 0xFF8, FAT16: 0xFFF8}  # type: Dict[int, int]

    def __init__(self,
                 cluster_id,
                 boot_sector_state,
                 init_):
        # type: (int, BootSectorState, bool) -> None
        """
        Initially, if init_ is False, the cluster is virtual and is not allocated (doesn't do changes in the FAT).
        :param cluster_id: the cluster ID
        :param boot_sector_state: auxiliary structure holding the file-system's metadata
        :param init_: True for allocation the cluster on instantiation, otherwise False.
        """
        self.id = cluster_id
        self.boot_sector_state = boot_sector_state

        self._next_cluster = None  # type: Optional[Cluster]
        # First cluster in FAT is reserved, low 8 bits contains BPB_Media and the rest is filled with 1
        if self.id == Cluster.RESERVED_BLOCK_ID:
            if init_:
                self.set_in_fat(self.INITIAL_BLOCK_SWITCH[self.boot_sector_state.fatfs_type])
            self.cluster_data_address = 0  # reserved cluster has no data
            return
        self.cluster_data_address = self._compute_cluster_data_address()
        assert self.cluster_data_address

    @property
    def next_cluster(self):
        # type: () -> Optional[Cluster]
        return self._next_cluster

    @next_cluster.setter
    def next_cluster(self, value):
        # type: (Optional[Cluster]) -> None
        self._next_cluster = value

    def _cluster_id_to_fat_position_in_bits(self, _id):
        # type: (int) -> int
        logical_position_ = self.boot_sector_state.fatfs_type * _id
        return logical_position_

    @staticmethod
    def compute_cluster_data_address(boot_sector_state, id_):
        # type: (BootSectorState, int) -> int
        data_address_ = boot_sector_state.root_directory_start
        if not id_ == Cluster.ROOT_BLOCK_ID:
            data_address_ = boot_sector_state.sector_size * (id_ - 2) + boot_sector_state.data_region_start
        return data_address_

    def _compute_cluster_data_address(self):
        # type: () -> int
        return self.compute_cluster_data_address(self.boot_sector_state, self.id)

    @property
    def fat_cluster_address(self):
        # type: () -> int
        """Determines how many bits precede the first bit of the cluster in FAT"""
        return self._cluster_id_to_fat_position_in_bits(self.id)

    @property
    def real_cluster_address(self):
        # type: () -> int
        cluster_address = self.boot_sector_state.fat_table_start_address + self.fat_cluster_address // 8
        return cluster_address

    def get_from_fat(self):
        # type: () -> int
        address_ = self.real_cluster_address
        bin_img_ = self.boot_sector_state.binary_image
        if self.boot_sector_state.fatfs_type == FAT12:
            # Bounds check for FAT12 (needs 2 consecutive bytes)
            if address_ + 1 >= len(bin_img_):
                raise IndexError(f'FAT12 read out of bounds at address {address_}')
            if self.fat_cluster_address % 8 == 0:
                # even block
                return bin_img_[self.real_cluster_address] | ((bin_img_[self.real_cluster_address + 1] & 0x0F) << 8)
            # odd block
            return ((bin_img_[self.real_cluster_address] & 0xF0) >> 4) | (bin_img_[self.real_cluster_address + 1] << 4)
        if self.boot_sector_state.fatfs_type == FAT16:
            return int.from_bytes(bin_img_[address_:address_ + 2], byteorder='little')
        raise NotImplementedError('Only valid fatfs types are FAT12 and FAT16.')

    @property
    def is_empty(self):
        # type: () -> bool
        return self.get_from_fat() == 0x00

    def set_in_fat(self, value):
        # type: (int) -> None
        def _set_msb_half_byte(address, value_):
            self.boot_sector_state.binary_image[address] &= 0x0f
            self.boot_sector_state.binary_image[address] |= value_ << 4

        def _set_lsb_half_byte(address, value_):
            self.boot_sector_state.binary_image[address] &= 0xf0
            self.boot_sector_state.binary_image[address] |= value_

        # value must fit into number of bits of the fat (12, 16 or 32)
        assert value <= (1 << self.boot_sector_state.fatfs_type) - 1
        half_bytes = split_by_half_byte_12_bit_little_endian(value)
        bin_img_ = self.boot_sector_state.binary_image

        if self.boot_sector_state.fatfs_type == FAT12:
            assert merge_by_half_byte_12_bit_little_endian(*half_bytes) == value
            if self.fat_cluster_address % 8 == 0:
                # even block
                bin_img_[self.real_cluster_address] = build_byte(half_bytes[1], half_bytes[0])
                _set_lsb_half_byte(self.real_cluster_address + 1, half_bytes[2])
            elif self.fat_cluster_address % 8 != 0:
                # odd block
                _set_msb_half_byte(self.real_cluster_address, half_bytes[0])
                bin_img_[self.real_cluster_address + 1] = build_byte(half_bytes[2], half_bytes[1])
        elif self.boot_sector_state.fatfs_type == FAT16:
            bin_img_[self.real_cluster_address:self.real_cluster_address + 2] = struct.pack('<H', value)
        assert self.get_from_fat() == value

    @property
    def is_root(self):
        # type: () -> bool
        return self.id == Cluster.ROOT_BLOCK_ID

    def allocate_cluster(self):
        # type: () -> None
        self.set_in_fat(self.ALLOCATED_BLOCK_SWITCH[self.boot_sector_state.fatfs_type])

        cluster_start = self.cluster_data_address
        dir_size = get_dir_size(self.is_root, self.boot_sector_state)
        cluster_end = cluster_start + dir_size
        self.boot_sector_state.binary_image[cluster_start:cluster_end] = dir_size * EMPTY_BYTE
