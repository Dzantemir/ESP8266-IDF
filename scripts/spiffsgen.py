#!/usr/bin/env python
#
# spiffsgen is a tool used to generate a spiffs image from a directory
#
# SPDX-FileCopyrightText: 2019-2024 Espressif Systems (Shanghai) CO LTD
# SPDX-License-Identifier: Apache-2.0
import argparse
import io
import math
import os
import struct
import sys

try:
    import typing

    TSP = typing.TypeVar('TSP', bound='SpiffsObjPageWithIdx')
    ObjIdsItem = typing.Tuple[int, typing.Type[TSP]]
except ImportError:
    pass


SPIFFS_PH_FLAG_USED_FINAL_INDEX = 0xF8
SPIFFS_PH_FLAG_USED_FINAL = 0xFC

SPIFFS_PH_FLAG_LEN = 1
SPIFFS_PH_IX_SIZE_LEN = 4
SPIFFS_PH_IX_OBJ_TYPE_LEN = 1
SPIFFS_TYPE_FILE = 1

# Based on typedefs under spiffs_config.h
SPIFFS_OBJ_ID_LEN = 2  # spiffs_obj_id
SPIFFS_SPAN_IX_LEN = 2  # spiffs_span_ix
SPIFFS_PAGE_IX_LEN = 2  # spiffs_page_ix
SPIFFS_BLOCK_IX_LEN = 2  # spiffs_block_ix


class SpiffsBuildConfig(object):
    def __init__(self,
                 page_size,  # type: int
                 page_ix_len,  # type: int
                 block_size,  # type: int
                 block_ix_len,  # type: int
                 meta_len,  # type: int
                 obj_name_len,  # type: int
                 obj_id_len,  # type: int
                 span_ix_len,  # type: int
                 packed,  # type: bool
                 aligned,  # type: bool
                 endianness,  # type: str
                 use_magic,  # type: bool
                 use_magic_len,  # type: bool
                 aligned_obj_ix_tables  # type: bool
                 ):
        if block_size % page_size != 0:
            raise RuntimeError('block size should be a multiple of page size')

        self.page_size = page_size
        self.block_size = block_size
        self.obj_id_len = obj_id_len
        self.span_ix_len = span_ix_len
        self.packed = packed
        self.aligned = aligned
        self.obj_name_len = obj_name_len
        self.meta_len = meta_len
        self.page_ix_len = page_ix_len
        self.block_ix_len = block_ix_len
        self.endianness = endianness
        self.use_magic = use_magic
        self.use_magic_len = use_magic_len
        self.aligned_obj_ix_tables = aligned_obj_ix_tables

        self.PAGES_PER_BLOCK = self.block_size // self.page_size
        self.OBJ_LU_PAGES_PER_BLOCK = int(math.ceil(self.block_size / self.page_size * self.obj_id_len / self.page_size))
        self.OBJ_USABLE_PAGES_PER_BLOCK = self.PAGES_PER_BLOCK - self.OBJ_LU_PAGES_PER_BLOCK
        if self.OBJ_USABLE_PAGES_PER_BLOCK <= 0:
            raise RuntimeError('block size too small: no usable pages per block')

        self.OBJ_LU_PAGES_OBJ_IDS_LIM = self.page_size // self.obj_id_len

        self.OBJ_DATA_PAGE_HEADER_LEN = self.obj_id_len + self.span_ix_len + SPIFFS_PH_FLAG_LEN

        pad = 4 - (4 if self.OBJ_DATA_PAGE_HEADER_LEN % 4 == 0 else self.OBJ_DATA_PAGE_HEADER_LEN % 4)

        self.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED = self.OBJ_DATA_PAGE_HEADER_LEN + pad
        self.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED_PAD = pad
        self.OBJ_DATA_PAGE_CONTENT_LEN = self.page_size - self.OBJ_DATA_PAGE_HEADER_LEN

        self.OBJ_INDEX_PAGES_HEADER_LEN = (self.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED + SPIFFS_PH_IX_SIZE_LEN +
                                           SPIFFS_PH_IX_OBJ_TYPE_LEN + self.obj_name_len + self.meta_len)
        if aligned_obj_ix_tables:
            self.OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED = (self.OBJ_INDEX_PAGES_HEADER_LEN + SPIFFS_PAGE_IX_LEN - 1) & ~(SPIFFS_PAGE_IX_LEN - 1)
            self.OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED_PAD = self.OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED - self.OBJ_INDEX_PAGES_HEADER_LEN
        else:
            self.OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED = self.OBJ_INDEX_PAGES_HEADER_LEN
            self.OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED_PAD = 0

        self.OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM = (self.page_size - self.OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED) // self.block_ix_len
        self.OBJ_INDEX_PAGES_OBJ_IDS_LIM = (self.page_size - self.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED) // self.block_ix_len


class SpiffsFullError(RuntimeError):
    pass


class SpiffsPage(object):
    _endianness_dict = {
        'little': '<',
        'big': '>'
    }

    _len_dict = {
        1: 'B',
        2: 'H',
        4: 'I',
        8: 'Q'
    }

    def __init__(self, bix, build_config):  # type: (int, SpiffsBuildConfig) -> None
        self.build_config = build_config
        self.bix = bix

    def to_binary(self):  # type: () -> bytes
        raise NotImplementedError()


class SpiffsObjPageWithIdx(SpiffsPage):
    def __init__(self, obj_id, build_config):  # type: (int, SpiffsBuildConfig) -> None
        super(SpiffsObjPageWithIdx, self).__init__(0, build_config)
        self.obj_id = obj_id

    def to_binary(self):  # type: () -> bytes
        raise NotImplementedError()


class SpiffsObjLuPage(SpiffsPage):
    def __init__(self, bix, build_config):  # type: (int, SpiffsBuildConfig) -> None
        SpiffsPage.__init__(self, bix, build_config)

        self.obj_ids_limit = self.build_config.OBJ_LU_PAGES_OBJ_IDS_LIM
        self.obj_ids = list()  # type: typing.List[ObjIdsItem]

    def _calc_magic(self, blocks_lim):  # type: (int) -> int
        # Calculate the magic value mirroring computation done by the macro SPIFFS_MAGIC defined in
        # spiffs_nucleus.h
        magic = 0x20140529 ^ self.build_config.page_size
        if self.build_config.use_magic_len:
            magic = magic ^ (blocks_lim - self.bix)
        # narrow the result to build_config.obj_id_len bytes
        mask = (1 << (8 * self.build_config.obj_id_len)) - 1
        return magic & mask

    def register_page(self, page):  # type: (TSP) -> None
        if not self.obj_ids_limit > 0:
            raise SpiffsFullError()

        obj_id = (page.obj_id, page.__class__)
        self.obj_ids.append(obj_id)
        self.obj_ids_limit -= 1

    def to_binary(self):  # type: () -> bytes
        img = b''

        for (obj_id, page_type) in self.obj_ids:
            if page_type == SpiffsObjIndexPage:
                obj_id ^= (1 << ((self.build_config.obj_id_len * 8) - 1))
            img += struct.pack(SpiffsPage._endianness_dict[self.build_config.endianness] +
                               SpiffsPage._len_dict[self.build_config.obj_id_len], obj_id)

        assert len(img) <= self.build_config.page_size

        img += b'\xFF' * (self.build_config.page_size - len(img))

        return img

    def magicfy(self, blocks_lim):  # type: (int) -> None
        # Only use magic value if no valid obj id has been written to the spot, which is the
        # spot taken up by the last obj id on last lookup page. The parent is responsible
        # for determining which is the last lookup page and calling this function.
        remaining = self.obj_ids_limit
        empty_obj_id_dict = {
            1: 0xFF,
            2: 0xFFFF,
            4: 0xFFFFFFFF,
            8: 0xFFFFFFFFFFFFFFFF
        }
        if remaining >= 2:
            for i in range(remaining):
                if i == remaining - 2:
                    self.obj_ids.append((self._calc_magic(blocks_lim), SpiffsObjDataPage))
                    self.obj_ids_limit -= 1
                    break
                else:
                    self.obj_ids.append((empty_obj_id_dict[self.build_config.obj_id_len], SpiffsObjDataPage))
                    self.obj_ids_limit -= 1
            # Fill the very last slot with an empty entry
            self.obj_ids.append((empty_obj_id_dict[self.build_config.obj_id_len], SpiffsObjDataPage))
            self.obj_ids_limit -= 1


class SpiffsObjIndexPage(SpiffsObjPageWithIdx):
    def __init__(self, obj_id, span_ix, size, name, build_config
                 ):  # type: (int, int, int, str, SpiffsBuildConfig) -> None
        super(SpiffsObjIndexPage, self).__init__(obj_id, build_config)
        self.span_ix = span_ix
        self.name = name
        self.size = size

        if self.span_ix == 0:
            self.pages_lim = self.build_config.OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM
        else:
            self.pages_lim = self.build_config.OBJ_INDEX_PAGES_OBJ_IDS_LIM

        self.pages = list()  # type: typing.List[int]

    def register_page(self, page):  # type: (SpiffsObjDataPage) -> None
        if not self.pages_lim > 0:
            raise SpiffsFullError()

        self.pages.append(page.offset)
        self.pages_lim -= 1

    def to_binary(self):  # type: () -> bytes
        obj_id = self.obj_id ^ (1 << ((self.build_config.obj_id_len * 8) - 1))
        img = struct.pack(SpiffsPage._endianness_dict[self.build_config.endianness] +
                          SpiffsPage._len_dict[self.build_config.obj_id_len] +
                          SpiffsPage._len_dict[self.build_config.span_ix_len] +
                          SpiffsPage._len_dict[SPIFFS_PH_FLAG_LEN],
                          obj_id,
                          self.span_ix,
                          SPIFFS_PH_FLAG_USED_FINAL_INDEX)

        # Add padding before the object index page specific information
        img += b'\xFF' * self.build_config.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED_PAD

        # If this is the first object index page for the object, add filename, type
        # and size information
        if self.span_ix == 0:
            img += struct.pack(SpiffsPage._endianness_dict[self.build_config.endianness] +
                               SpiffsPage._len_dict[SPIFFS_PH_IX_SIZE_LEN]  +
                               SpiffsPage._len_dict[SPIFFS_PH_FLAG_LEN],
                               self.size,
                               SPIFFS_TYPE_FILE)

            img += self.name.encode() + (b'\x00' * (
                (self.build_config.obj_name_len - len(self.name.encode()))
                + self.build_config.meta_len
                + self.build_config.OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED_PAD))

        # Finally, add the page index of data pages
        for page in self.pages:
            page = page >> (self.build_config.page_size.bit_length() - 1)
            img += struct.pack(SpiffsPage._endianness_dict[self.build_config.endianness] +
                               SpiffsPage._len_dict[self.build_config.page_ix_len], page)

        assert len(img) <= self.build_config.page_size

        img += b'\xFF' * (self.build_config.page_size - len(img))

        return img


class SpiffsObjDataPage(SpiffsObjPageWithIdx):
    def __init__(self, offset, obj_id, span_ix, contents, build_config
                 ):  # type: (int, int, int, bytes, SpiffsBuildConfig) -> None
        super(SpiffsObjDataPage, self).__init__(obj_id, build_config)
        self.span_ix = span_ix
        self.contents = contents
        self.offset = offset

    def to_binary(self):  # type: () -> bytes
        img = struct.pack(SpiffsPage._endianness_dict[self.build_config.endianness] +
                          SpiffsPage._len_dict[self.build_config.obj_id_len] +
                          SpiffsPage._len_dict[self.build_config.span_ix_len] +
                          SpiffsPage._len_dict[SPIFFS_PH_FLAG_LEN],
                          self.obj_id,
                          self.span_ix,
                          SPIFFS_PH_FLAG_USED_FINAL)

        img += self.contents

        assert len(img) <= self.build_config.page_size

        img += b'\xFF' * (self.build_config.page_size - len(img))

        return img


class SpiffsBlock(object):
    def _reset(self):  # type: () -> None
        self.cur_obj_index_span_ix = 0
        self.cur_obj_data_span_ix = 0
        self.cur_obj_id = 0
        self.cur_obj_idx_page = None  # type: typing.Optional[SpiffsObjIndexPage]

    def __init__(self, bix, build_config):  # type: (int, SpiffsBuildConfig) -> None
        self.build_config = build_config
        self.offset = bix * self.build_config.block_size
        self.remaining_pages = self.build_config.OBJ_USABLE_PAGES_PER_BLOCK
        self.pages = list()  # type: typing.List[SpiffsPage]
        self.bix = bix

        lu_pages = list()
        for i in range(self.build_config.OBJ_LU_PAGES_PER_BLOCK):
            page = SpiffsObjLuPage(self.bix, self.build_config)
            lu_pages.append(page)

        self.pages.extend(lu_pages)

        self.lu_page_iter = iter(lu_pages)
        self.lu_page = next(self.lu_page_iter)

        self._reset()

    def _register_page(self, page):  # type: (TSP) -> None
        if isinstance(page, SpiffsObjDataPage):
            assert self.cur_obj_idx_page is not None
            self.cur_obj_idx_page.register_page(page)  # can raise SpiffsFullError

        try:
            self.lu_page.register_page(page)
        except SpiffsFullError:
            try:
                self.lu_page = next(self.lu_page_iter)
            except StopIteration:
                # Since the amount of lookup pages is pre-computed at every block instance,
                # this should never occur
                raise RuntimeError('invalid attempt to add page to a block when there is no more space in lookup')
            self.lu_page.register_page(page)

        self.pages.append(page)

    def begin_obj(self, obj_id, size, name, obj_index_span_ix=0, obj_data_span_ix=0
                  ):  # type: (int, int, str, int, int) -> None
        if not self.remaining_pages > 0:
            raise SpiffsFullError()
        self._reset()

        self.cur_obj_id = obj_id
        self.cur_obj_index_span_ix = obj_index_span_ix
        self.cur_obj_data_span_ix = obj_data_span_ix

        page = SpiffsObjIndexPage(obj_id, self.cur_obj_index_span_ix, size, name, self.build_config)
        self._register_page(page)

        self.cur_obj_idx_page = page

        self.remaining_pages -= 1
        self.cur_obj_index_span_ix += 1

    def update_obj(self, contents):  # type: (bytes) -> None
        if not self.remaining_pages > 0:
            raise SpiffsFullError()
        page = SpiffsObjDataPage(self.offset + (len(self.pages) * self.build_config.page_size),
                                 self.cur_obj_id, self.cur_obj_data_span_ix, contents, self.build_config)

        self._register_page(page)

        self.cur_obj_data_span_ix += 1
        self.remaining_pages -= 1

    def end_obj(self):  # type: () -> None
        self._reset()

    def is_full(self):  # type: () -> bool
        return self.remaining_pages <= 0

    def to_binary(self, blocks_lim):  # type: (int) -> bytes
        img = b''

        if self.build_config.use_magic:
            for (idx, page) in enumerate(self.pages):
                if idx == self.build_config.OBJ_LU_PAGES_PER_BLOCK - 1:
                    assert isinstance(page, SpiffsObjLuPage)
                    page.magicfy(blocks_lim)
                img += page.to_binary()
        else:
            for page in self.pages:
                img += page.to_binary()

        assert len(img) <= self.build_config.block_size

        img += b'\xFF' * (self.build_config.block_size - len(img))
        return img


class SpiffsFS(object):
    def __init__(self, img_size, build_config):  # type: (int, SpiffsBuildConfig) -> None
        if img_size % build_config.block_size != 0:
            raise RuntimeError('image size should be a multiple of block size')

        self.img_size = img_size
        self.build_config = build_config

        self.blocks = list()  # type: typing.List[SpiffsBlock]
        self.blocks_lim = self.img_size // self.build_config.block_size
        self.remaining_blocks = self.blocks_lim
        self.cur_obj_id = 1  # starting object id

    def _create_block(self):  # type: () -> SpiffsBlock
        if self.is_full():
            raise SpiffsFullError('the image size has been exceeded')

        block = SpiffsBlock(len(self.blocks), self.build_config)
        self.blocks.append(block)
        self.remaining_blocks -= 1
        return block

    def is_full(self):  # type: () -> bool
        return self.remaining_blocks <= 0

    def create_file(self, img_path, file_path):  # type: (str, str) -> None
        if len(img_path.encode()) >= self.build_config.obj_name_len:
            raise RuntimeError("object name '%s' too long" % img_path)

        name = img_path

        with open(file_path, 'rb') as obj:
            contents = obj.read()

        stream = io.BytesIO(contents)

        try:
            block = self.blocks[-1]
            block.begin_obj(self.cur_obj_id, len(contents), name)
        except (IndexError, SpiffsFullError):
            block = self._create_block()
            block.begin_obj(self.cur_obj_id, len(contents), name)

        contents_chunk = stream.read(self.build_config.OBJ_DATA_PAGE_CONTENT_LEN)

        while contents_chunk:
            try:
                block = self.blocks[-1]
                try:
                    # This can fail because either (1) all the pages in block have been
                    # used or (2) object index has been exhausted.
                    block.update_obj(contents_chunk)
                except SpiffsFullError:
                    # If its (1), use the outer exception handler
                    if block.is_full():
                        raise SpiffsFullError
                    # If its (2), write another object index page
                    block.begin_obj(self.cur_obj_id, len(contents), name,
                                    obj_index_span_ix=block.cur_obj_index_span_ix,
                                    obj_data_span_ix=block.cur_obj_data_span_ix)
                    continue
            except (IndexError, SpiffsFullError):
                # All pages in the block have been exhausted. Create a new block, copying
                # the previous state of the block to a new one for the continuation of the
                # current object
                prev_block = block
                block = self._create_block()
                block.cur_obj_id = prev_block.cur_obj_id
                block.cur_obj_idx_page = prev_block.cur_obj_idx_page
                block.cur_obj_data_span_ix = prev_block.cur_obj_data_span_ix
                block.cur_obj_index_span_ix = prev_block.cur_obj_index_span_ix
                continue

            contents_chunk = stream.read(self.build_config.OBJ_DATA_PAGE_CONTENT_LEN)

        block.end_obj()

        self.cur_obj_id += 1

    def to_binary(self):  # type: () -> bytes
        img = b''
        all_blocks = []
        for block in self.blocks:
            all_blocks.append(block.to_binary(self.blocks_lim))
        bix = len(self.blocks)
        if self.build_config.use_magic:
            # Create empty blocks with magic numbers
            while self.remaining_blocks > 0:
                block = SpiffsBlock(bix, self.build_config)
                all_blocks.append(block.to_binary(self.blocks_lim))
                self.remaining_blocks -= 1
                bix += 1
        else:
            # Just fill remaining spaces FF's
            all_blocks.append(b'\xFF' * (self.img_size - len(all_blocks) * self.build_config.block_size))
        img += b''.join([blk for blk in all_blocks])
        return img



def _collect_files(base_dir, follow_symlinks=False):
    """Return sorted list of (img_path, full_path) for all files in base_dir."""
    result = []
    for root, _dirs, files in os.walk(base_dir, followlinks=follow_symlinks):
        for f in sorted(files):
            full_path = os.path.join(root, f)
            img_path = '/' + os.path.relpath(full_path, base_dir).replace('\\', '/')
            result.append((img_path, full_path))
    return result


def _print_progress(done, total, img_path):
    pct = int(done * 100 / total) if total else 100
    bar_len = 30
    filled = bar_len * done // total if total else bar_len
    bar = '#' * filled + '-' * (bar_len - filled)
    sys.stderr.write('[%s] %3d%% (%d/%d)  %s\n' % (bar, pct, done, total, img_path))
    sys.stderr.flush()


def _calc_min_image_size(base_dir, build_config, follow_symlinks=False):
    """
    Calculate the minimum SPIFFS image size (multiple of block_size) that can
    fit all files in base_dir.

    Uses a two-phase approach:
      1. Quick page-count estimate to avoid starting from 1 block.
      2. Try-and-grow loop for an exact result (guaranteed correct).
    """
    block_size = build_config.block_size

    # --- Phase 1: pre-estimate ---
    total_pages = 0
    for root, _dirs, files in os.walk(base_dir, followlinks=follow_symlinks):
        for f in files:
            file_size = os.path.getsize(os.path.join(root, f))
            data_pages = max(1, int(math.ceil(file_size / build_config.OBJ_DATA_PAGE_CONTENT_LEN)))
            # Continuation index pages needed when data pages exceed the first index page capacity
            extra = max(0, data_pages - build_config.OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM)
            index_pages = 1 + int(math.ceil(extra / build_config.OBJ_INDEX_PAGES_OBJ_IDS_LIM)) if extra > 0 else 1
            total_pages += data_pages + index_pages

    start_blocks = max(1, int(math.ceil(total_pages / build_config.OBJ_USABLE_PAGES_PER_BLOCK)))

    # --- Phase 2: try-and-grow ---
    blocks = start_blocks
    while True:
        img_size = blocks * block_size
        spiffs = SpiffsFS(img_size, build_config)
        try:
            for root, _dirs, files in os.walk(base_dir, followlinks=follow_symlinks):
                for f in files:
                    full_path = os.path.join(root, f)
                    img_path = '/' + os.path.relpath(full_path, base_dir).replace('\\', '/')
                    spiffs.create_file(img_path, full_path)
            return img_size          # fits — this is the minimum
        except SpiffsFullError:
            blocks += 1              # need one more block, retry


class CustomHelpFormatter(argparse.HelpFormatter):
    """
    Similar to argparse.ArgumentDefaultsHelpFormatter, except it
    doesn't add the default value if "(default:" is already present.
    This helps in the case of options with action="store_false", like
    --no-magic or --no-magic-len.
    """
    def _get_help_string(self, action):  # type: (argparse.Action) -> str
        if action.help is None:
            return ''
        if '%(default)' not in action.help and '(default:' not in action.help:
            if action.default is not argparse.SUPPRESS:
                defaulting_nargs = [argparse.OPTIONAL, argparse.ZERO_OR_MORE]
                if action.option_strings or action.nargs in defaulting_nargs:
                    return action.help + ' (default: %(default)s)'
        return action.help


def main():  # type: () -> None
    parser = argparse.ArgumentParser(description='SPIFFS Image Generator',
                                     formatter_class=CustomHelpFormatter)

    parser.add_argument('image_size',
                        nargs='?',
                        default=None,
                        help='Size of the created image (e.g. 0x40000 or 262144). '
                             'If omitted, the minimum required size is calculated automatically.')

    parser.add_argument('base_dir',
                        help='Path to directory from which the image will be created')

    parser.add_argument('output_file',
                        help='Created image output file path')

    parser.add_argument('--page-size',
                        help='Logical page size. Set to value same as CONFIG_SPIFFS_PAGE_SIZE.',
                        type=int,
                        default=256)

    parser.add_argument('--block-size',
                        help="Logical block size. Set to the same value as the flash chip's sector size (g_rom_flashchip.sector_size).",
                        type=int,
                        default=4096)

    parser.add_argument('--obj-name-len',
                        help='File full path maximum length. Set to value same as CONFIG_SPIFFS_OBJ_NAME_LEN.',
                        type=int,
                        default=32)

    parser.add_argument('--meta-len',
                        help='File metadata length. Set to value same as CONFIG_SPIFFS_META_LENGTH.',
                        type=int,
                        default=4)

    parser.add_argument('--use-magic',
                        dest='use_magic',
                        help='Use magic number to create an identifiable SPIFFS image. Specify if CONFIG_SPIFFS_USE_MAGIC.',
                        action='store_true')

    parser.add_argument('--no-magic',
                        dest='use_magic',
                        help='Inverse of --use-magic (default: --use-magic is enabled)',
                        action='store_false')

    parser.add_argument('--use-magic-len',
                        dest='use_magic_len',
                        help='Use position in memory to create different magic numbers for each block. Specify if CONFIG_SPIFFS_USE_MAGIC_LENGTH.',
                        action='store_true')

    parser.add_argument('--no-magic-len',
                        dest='use_magic_len',
                        help='Inverse of --use-magic-len (default: --use-magic-len is enabled)',
                        action='store_false')

    parser.add_argument('--follow-symlinks',
                        help='Take into account symbolic links during partition image creation.',
                        action='store_true')

    parser.add_argument('--big-endian',
                        help='Specify if the target architecture is big-endian. If not specified, little-endian is assumed.',
                        action='store_true')

    parser.add_argument('--aligned-obj-ix-tables',
                        action='store_true',
                        help='Use aligned object index tables. Specify if SPIFFS_ALIGNED_OBJECT_INDEX_TABLES is set.')

    parser.set_defaults(use_magic=True, use_magic_len=True)

    args = parser.parse_args()

    if not os.path.exists(args.base_dir):
        raise RuntimeError('given base directory %s does not exist' % args.base_dir)

    spiffs_build_default = SpiffsBuildConfig(args.page_size, SPIFFS_PAGE_IX_LEN,
                                             args.block_size, SPIFFS_BLOCK_IX_LEN, args.meta_len,
                                             args.obj_name_len, SPIFFS_OBJ_ID_LEN, SPIFFS_SPAN_IX_LEN,
                                             True, True, 'big' if args.big_endian else 'little',
                                             args.use_magic, args.use_magic_len, args.aligned_obj_ix_tables)

    # Print configuration
    print('[spiffsgen] Configuration:')
    print('  Page size:     %d' % args.page_size)
    print('  Block size:    %d  (0x%X)' % (args.block_size, args.block_size))
    print('  Obj name len:  %d' % args.obj_name_len)
    print('  Meta len:      %d' % args.meta_len)
    print('  Use magic:     %s' % args.use_magic)
    print('  Use magic len: %s' % args.use_magic_len)

    if args.image_size is not None:
        # ── Explicit size: use it, but verify that all files actually fit ──
        image_size = int(args.image_size, 0)

        # If the value is smaller than one block it cannot be a byte count —
        # treat it as a block count (e.g. 655 -> 655 x 4096 = 2 686 976 bytes).
        if image_size % args.block_size != 0:
            image_size = int(math.ceil(image_size / args.block_size)) * args.block_size

        all_files = _collect_files(args.base_dir, args.follow_symlinks)
        total = len(all_files)
        spiffs = SpiffsFS(image_size, spiffs_build_default)
        try:
            for idx, (img_path, full_path) in enumerate(all_files, 1):
                spiffs.create_file(img_path, full_path)
                _print_progress(idx, total, img_path)
        except SpiffsFullError:
            min_size = _calc_min_image_size(args.base_dir, spiffs_build_default, args.follow_symlinks)
            print('[spiffsgen] Error: specified image size %d bytes (%d blocks) is too small for the data.'
                  % (image_size, image_size // args.block_size))
            print('[spiffsgen] Minimum required size: %d bytes (%d blocks of %d bytes each)'
                  % (min_size, min_size // args.block_size, args.block_size))
            sys.exit(2)
    else:
        # ── Auto mode: calculate the exact minimum size, then build ──
        image_size = _calc_min_image_size(args.base_dir, spiffs_build_default, args.follow_symlinks)
        print('[spiffsgen] Auto-calculated image size: %d bytes (%d blocks of %d bytes each)' % (
            image_size, image_size // args.block_size, args.block_size))

        all_files = _collect_files(args.base_dir, args.follow_symlinks)
        total = len(all_files)
        spiffs = SpiffsFS(image_size, spiffs_build_default)
        for idx, (img_path, full_path) in enumerate(all_files, 1):
            spiffs.create_file(img_path, full_path)
            _print_progress(idx, total, img_path)

    with open(args.output_file, 'wb') as image_file:
        image_file.write(spiffs.to_binary())

    print('[spiffsgen] Image written (%d bytes, %d blocks) -> %s'
          % (image_size, image_size // args.block_size, args.output_file))


if __name__ == '__main__':
    main()
