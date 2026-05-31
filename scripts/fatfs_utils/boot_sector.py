# SPDX-FileCopyrightText: 2021-2024 Espressif Systems (Shanghai) CO LTD
# SPDX-License-Identifier: Apache-2.0
import struct
from inspect import getmembers
from inspect import isroutine
from typing import Dict, Optional

from .exceptions import InconsistentFATAttributes
from .exceptions import NotInitialized
from .fatfs_state import BootSectorState
from .utils import ALLOWED_SECTOR_SIZES
from .utils import ALLOWED_SECTORS_PER_CLUSTER
from .utils import EMPTY_BYTE
from .utils import FAT32
from .utils import FULL_BYTE
from .utils import SHORT_NAMES_ENCODING
from .utils import FATDefaults
from .utils import generate_4bytes_random
from .utils import pad_string


class BootSector:
    """
    This class describes the first sector of the volume in the Reserved Region.
    It contains data from BPB (BIOS Parameter Block) and BS (Boot sector). The fields of the BPB and BS are mixed in
    the header of the physical boot sector. Fields with prefix BPB belongs to BPB block and with prefix BS
    belongs to the actual boot sector.

    Please beware, that the name of class BootSector refer to data both from the boot sector and BPB.
    ESP32 ignores fields with prefix "BS_"! Fields with prefix BPB_ are essential to read the filesystem.
    """

    MAX_VOL_LAB_SIZE = 11
    MAX_OEM_NAME_SIZE = 8
    MAX_FS_TYPE_SIZE = 8

    # the FAT specification defines 512 bytes for the boot sector header
    BOOT_HEADER_SIZE = 512

    # Boot sector binary layout (all little-endian):
    #   BS_jmpBoot       3 bytes
    #   BS_OEMName       8 bytes (padded string)
    #   BPB_BytsPerSec   uint16
    #   BPB_SecPerClus   uint8
    #   BPB_RsvdSecCnt   uint16
    #   BPB_NumFATs      uint8
    #   BPB_RootEntCnt   uint16
    #   BPB_TotSec16     uint16
    #   BPB_Media        uint8
    #   BPB_FATSz16      uint16
    #   BPB_SecPerTrk    uint16
    #   BPB_NumHeads     uint16
    #   BPB_HiddSec      uint32
    #   BPB_TotSec32     uint32
    #   BS_DrvNum        1 byte (0x80)
    #   BS_Reserved1     1 byte (0x00)
    #   BS_BootSig       1 byte (0x29)
    #   BS_VolID         uint32
    #   BS_VolLab        11 bytes (padded string)
    #   BS_FilSysType    8 bytes (padded string)
    #   BS_EMPTY         448 bytes (zeros)
    #   Signature_word   2 bytes (0x55AA)
    BOOT_SECTOR_FORMAT = '<3s8sHBHBHHBHHHIIBBBI11s8s448s2s'
    # 3s=BS_jmpBoot, 8s=BS_OEMName, H=BPB_BytsPerSec, B=BPB_SecPerClus,
    # H=BPB_RsvdSecCnt, B=BPB_NumFATs, H=BPB_RootEntCnt, H=BPB_TotSec16,
    # B=BPB_Media, H=BPB_FATSz16, H=BPB_SecPerTrk, H=BPB_NumHeads,
    # I=BPB_HiddSec, I=BPB_TotSec32,
    # B=BS_DrvNum(0x80), B=BS_Reserved1(0x00), B=BS_BootSig(0x29),
    # I=BS_VolID, 11s=BS_VolLab, 8s=BS_FilSysType, 448s=BS_EMPTY, 2s=Signature_word
    BOOT_SECTOR_FIELD_NAMES = [
        'BS_jmpBoot', 'BS_OEMName', 'BPB_BytsPerSec', 'BPB_SecPerClus',
        'BPB_RsvdSecCnt', 'BPB_NumFATs', 'BPB_RootEntCnt', 'BPB_TotSec16',
        'BPB_Media', 'BPB_FATSz16', 'BPB_SecPerTrk', 'BPB_NumHeads',
        'BPB_HiddSec', 'BPB_TotSec32',
        'BS_DrvNum', 'BS_Reserved1', 'BS_BootSig',
        'BS_VolID', 'BS_VolLab', 'BS_FilSysType', 'BS_EMPTY', 'Signature_word',
    ]

    def __init__(self, boot_sector_state=None):
        # type: (Optional[BootSectorState]) -> None
        self._parsed_header = {}  # type: dict
        self.boot_sector_state = boot_sector_state

    @staticmethod
    def _build_boot_sector_header(data_dict):
        # type: (dict) -> bytes
        """Build the 512-byte boot sector header from a data dictionary using struct.pack."""
        jmp = data_dict.get('BS_jmpBoot', b'\xeb\xfe\x90')
        oem = pad_string(data_dict.get('BS_OEMName', ''), size=BootSector.MAX_OEM_NAME_SIZE).encode(SHORT_NAMES_ENCODING)
        byts_per_sec = data_dict['BPB_BytsPerSec']
        sec_per_clus = data_dict['BPB_SecPerClus']
        rsvd_sec_cnt = data_dict['BPB_RsvdSecCnt']
        num_fats = data_dict['BPB_NumFATs']
        root_ent_cnt = data_dict['BPB_RootEntCnt']
        tot_sec16 = data_dict['BPB_TotSec16']
        media = data_dict['BPB_Media']
        fat_sz16 = data_dict['BPB_FATSz16']
        sec_per_trk = data_dict['BPB_SecPerTrk']
        num_heads = data_dict['BPB_NumHeads']
        hidd_sec = data_dict['BPB_HiddSec']
        tot_sec32 = data_dict['BPB_TotSec32']
        vol_id = data_dict.get('BS_VolID', 0)
        vol_lab = pad_string(data_dict.get('BS_VolLab', ''), size=BootSector.MAX_VOL_LAB_SIZE).encode(SHORT_NAMES_ENCODING)
        fs_type = pad_string(data_dict.get('BS_FilSysType', ''), size=BootSector.MAX_FS_TYPE_SIZE).encode(SHORT_NAMES_ENCODING)
        empty = b'\x00' * 448
        sig = FATDefaults.SIGNATURE_WORD

        drv_num = 0x80
        reserved1 = 0x00
        boot_sig = 0x29

        header = struct.pack(
            BootSector.BOOT_SECTOR_FORMAT,
            jmp, oem, byts_per_sec, sec_per_clus,
            rsvd_sec_cnt, num_fats, root_ent_cnt, tot_sec16,
            media, fat_sz16, sec_per_trk, num_heads,
            hidd_sec, tot_sec32,
            drv_num, reserved1, boot_sig,
            vol_id, vol_lab, fs_type, empty, sig,
        )
        return header

    @staticmethod
    def _parse_boot_sector_header(binary_data):
        # type: (bytes) -> dict
        """Parse the 512-byte boot sector header into a dictionary using struct.unpack."""
        values = struct.unpack(BootSector.BOOT_SECTOR_FORMAT, binary_data[:BootSector.BOOT_HEADER_SIZE])
        result = {}
        for i, name in enumerate(BootSector.BOOT_SECTOR_FIELD_NAMES):
            val = values[i]
            # Decode padded strings
            if name in ('BS_OEMName', 'BS_VolLab', 'BS_FilSysType'):
                val = val.rstrip(b'\x00').rstrip(b' ').decode(SHORT_NAMES_ENCODING, errors='replace')
            elif name in ('BS_jmpBoot', 'BS_EMPTY', 'Signature_word'):
                pass  # keep as bytes
            elif name in ('BS_DrvNum', 'BS_Reserved1', 'BS_BootSig'):
                # validate known constants
                if name == 'BS_DrvNum' and val != 0x80:
                    pass  # don't raise, just note
                if name == 'BS_BootSig' and val != 0x29:
                    raise InconsistentFATAttributes('Invalid BS_BootSig: 0x%02x (expected 0x29)' % val)
            result[name] = val
        return result

    def generate_boot_sector(self):
        # type: () -> None
        boot_sector_state = self.boot_sector_state
        if boot_sector_state is None:
            raise NotInitialized('The BootSectorState instance is not initialized!')
        volume_uuid = generate_4bytes_random()
        pad_header = (boot_sector_state.sector_size - BootSector.BOOT_HEADER_SIZE) * EMPTY_BYTE
        fat_tables_content = (
            boot_sector_state.sectors_per_fat_cnt
            * boot_sector_state.fat_tables_cnt
            * boot_sector_state.sector_size
            * EMPTY_BYTE
        )
        root_dir_content = boot_sector_state.root_dir_sectors_cnt * boot_sector_state.sector_size * EMPTY_BYTE
        data_content = boot_sector_state.data_sectors * boot_sector_state.sector_size * FULL_BYTE

        header_data = {
            'BS_jmpBoot': b'\xeb\xfe\x90',
            'BS_OEMName': pad_string(boot_sector_state.oem_name, size=BootSector.MAX_OEM_NAME_SIZE),
            'BPB_BytsPerSec': boot_sector_state.sector_size,
            'BPB_SecPerClus': boot_sector_state.sectors_per_cluster,
            'BPB_RsvdSecCnt': boot_sector_state.reserved_sectors_cnt,
            'BPB_NumFATs': boot_sector_state.fat_tables_cnt,
            'BPB_RootEntCnt': boot_sector_state.entries_root_count,
            'BPB_TotSec16': 0x00 if boot_sector_state.fatfs_type == FAT32 else boot_sector_state.sectors_count,
            'BPB_Media': boot_sector_state.media_type,
            'BPB_FATSz16': boot_sector_state.sectors_per_fat_cnt,
            'BPB_SecPerTrk': boot_sector_state.sec_per_track,
            'BPB_NumHeads': boot_sector_state.num_heads,
            'BPB_HiddSec': boot_sector_state.hidden_sectors,
            'BPB_TotSec32': boot_sector_state.sectors_count if boot_sector_state.fatfs_type == FAT32 else 0x00,
            'BS_VolID': volume_uuid,
            'BS_VolLab': pad_string(boot_sector_state.volume_label, size=BootSector.MAX_VOL_LAB_SIZE),
            'BS_FilSysType': pad_string(boot_sector_state.file_sys_type, size=BootSector.MAX_FS_TYPE_SIZE),
        }

        self.boot_sector_state.binary_image = bytearray(
            BootSector._build_boot_sector_header(header_data)
            + pad_header
            + fat_tables_content
            + root_dir_content
            + data_content
        )

    def parse_boot_sector(self, binary_data):
        # type: (bytes) -> None
        """
        Checks the validity of the boot sector and derives the metadata from boot sector to the structured shape.
        """
        try:
            self._parsed_header = BootSector._parse_boot_sector_header(binary_data)
        except struct.error:
            raise NotInitialized('The boot sector header is not parsed successfully!')

        if self._parsed_header['BPB_TotSec16'] != 0x00:
            sectors_count_ = self._parsed_header['BPB_TotSec16']
        elif self._parsed_header['BPB_TotSec32'] != 0x00:
            assert self._parsed_header['BPB_TotSec16'] == 0
            raise NotImplementedError('FAT32 not implemented!')
        else:
            raise InconsistentFATAttributes('The number of FS sectors cannot be zero!')

        if self._parsed_header['BPB_BytsPerSec'] not in ALLOWED_SECTOR_SIZES:
            raise InconsistentFATAttributes(
                'The number of bytes '
                'per sector is %d! '
                'The accepted values are %s' % (self._parsed_header['BPB_BytsPerSec'], ALLOWED_SECTOR_SIZES)
            )
        if self._parsed_header['BPB_SecPerClus'] not in ALLOWED_SECTORS_PER_CLUSTER:
            raise InconsistentFATAttributes(
                'The number of sectors per cluster '
                'is %d '
                'The accepted values are %s' % (self._parsed_header['BPB_SecPerClus'], ALLOWED_SECTORS_PER_CLUSTER)
            )

        total_root_bytes = self._parsed_header['BPB_RootEntCnt'] * FATDefaults.ENTRY_SIZE
        root_dir_sectors_cnt_ = total_root_bytes // self._parsed_header['BPB_BytsPerSec']
        self.boot_sector_state = BootSectorState(
            oem_name=self._parsed_header['BS_OEMName'],
            sector_size=self._parsed_header['BPB_BytsPerSec'],
            sectors_per_cluster=self._parsed_header['BPB_SecPerClus'],
            reserved_sectors_cnt=self._parsed_header['BPB_RsvdSecCnt'],
            fat_tables_cnt=self._parsed_header['BPB_NumFATs'],
            root_dir_sectors_cnt=root_dir_sectors_cnt_,
            sectors_count=sectors_count_,
            media_type=self._parsed_header['BPB_Media'],
            sec_per_track=self._parsed_header['BPB_SecPerTrk'],
            num_heads=self._parsed_header['BPB_NumHeads'],
            hidden_sectors=self._parsed_header['BPB_HiddSec'],
            volume_label=self._parsed_header['BS_VolLab'],
            file_sys_type=self._parsed_header['BS_FilSysType'],
            volume_uuid=self._parsed_header['BS_VolID'],
        )
        self.boot_sector_state.binary_image = binary_data
        # file_sys_type may have been stripped of trailing spaces during parsing
        fst = self.boot_sector_state.file_sys_type.rstrip()
        assert fst in ('FAT%d' % self.boot_sector_state.fatfs_type, 'FAT')

    def __str__(self):
        # type: () -> str
        """
        FATFS properties parser (internal helper tool for fatfsgen.py/fatfsparse.py)
        Provides all the properties of given FATFS instance by parsing its boot sector (returns formatted string)
        """

        if self._parsed_header == {}:
            return 'Boot sector is not initialized!'
        res = 'FATFS properties:\n'
        for member in getmembers(self.boot_sector_state, lambda a: not (isroutine(a))):
            prop_ = getattr(self.boot_sector_state, member[0])
            if (isinstance(prop_, int) or isinstance(prop_, str)) and not member[0].startswith('_'):
                res += '%s: %s\n' % (member[0], prop_)
        return res

    @property
    def binary_image(self):
        # type: () -> bytes
        # when BootSector is not instantiated, self.boot_sector_state might be None
        if self.boot_sector_state is None or len(self.boot_sector_state.binary_image) == 0:
            raise NotInitialized('Boot sector is not initialized!')
        bin_image_ = self.boot_sector_state.binary_image
        return bin_image_
