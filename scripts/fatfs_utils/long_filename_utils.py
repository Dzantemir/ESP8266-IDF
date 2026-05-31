# SPDX-FileCopyrightText: 2022-2026 Espressif Systems (Shanghai) CO LTD
# SPDX-License-Identifier: Apache-2.0

from typing import List

from .entry import Entry
from .exceptions import NoFreeClusterException
from .utils import build_name
from .utils import convert_to_utf16_and_pad

#  File name with long filenames support can be as long as memory allows. It is split into entries
#  holding 13 characters of the filename, thus the number of required entries is ceil(len(long_name) / 13).
#  This is computed using `get_required_lfn_entries_count`.
#  For creating long name entries we need to split the name by 13 characters using `split_name_to_lfn_entries`
#  and in every entry into three blocks with sizes 5, 6 and 2 characters using `split_name_to_lfn_entry`.

MAXIMAL_FILES_SAME_PREFIX = 127


def get_required_lfn_entries_count(lfn_full_name):
    # type: (str) -> int
    """
    Compute the number of entries required to store the long name.
    One long filename entry can hold 13 characters with size 2 bytes.
    """
    entries_count = (len(lfn_full_name) + Entry.CHARS_PER_ENTRY - 1) // Entry.CHARS_PER_ENTRY
    return entries_count


def split_name_to_lfn_entries(name, entries):
    # type: (str, int) -> List[str]
    """
    If the filename is longer than 8 (name) + 3 (extension) characters,
    generator uses long name structure and splits the name into suitable amount of blocks.
    """
    return [name[i * Entry.CHARS_PER_ENTRY: (i + 1) * Entry.CHARS_PER_ENTRY] for i in range(entries)]


def split_name_to_lfn_entry_blocks(name):
    # type: (str) -> List[bytes]
    """
    Filename is divided into three blocks in every long file name entry. Sizes of the blocks are defined
    by LDIR_Name1_SIZE, LDIR_Name2_SIZE and LDIR_Name3_SIZE, thus every block contains LDIR_Name{X}_SIZE * 2 bytes.

    If the filename ends in one of the blocks, it is terminated by zero encoded to two bytes (0x0000). Other unused
    characters are set to 0xFFFF.
    """
    max_entry_size = Entry.LDIR_Name1_SIZE + Entry.LDIR_Name2_SIZE + Entry.LDIR_Name3_SIZE
    assert len(name) <= max_entry_size
    blocks_ = [
        convert_to_utf16_and_pad(content=name[: Entry.LDIR_Name1_SIZE], expected_size=Entry.LDIR_Name1_SIZE),
        convert_to_utf16_and_pad(
            content=name[Entry.LDIR_Name1_SIZE: Entry.LDIR_Name1_SIZE + Entry.LDIR_Name2_SIZE],
            expected_size=Entry.LDIR_Name2_SIZE,
        ),
        convert_to_utf16_and_pad(
            content=name[Entry.LDIR_Name1_SIZE + Entry.LDIR_Name2_SIZE:], expected_size=Entry.LDIR_Name3_SIZE
        ),
    ]
    return blocks_


def build_lfn_unique_entry_name_order(entities, lfn_entry_name):
    # type: (List, str) -> int
    """
    The short entry contains only the first characters of the file name plus a '~' suffix
    with hexadecimal sequence number, matching the gen_numname() algorithm in ff.c.
    """
    preceding_entries = 1
    for entity in entities:
        if entity.name[:6] == lfn_entry_name[:6]:
            preceding_entries += 1
    if preceding_entries > MAXIMAL_FILES_SAME_PREFIX:
        raise NoFreeClusterException('Maximal number of files with the same prefix is 127')
    return preceding_entries


def build_lfn_full_name(name, extension):
    # type: (str, str) -> str
    """
    The extension is optional, and the long filename entry explicitly specifies it,
    on the opposite as for short file names.
    """
    lfn_record = build_name(name, extension)
    # the name must be terminated with NULL terminator
    # if it doesn't fit into the set of long name directory entries
    if len(lfn_record) % Entry.CHARS_PER_ENTRY != 0:
        return lfn_record + chr(0)
    return lfn_record
