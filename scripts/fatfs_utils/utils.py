# SPDX-FileCopyrightText: 2021-2026 Espressif Systems (Shanghai) CO LTD
# SPDX-License-Identifier: Apache-2.0
import argparse
import binascii
import os
import sys
import re
import struct
import uuid
from datetime import datetime
from typing import List, Optional, Tuple

# the regex pattern defines symbols that are allowed by long file names but not by short file names
INVALID_SFN_CHARS_PATTERN = re.compile(r'[.+,;=\[\]]')

FATFS_MIN_ALLOC_UNIT: int = 4
FAT12_MAX_CLUSTERS: int = 4085
FAT16_MAX_CLUSTERS: int = 65525
RESERVED_CLUSTERS_COUNT: int = 2
PAD_CHAR: int = 0x20
FAT12: int = 12
FAT16: int = 16
FAT32: int = 32
FULL_BYTE: bytes = b'\xff'
EMPTY_BYTE: bytes = b'\x00'
# redundant
BYTES_PER_DIRECTORY_ENTRY: int = 32
UINT32_MAX: int = (1 << 32) - 1
MAX_NAME_SIZE: int = 8
MAX_EXT_SIZE: int = 3
DATETIME = Tuple[int, int, int]
FATFS_INCEPTION_YEAR: int = 1980

FATFS_INCEPTION: datetime = datetime(FATFS_INCEPTION_YEAR, 1, 1, 0, 0, 0, 0)

FATFS_MAX_HOURS = 24
FATFS_MAX_MINUTES = 60
FATFS_MAX_SECONDS = 60

FATFS_MAX_DAYS = 31
FATFS_MAX_MONTHS = 12
FATFS_MAX_YEARS = 127

FATFS_SECONDS_GRANULARITY: int = 2

# long names are encoded to two bytes in utf-16
LONG_NAMES_ENCODING: str = 'utf-16-le'
SHORT_NAMES_ENCODING: str = 'utf-8'

# compatible with WL_SECTOR_SIZE
# choices for WL are WL_SECTOR_SIZE_512 and WL_SECTOR_SIZE_4096
ALLOWED_WL_SECTOR_SIZES: List[int] = [512, 4096]
ALLOWED_SECTOR_SIZES: List[int] = [512, 1024, 2048, 4096]

ALLOWED_SECTORS_PER_CLUSTER: List[int] = [1, 2, 4, 8, 16, 32, 64, 128]


def crc32(input_values, crc):
    # type: (List[int], int) -> int
    """
    Name    Polynomial  Reversed?   Init-value                  XOR-out
    crc32   0x104C11DB7 True        4294967295 (UINT32_MAX)     0xFFFFFFFF
    """
    return binascii.crc32(bytearray(input_values), crc)


def number_of_clusters(number_of_sectors, sectors_per_cluster):
    # type: (int, int) -> int
    return number_of_sectors // sectors_per_cluster


def get_non_data_sectors_cnt(
    reserved_sectors_cnt, sectors_per_fat_cnt, fat_tables_cnt, root_dir_sectors_cnt
):
    # type: (int, int, int, int) -> int
    return reserved_sectors_cnt + sectors_per_fat_cnt * fat_tables_cnt + root_dir_sectors_cnt


def get_fatfs_type(clusters_count):
    # type: (int) -> int
    if clusters_count < FAT12_MAX_CLUSTERS:
        return FAT12
    if clusters_count <= FAT16_MAX_CLUSTERS:
        return FAT16
    return FAT32


def get_fat_sectors_count(clusters_count, sector_size):
    # type: (int, int) -> int
    fatfs_type_ = get_fatfs_type(clusters_count)
    if fatfs_type_ == FAT32:
        raise NotImplementedError('FAT32 is not supported!')
    # number of byte halves
    cluster_s = fatfs_type_ // 4
    fat_size_bytes = (
        (clusters_count * 2 + cluster_s) if fatfs_type_ == FAT16 else (clusters_count * 3 + 1) // 2 + cluster_s
    )
    return (fat_size_bytes + sector_size - 1) // sector_size


def required_clusters_count(cluster_size, content):
    # type: (int, bytes) -> int
    # compute number of required clusters for file text
    return (len(content) + cluster_size - 1) // cluster_size


def generate_4bytes_random():
    # type: () -> int
    return uuid.uuid4().int & 0xFFFFFFFF


def pad_string(content, size=None, pad=PAD_CHAR):
    # type: (str, Optional[int], int) -> str
    # cut string if longer and fill with pad character if shorter than size
    return content.ljust(size or len(content), chr(pad))[:size]


def right_strip_string(content, pad=PAD_CHAR):
    # type: (str, int) -> str
    return content.rstrip(chr(pad))


def _gen_numname_suffix(seq, lfn):
    # type: (int, str) -> str
    """
    Generate the numeric tail suffix for a short filename entry, matching
    the logic of gen_numname() in ff.c.

    For seq > 5, a CRC-based hash is computed from seq and the LFN to reduce
    collision probability. The suffix is rendered as hexadecimal digits
    (e.g. '~1', '~A', '~3F2') and always starts with '~'.
    """
    if seq > 5:
        # Hash path: CRC16-CCITT seeded with seq, fed with LFN characters
        sreg = seq
        for ch in lfn:
            wc = ord(ch)
            for _ in range(16):
                sreg = (sreg << 1) + (wc & 1)
                wc >>= 1
                if sreg & 0x10000:
                    sreg ^= 0x11021
        seq = sreg & 0xFFFF

    # Convert seq to uppercase hexadecimal digits (no '0x' prefix)
    hex_str = format(seq, 'X')
    return '~' + hex_str


def build_lfn_short_entry_name(name, extension, order, lfn=''):
    # type: (str, str, int, str) -> str
    """
    Build the 8.3 short entry name for a long filename entry.

    Mirrors gen_numname() from ff.c: the suffix ('~' + hex digits) is built
    first, then the stem (beginning of the long name) is truncated to fit
    within MAX_NAME_SIZE (8) characters together with the suffix.
    """
    suffix = _gen_numname_suffix(order, lfn)
    name_part = name[: MAX_NAME_SIZE - len(suffix)] + suffix
    padded_name = pad_string(content=name_part, size=MAX_NAME_SIZE)
    padded_ext = pad_string(extension[:MAX_EXT_SIZE], size=MAX_EXT_SIZE)
    return '%s%s' % (padded_name, padded_ext)


def lfn_checksum(short_entry_name):
    # type: (str) -> int
    """
    Function defined by FAT specification. Computes checksum out of name in the short file name entry.
    """
    checksum_result = 0
    for i in range(MAX_NAME_SIZE + MAX_EXT_SIZE):
        # operation is a right rotation on 8 bits (Python equivalent for unsigned char in C)
        checksum_result = (0x80 if checksum_result & 1 else 0x00) + (checksum_result >> 1) + ord(short_entry_name[i])
        checksum_result &= 0xFF
    return checksum_result


def convert_to_utf16_and_pad(content, expected_size, pad=FULL_BYTE):
    # type: (str, int, bytes) -> bytes
    # FAT requires little-endian UTF-16 without BOM
    encoded_content_utf16 = content.encode('utf-16-le')
    return encoded_content_utf16.ljust(2 * expected_size, pad)


def split_to_name_and_extension(full_name):
    # type: (str) -> Tuple[str, str]
    name, extension = os.path.splitext(full_name)
    return name, extension.replace('.', '')


def is_valid_fatfs_name(string):
    # type: (str) -> bool
    return string == string.upper()


def split_by_half_byte_12_bit_little_endian(value):
    # type: (int) -> Tuple[int, int, int]
    value_as_bytes = struct.pack('<H', value)
    return value_as_bytes[0] & 0x0F, value_as_bytes[0] >> 4, value_as_bytes[1] & 0x0F


def merge_by_half_byte_12_bit_little_endian(v1, v2, v3):
    # type: (int, int, int) -> int
    return v1 | v2 << 4 | v3 << 8


def build_byte(first_half, second_half):
    # type: (int, int) -> int
    return (first_half << 4) | second_half


def split_content_into_sectors(content, sector_size):
    # type: (bytes, int) -> List[bytes]
    result = []
    chunks_cnt = required_clusters_count(cluster_size=sector_size, content=content)

    for i in range(chunks_cnt):
        result.append(content[sector_size * i: (i + 1) * sector_size])
    return result


def get_args_for_partition_generator(desc, wl):
    # type: (str, bool) -> argparse.Namespace
    parser = argparse.ArgumentParser(description=desc)
    parser.add_argument('input_directory', help='Path to the directory that will be encoded into fatfs image')
    parser.add_argument('--output_file', default='fatfs_image.img', help='Filename of the generated fatfs image')
    parser.add_argument(
        '--partition_size',
        default=str(FATDefaults.SIZE),
        help='Size of the partition in bytes.'
        + ('' if wl else ' Use `--partition_size detect` for detecting the minimal partition size.'),
    )
    parser.add_argument(
        '--sector_size',
        default=FATDefaults.SECTOR_SIZE,
        type=int,
        choices=ALLOWED_WL_SECTOR_SIZES if wl else ALLOWED_SECTOR_SIZES,
        help='Size of the partition in bytes',
    )
    parser.add_argument(
        '--sectors_per_cluster',
        default=1,
        type=int,
        choices=ALLOWED_SECTORS_PER_CLUSTER,
        help='Number of sectors per cluster',
    )
    parser.add_argument(
        '--root_entry_count', default=FATDefaults.ROOT_ENTRIES_COUNT, help='Number of entries in the root directory'
    )
    parser.add_argument('--long_name_support', action='store_true', default=True, help='Enable long names support (VFAT LFN). Enabled by default.')
    parser.add_argument('--no_long_name_support', action='store_false', dest='long_name_support', help='Disable long name support.')
    parser.add_argument(
        '--use_default_datetime',
        action='store_true',
        help='For test purposes. If the flag is set the files are created with '
        'the default timestamp that is the 1st of January 1980',
    )
    parser.add_argument(
        '--fat_type',
        default=0,
        type=int,
        choices=[FAT12, FAT16, 0],
        help="""
                        Type of the FAT file-system. Select '12' for FAT12, '16' for FAT16.
                        Leave unset or select 0 for automatic file-system type detection.
                        """,
    )
    parser.add_argument(
        '--fat_count',
        default=FATDefaults.FAT_TABLES_COUNT,
        type=int,
        choices=[1, 2],
        help='Number of file allocation tables (FATs) in the filesystem.',
    )
    parser.add_argument(
        '--wl_mode',
        default=None,
        type=str,
        choices=['safe', 'perf'],
        help='Wear levelling mode to use. Safe or performance.',
    )

    args = parser.parse_args()
    if args.fat_type == 0:
        args.fat_type = None
    if args.partition_size == 'detect':
        args.partition_size = -1
    if args.partition_size != -1:
        args.partition_size = int(str(args.partition_size), 0)
    if not os.path.isdir(args.input_directory):
        raise NotADirectoryError('The target directory `%s` does not exist!' % args.input_directory)
    if args.wl_mode is not None:
        if args.sector_size not in ALLOWED_WL_SECTOR_SIZES:
            raise ValueError(f'Wear levelling mode requires sector size to be one of {ALLOWED_WL_SECTOR_SIZES}, got {args.sector_size}')

    # ── Validate minimum partition size ──────────────────────────────────
    # Skip validation if auto-detect sentinel is set (-1)
    # For WL mode, skip validation entirely — wl_fatfsgen.py handles size
    # validation itself (calculates minimum and exits with code 2 if too small)
    if args.partition_size != -1 and not wl:
        root_dir_sectors = (int(args.root_entry_count) * BYTES_PER_DIRECTORY_ENTRY) // args.sector_size
        # Estimate sectors_per_fat to get accurate minimum
        est_data_sectors = max(1, (args.partition_size // args.sector_size) - FATDefaults.RESERVED_SECTORS_COUNT - args.fat_count - root_dir_sectors)
        est_clusters = est_data_sectors // args.sectors_per_cluster + RESERVED_CLUSTERS_COUNT
        est_sectors_per_fat = get_fat_sectors_count(est_clusters, args.sector_size)
        min_fat_sectors = FATDefaults.RESERVED_SECTORS_COUNT + est_sectors_per_fat * args.fat_count + root_dir_sectors + 1  # +1 data sector
        min_fatfs_size = min_fat_sectors * args.sector_size

        min_partition_size = min_fatfs_size

        if args.partition_size < min_partition_size:
            # Exit with code 2 (consistent with spiffsgen/littlefsgen) so that
            # the VS Code extension can show the "Retry with auto-size" dialog.
            print('[fatfsgen] Error: specified partition size %d bytes (0x%X) is too small for the data.'
                  % (args.partition_size, args.partition_size))
            print('[fatfsgen] Minimum required size: %d bytes (0x%X, %d KB) '
                  'for sector_size=%d, root_entry_count=%d'
                  % (min_partition_size, min_partition_size, min_partition_size // 1024,
                     args.sector_size, args.root_entry_count))
            sys.exit(2)

    return args


def read_filesystem(path):
    # type: (str) -> bytearray
    with open(path, 'rb') as fs_file:
        return bytearray(fs_file.read())


# ─── Replacements for construct BitStruct (DATE_ENTRY / TIME_ENTRY) ────────

def build_date_entry(year, mon, mday):
    # type: (int, int, int) -> int
    """
    :param year: denotes year starting from 1980 (0 ~ 1980, 1 ~ 1981, etc)
    :param mon: 1..12
    :param mday: 1..31
    :returns: 16 bit integer (7 bits year, 4 bits month, 5 bits day)
    """
    assert year in range(FATFS_INCEPTION_YEAR, FATFS_INCEPTION_YEAR + FATFS_MAX_YEARS)
    assert mon in range(1, FATFS_MAX_MONTHS + 1)
    assert mday in range(1, FATFS_MAX_DAYS + 1)
    y = year - FATFS_INCEPTION_YEAR
    # 7 bits year | 4 bits month | 5 bits day, big-endian bit packing
    value = ((y & 0x7F) << 9) | ((mon & 0x0F) << 5) | (mday & 0x1F)
    return value


def build_time_entry(hour, minute, sec):
    # type: (int, int, int) -> int
    """
    :param hour: 0..23
    :param minute: 0..59
    :param sec: 0..58 (granularity 2 sec, stored as sec//2, 5 bits → 0..29)
    :returns: 16 bit integer (5 bits hour, 6 bits minute, 5 bits second)
    """
    assert hour in range(FATFS_MAX_HOURS)
    assert minute in range(FATFS_MAX_MINUTES)
    assert sec in range(FATFS_MAX_SECONDS)
    value = ((hour & 0x1F) << 11) | ((minute & 0x3F) << 5) | ((sec // FATFS_SECONDS_GRANULARITY) & 0x1F)
    return value


def build_name(name, extension):
    # type: (str, str) -> str
    return '%s.%s' % (name, extension) if len(extension) > 0 else name


class FATDefaults:
    # FATFS defaults
    SIZE = 1024 * 1024
    RESERVED_SECTORS_COUNT = 1
    FAT_TABLES_COUNT = 2
    SECTORS_PER_CLUSTER = 1
    SECTOR_SIZE = 0x1000
    HIDDEN_SECTORS = 0
    ENTRY_SIZE = 32
    NUM_HEADS = 0xFF
    OEM_NAME = 'MSDOS5.0'
    SEC_PER_TRACK = 0x3F
    VOLUME_LABEL = 'Espressif'
    FILE_SYS_TYPE = 'FAT'
    ROOT_ENTRIES_COUNT = 512  # number of entries in the root directory, recommended 512
    MEDIA_TYPE = 0xF8
    SIGNATURE_WORD = b'\x55\xaa'

    # wear levelling defaults
    VERSION = 2
    TEMP_BUFFER_SIZE = 32
    UPDATE_RATE = 16
    WR_SIZE = 16
    # wear leveling metadata (config sector) contains always sector size 4096
    WL_SECTOR_SIZE = 4096
