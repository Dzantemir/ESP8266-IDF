# SPDX-FileCopyrightText: 2021-2022 Espressif Systems (Shanghai) CO LTD
# SPDX-License-Identifier: Apache-2.0

import struct
from typing import List, Optional, Tuple, Union

from .exceptions import LowerCaseException, TooLongNameException
from .fatfs_state import FATFSState
from .utils import (DATETIME, EMPTY_BYTE, FATFS_INCEPTION, MAX_EXT_SIZE, MAX_NAME_SIZE, SHORT_NAMES_ENCODING,
                    FATDefaults, build_date_entry, build_time_entry, is_valid_fatfs_name, pad_string)


class Entry:
    """
    The class Entry represents entry of the directory.
    """
    ATTR_READ_ONLY = 0x01
    ATTR_HIDDEN = 0x02
    ATTR_SYSTEM = 0x04
    ATTR_VOLUME_ID = 0x08
    ATTR_DIRECTORY = 0x10  # directory
    ATTR_ARCHIVE = 0x20  # file
    ATTR_LONG_NAME = ATTR_READ_ONLY | ATTR_HIDDEN | ATTR_SYSTEM | ATTR_VOLUME_ID

    # indexes in the entry structure and sizes in bytes, not in characters (encoded using 2 bytes for lfn)
    LDIR_Name1_IDX = 1
    LDIR_Name1_SIZE = 5
    LDIR_Name2_IDX = 14
    LDIR_Name2_SIZE = 6
    LDIR_Name3_IDX = 28
    LDIR_Name3_SIZE = 2

    # short entry in long file names
    LDIR_DIR_NTRES = 0x18
    # one entry can hold 13 characters with size 2 bytes distributed in three regions of the 32 bytes entry
    CHARS_PER_ENTRY = LDIR_Name1_SIZE + LDIR_Name2_SIZE + LDIR_Name3_SIZE

    # the last 16 bytes record in the LFN entry has first byte masked with the following value
    LAST_RECORD_LFN_ENTRY = 0x40
    SHORT_ENTRY = -1
    # this value is used for short-like entry but with accepted lower case
    SHORT_ENTRY_LN = 0

    # The 1st January 1980 00:00:00
    DEFAULT_DATE = (FATFS_INCEPTION.year, FATFS_INCEPTION.month, FATFS_INCEPTION.day)
    DEFAULT_TIME = (FATFS_INCEPTION.hour, FATFS_INCEPTION.minute, FATFS_INCEPTION.second)

    # Short name entry binary layout (32 bytes, little-endian):
    #   DIR_Name         8 bytes (padded string)
    #   DIR_Name_ext     3 bytes (padded string)
    #   DIR_Attr         uint8
    #   DIR_NTRes        uint8
    #   DIR_CrtTimeTenth 1 byte (0x00)
    #   DIR_CrtTime      uint16
    #   DIR_CrtDate      uint16
    #   DIR_LstAccDate   uint16
    #   DIR_FstClusHI    2 bytes (0x0000)
    #   DIR_WrtTime      uint16
    #   DIR_WrtDate      uint16
    #   DIR_FstClusLO    uint16
    #   DIR_FileSize     uint32
    ENTRY_FORMAT_SHORT_NAME_FMT = '<8s3sBBxHHHH2xHHHI'
    ENTRY_FIELD_NAMES = [
        'DIR_Name', 'DIR_Name_ext', 'DIR_Attr', 'DIR_NTRes',
        'DIR_CrtTimeTenth', 'DIR_CrtTime', 'DIR_CrtDate',
        'DIR_LstAccDate', 'DIR_FstClusHI', 'DIR_WrtTime', 'DIR_WrtDate',
        'DIR_FstClusLO', 'DIR_FileSize',
    ]

    def __init__(self, entry_id, parent_dir_entries_address, fatfs_state):
        # type: (int, int, FATFSState) -> None
        self.fatfs_state = fatfs_state
        self.id = entry_id
        self.entry_address = parent_dir_entries_address + self.id * FATDefaults.ENTRY_SIZE
        self._is_alias = False
        self._is_empty = True

    @staticmethod
    def _compute_nt_res(entity_name, entity_extension):
        # type: (str, str) -> int
        """
        Compute DIR_NTRes byte for short name entries with long name support.
        Bit 4 (0x10): basename should be considered lowercase
        Bit 3 (0x08): extension should be considered lowercase
        Only set when the component is purely lowercase (FAT spec limitation).
        Mixed-case names should use the LFN path instead.
        """
        nt_res = 0x00
        if entity_name and entity_name == entity_name.lower() and entity_name != entity_name.upper():
            nt_res |= 0x10
        if entity_extension and entity_extension == entity_extension.lower() and entity_extension != entity_extension.upper():
            nt_res |= 0x08
        return nt_res

    @staticmethod
    def get_cluster_id(obj_):
        # type: (dict) -> int
        cluster_id_ = obj_['DIR_FstClusLO']
        return cluster_id_

    @property
    def is_empty(self):
        # type: () -> bool
        return self._is_empty

    @staticmethod
    def _build_entry(**kwargs):
        # type: (**int) -> bytes
        """Build a 32-byte short name entry using struct.pack."""
        name = pad_string(kwargs.get('DIR_Name', ''), size=MAX_NAME_SIZE).encode(SHORT_NAMES_ENCODING)
        ext = pad_string(kwargs.get('DIR_Name_ext', ''), size=MAX_EXT_SIZE).encode(SHORT_NAMES_ENCODING)
        attr = kwargs.get('DIR_Attr', 0)
        nt_res = kwargs.get('DIR_NTRes', 0)
        # DIR_CrtTimeTenth: 1 byte constant 0x00 (using x padding)
        crt_time = kwargs.get('DIR_CrtTime', 0)
        crt_date = kwargs.get('DIR_CrtDate', 0)
        lst_acc_date = kwargs.get('DIR_LstAccDate', 0)
        # DIR_FstClusHI: 2 bytes constant 0x0000 (using 2x padding)
        wrt_time = kwargs.get('DIR_WrtTime', 0)
        wrt_date = kwargs.get('DIR_WrtDate', 0)
        fst_clus_lo = kwargs.get('DIR_FstClusLO', 0)
        file_size = kwargs.get('DIR_FileSize', 0)

        # Format: <8s3sBBxHHHH2xHHI = 32 bytes, 10 values consumed
        # x = DIR_CrtTimeTenth (always 0), 2x = DIR_FstClusHI (always 0)
        entry = struct.pack(
            '<8s3sBBxHHHH2xHHI',
            name, ext, attr, nt_res,
            crt_time, crt_date, lst_acc_date,
            wrt_time, wrt_date,
            fst_clus_lo, file_size,
        )
        return entry

    @staticmethod
    def _parse_entry(entry_bytearray):
        # type: (Union[bytearray, bytes]) -> dict
        """Parse a 32-byte short name entry using struct.unpack."""
        values = struct.unpack('<8s3sBBxHHHH2xHHI', entry_bytearray[:32])
        result = {
            'DIR_Name': values[0].rstrip(b' ').decode(SHORT_NAMES_ENCODING, errors='replace'),
            'DIR_Name_ext': values[1].rstrip(b' ').decode(SHORT_NAMES_ENCODING, errors='replace'),
            'DIR_Attr': values[2],
            'DIR_NTRes': values[3],
            'DIR_CrtTimeTenth': 0,
            'DIR_CrtTime': values[4],
            'DIR_CrtDate': values[5],
            'DIR_LstAccDate': values[6],
            'DIR_FstClusHI': 0,
            'DIR_WrtTime': values[7],
            'DIR_WrtDate': values[8],
            'DIR_FstClusLO': values[9],
            'DIR_FileSize': values[10],
        }
        return result

    @staticmethod
    def _build_entry_long(names, checksum, order, is_last):
        # type: (List[bytes], int, int, bool) -> bytes
        """
        Build a 32-byte long filename entry.
        """
        order |= (Entry.LAST_RECORD_LFN_ENTRY if is_last else 0x00)
        long_entry = struct.pack(
            '<B10sBBB12sH4s',
            order,                           # order of the long name entry (possibly masked with 0x40)
            names[0],                        # first 5 characters (10 bytes) of the name part
            Entry.ATTR_LONG_NAME,            # one byte entity type ATTR_LONG_NAME
            0,                               # one byte of zeros
            checksum,                        # lfn_checksum
            names[1],                        # next 6 characters (12 bytes) of the name part
            0,                               # 2 bytes of zeros
            names[2],                        # last 2 characters (4 bytes) of the name part
        )
        return long_entry

    @staticmethod
    def parse_entry_long(entry_bytes_, my_check):
        # type: (bytes, int) -> dict
        order_ = struct.unpack('<B', entry_bytes_[0:1])[0]
        names0 = entry_bytes_[1:11]
        if struct.unpack('<B', entry_bytes_[12:13])[0] != 0:
            return {}
        if struct.unpack('<H', entry_bytes_[26:28])[0] != 0:
            return {}
        if struct.unpack('<B', entry_bytes_[11:12])[0] != 15:
            return {}
        if struct.unpack('<B', entry_bytes_[13:14])[0] != my_check:
            return {}
        names1 = entry_bytes_[14:26]
        names2 = entry_bytes_[28:32]
        return {
            'order': order_,
            'name1': names0,
            'name2': names1,
            'name3': names2,
            'is_last': bool((order_ & Entry.LAST_RECORD_LFN_ENTRY) == Entry.LAST_RECORD_LFN_ENTRY)
        }

    @property
    def entry_bytes(self):
        # type: () -> bytes
        """
        :returns: Bytes defining the entry belonging to the given instance.
        """
        start_ = self.entry_address
        entry_ = self.fatfs_state.binary_image[start_: start_ + FATDefaults.ENTRY_SIZE]
        return entry_

    @entry_bytes.setter
    def entry_bytes(self, value):
        # type: (bytes) -> None
        """
        The setter sets the content of the entry in bytes.
        """
        self.fatfs_state.binary_image[self.entry_address: self.entry_address + FATDefaults.ENTRY_SIZE] = value

    def _clean_entry(self):
        # type: () -> None
        self.entry_bytes = FATDefaults.ENTRY_SIZE * EMPTY_BYTE

    def allocate_entry(self,
                       first_cluster_id,
                       entity_name,
                       entity_type,
                       entity_extension='',
                       size=0,
                       date=DEFAULT_DATE,
                       time=DEFAULT_TIME,
                       lfn_order=SHORT_ENTRY,
                       lfn_names=None,
                       lfn_checksum_=0,
                       fits_short=False,
                       lfn_is_last=False):
        # type: (int, str, int, str, int, DATETIME, DATETIME, int, Optional[List[bytes]], int, bool, bool) -> None
        """
        :param first_cluster_id: id of the first data cluster for given entry
        :param entity_name: name recorded in the entry
        :param entity_extension: extension recorded in the entry
        :param size: size of the content of the file
        :param date: denotes year, month, day
        :param time: denotes hour, minute, second
        :param entity_type: type of the entity (file [0x20] or directory [0x10])
        :param lfn_order: if long names support is enabled, defines order in long names entries sequence
        :param lfn_names: if the entry is dedicated for long names
        :param lfn_checksum_: checksum for long file names
        :param fits_short: determines if the name fits in 8.3 filename
        :param lfn_is_last: determines if the long file name entry is last
        """
        valid_full_name = is_valid_fatfs_name(entity_name) and is_valid_fatfs_name(entity_extension)
        if not (valid_full_name or lfn_order >= 0 or self.fatfs_state.long_names_enabled):
            raise LowerCaseException('Lower case is not supported in short name entry, use upper case.')

        if self.fatfs_state.use_default_datetime:
            date = self.DEFAULT_DATE
            time = self.DEFAULT_TIME

        # clean entry before allocation
        self._clean_entry()
        self._is_empty = False

        # Short name entries MUST store uppercase in binary per FAT spec.
        # DIR_NTRes byte indicates which parts should be displayed as lowercase.
        # For LFN entries (lfn_order >= 1) object_name is not used in _build_entry_long.
        object_name = entity_name.upper()
        object_extension = entity_extension.upper()

        exceeds_short_name = len(object_name) > MAX_NAME_SIZE or len(object_extension) > MAX_EXT_SIZE
        if not self.fatfs_state.long_names_enabled and exceeds_short_name:
            raise TooLongNameException(
                'Maximal length of the object name is %d characters and %d characters for extension!' % (
                    MAX_NAME_SIZE, MAX_EXT_SIZE
                )
            )

        start_address = self.entry_address
        end_address = start_address + FATDefaults.ENTRY_SIZE
        if lfn_order in (self.SHORT_ENTRY, self.SHORT_ENTRY_LN):
            date_entry_ = build_date_entry(*date)
            time_entry = build_time_entry(*time)
            self.fatfs_state.binary_image[start_address: end_address] = self._build_entry(
                DIR_Name=object_name,
                DIR_Name_ext=object_extension,
                DIR_Attr=entity_type,
                DIR_NTRes=self._compute_nt_res(entity_name, entity_extension) if (self.fatfs_state.long_names_enabled and fits_short) else 0x00,
                DIR_FstClusLO=first_cluster_id,
                DIR_FileSize=size,
                DIR_CrtDate=date_entry_,
                DIR_LstAccDate=date_entry_,
                DIR_WrtDate=date_entry_,
                DIR_CrtTime=time_entry,
                DIR_WrtTime=time_entry,
            )
        else:
            assert lfn_names is not None
            self.fatfs_state.binary_image[start_address: end_address] = self._build_entry_long(lfn_names,
                                                                                               lfn_checksum_,
                                                                                               lfn_order,
                                                                                               lfn_is_last)

    def update_content_size(self, content_size):
        # type: (int) -> None
        """
        This method parses the binary entry, updates the content size of the file
        and builds new binary entry.
        """
        parsed_entry = self._parse_entry(self.entry_bytes)
        parsed_entry['DIR_FileSize'] = content_size
        self.entry_bytes = self._build_entry(**parsed_entry)
