#!/usr/bin/env python
# -*- coding: utf-8 -*-
#
# littlefsgen.py — Pure Python LittleFS v2 Image Generator
#
# Compatible with Python 3.7+ (no walrus operator, no external deps)
# Uses only stdlib: struct, os, sys, math
#
# Based on the littlefs filesystem by Christopher Haster
# https://github.com/littlefs-project/littlefs
#
# On-disk format per SPEC.md (lfs2.1):
#   - Tags are 32-bit, stored BIG-ENDIAN (the only big-endian thing in littlefs)
#   - Tag format: [1 valid | 11 type3 | 10 id | 10 length]
#   - type3 = (type1 << 8) | chunk
#   - Tags are XOR-chained starting with 0xFFFFFFFF
#   - CRC-32 polynomial 0x04C11DB7, init 0xFFFFFFFF (non-reflected)
#   - Metadata pairs: revision count (LE u32) + commits + CRC
#
# SPDX-License-Identifier: BSD-3-Clause

from __future__ import print_function
import struct
import os
import sys
import math

# ============================================================================
#  Constants (from lfs.h)
# ============================================================================

LFS_DISK_VERSION = 0x00020001  # lfs2.1

LFS_BLOCK_NULL = 0xFFFFFFFF
MASK32 = 0xFFFFFFFF

# ── Tag type1 categories (3-bit upper part of type3) ──────────────────
LFS_TYPE_NAME     = 0x000   # 0x0xx — name + file type in chunk
LFS_TYPE_STRUCT   = 0x200   # 0x2xx — struct type in chunk
LFS_TYPE_USERATTR = 0x300   # 0x3xx — user attr type in chunk
LFS_TYPE_SPLICE   = 0x400   # 0x4xx — splice ops
LFS_TYPE_CRC      = 0x500   # 0x5xx — CRC + valid-state bit in chunk
LFS_TYPE_TAIL     = 0x600   # 0x6xx — tail type in chunk
LFS_TYPE_GLOBALS  = 0x700   # 0x7xx — global state

# ── Specialized tag types (type1 + chunk) ─────────────────────────────
LFS_TYPE_REG          = 0x001   # NAME chunk: regular file
LFS_TYPE_DIR          = 0x002   # NAME chunk: directory
LFS_TYPE_SUPERBLOCK   = 0x0FF   # NAME chunk: superblock
LFS_TYPE_DIRSTRUCT    = 0x200   # STRUCT chunk: directory pair pointer
LFS_TYPE_INLINESTRUCT = 0x201   # STRUCT chunk: inline file data
LFS_TYPE_CTZSTRUCT    = 0x202   # STRUCT chunk: CTZ skip-list head+size
LFS_TYPE_CREATE       = 0x401   # SPLICE chunk: create entry
LFS_TYPE_DELETE       = 0x4FF   # SPLICE chunk: delete entry
LFS_TYPE_CCRC         = 0x500   # CRC chunk: commit CRC
LFS_TYPE_FCRC        = 0x5FF   # CRC chunk: forward CRC
LFS_TYPE_SOFTTAIL     = 0x600   # TAIL chunk: soft tail (next dir)
LFS_TYPE_HARDTAIL     = 0x601   # TAIL chunk: hard tail (continuation)
LFS_TYPE_MOVESTATE    = 0x7FF   # GLOBALS chunk: move state


def MKTAG(typ3, id_, size):
    """Create a 32-bit LittleFS tag.

    Tag layout: [1 valid | 11 type3 | 10 id | 10 length]
    The valid bit (bit 31) is always 0 for valid tags.
    """
    return ((typ3 & 0x7FF) << 20) | ((id_ & 0x3FF) << 10) | (size & 0x3FF)


def TAG_TYPE3(tag):
    return (tag >> 20) & 0x7FF


def TAG_ID(tag):
    return (tag >> 10) & 0x3FF


def TAG_SIZE(tag):
    return tag & 0x3FF


# ============================================================================
#  CRC-32 — Reflected polynomial (same as zlib.crc32)
#
#  Although the LittleFS specification says "polynomial 0x04C11DB7",
#  the actual C implementation (lfs.c) uses a nibble-at-a-time table
#  with the REFLECTED polynomial 0xEDB88320, which is equivalent to
#  the standard CRC-32 used by zlib, Ethernet, PNG, etc.
#
#  Init value: 0xFFFFFFFF, final XOR: none (littlefs does NOT
#  apply the final XOR of 0xFFFFFFFF that some CRC-32 variants use).
# ============================================================================

import zlib as _zlib

def lfs_crc(crc, data):
    """Compute LittleFS CRC-32 over data bytes.

    Uses the reflected CRC-32 algorithm (same polynomial as zlib.crc32)
    but WITHOUT the final XOR that zlib applies.  The littlefs C code
    initialises with 0xFFFFFFFF and never XORs the result, whereas
    zlib.crc32 applies ^0xFFFFFFFF at the start AND end of every call.
    To get the littlefs-compatible running CRC we must undo zlib's
    double-XOR:

        lfs_crc(crc, data) = zlib.crc32(data, crc ^ 0xFFFFFFFF) ^ 0xFFFFFFFF
    """
    return _zlib.crc32(data, crc ^ MASK32) ^ MASK32


# ============================================================================
#  Block Device (bytearray-backed simulated flash)
# ============================================================================

class BlockDevice(object):
    def __init__(self, block_size, block_count):
        self.block_size = block_size
        self.block_count = block_count
        self.data = bytearray(b'\xFF' * (block_size * block_count))

    def read(self, block, offset, size):
        start = block * self.block_size + offset
        return bytes(self.data[start:start + size])

    def prog(self, block, offset, data):
        start = block * self.block_size + offset
        for i in range(len(data)):
            self.data[start + i] = data[i]

    def erase(self, block):
        start = block * self.block_size
        for i in range(self.block_size):
            self.data[start + i] = 0xFF


# ============================================================================
#  CTZ skip-list helpers
# ============================================================================

def ctz32(x):
    """Count trailing zeros of a 32-bit unsigned integer. Returns 32 for x=0."""
    if x == 0:
        return 32
    n = 0
    while (x & 1) == 0:
        n += 1
        x >>= 1
    return n


def ctz_num_pointers(block_index):
    """Return the number of CTZ skip-list pointers for a block at the given
    0-based index within the file's data blocks.

    Per SPEC.md: "For every nth block where n is divisible by 2^x, that
    block contains a pointer to block n-2^x."

    Block 0 has 0 pointers.  Block n (n>0) has (1 + ctz(n)) pointers,
    pointing to blocks n-1, n-2, n-4, ..., n-2^ctz(n).
    """
    if block_index <= 0:
        return 0
    return 1 + ctz32(block_index)


def ctz_pointer_targets(block_index):
    """Return list of target block indices (within the file) that
    `block_index` points to in the CTZ skip-list.

    For block n > 0: targets = [n-1, n-2, n-4, ..., n-2^ctz(n)]
    These are stored in the block as u32 values, in this order.
    """
    if block_index <= 0:
        return []
    targets = []
    ctz = ctz32(block_index)
    for k in range(ctz + 1):
        targets.append(block_index - (1 << k))
    return targets


# ============================================================================
#  LFS — Pure Python LittleFS v2 Image Generator (write-only)
# ============================================================================

class LFS(object):
    """Pure Python LittleFS v2 filesystem image generator.

    This is a WRITE-ONLY implementation — it can format, mkdir, and write
    files, producing a valid on-disk image.  It does NOT support reading.
    """

    def __init__(self, block_size=4096, block_count=0, name_max=255,
                 file_max=0, attr_max=0):
        self.block_size = block_size
        self.block_count = block_count
        self.name_max = name_max
        self.file_max = file_max
        self.attr_max = attr_max

        # inline_max: max bytes stored inline in the metadata pair.
        # Default matches littlefs: min(block_size/8, cache_size=256)
        self.inline_max = min(block_size // 8, 256)
        if self.inline_max < 1:
            self.inline_max = block_size // 8

        self.bd = BlockDevice(block_size, block_count)

        # Block allocator — simple bump allocator
        self.next_block = 0

        # Root directory pair
        self.root = [0, 1]

        # Directory tracking: path -> dir_info dict
        # Populated during format / mkdir / file writes
        self._dirs = {}

    # ── Block allocation ──────────────────────────────────────────────

    def _alloc(self, count=1):
        """Allocate `count` consecutive free blocks."""
        if self.next_block + count > self.block_count:
            raise RuntimeError(
                "LittleFS: no free blocks (need %d, have %d)"
                % (count, self.block_count - self.next_block))
        blk = self.next_block
        self.next_block += count
        return blk

    def _alloc_pair(self):
        """Allocate a metadata pair (two consecutive blocks)."""
        b0 = self._alloc(2)
        return [b0, b0 + 1]

    # ── Write metadata pair to disk ───────────────────────────────────

    def _write_mdir(self, pair, rev, entries, tail=None):
        """Write a complete metadata pair to disk (both blocks).

        LittleFS metadata pairs consist of two blocks used in alternating
        copy-on-write fashion.  Both blocks must contain a valid commit so
        that the reader can determine which one is current (by comparing
        revision counts).  Leaving one block as 0xFF would cause the reader
        to interpret the erased bytes as revision 0xFFFFFFFF and prefer that
        (invalid) block over the real one.

        We write both blocks: the primary gets rev+1 and the alternate gets
        rev+2.  The primary (higher revision) is the active one.

        pair:    [block0, block1] — the two blocks of the metadata pair
        rev:     current revision count (will be incremented)
        entries: list of (type3, id, data_bytes) tag tuples
        tail:    (pair0, pair1) for SOFTTAIL, or None

        Returns the final (higher) revision count.
        """
        # We write the same content to both blocks with consecutive
        # revision counts so that the pair is always in a consistent state.
        final_rev = rev + 2   # two writes: rev+1 on alternate, rev+2 on primary
        primary_block = pair[0] if (final_rev % 2 == 0) else pair[1]
        alt_block = pair[1] if primary_block == pair[0] else pair[0]

        # Build the commit content (shared between both blocks)
        content = bytearray()

        # 1) Tags with XOR chaining — tags stored in BIG-ENDIAN
        ptag = MASK32  # initial XOR mask = 0xFFFFFFFF

        for type3, eid, tag_data in entries:
            actual_tag = MKTAG(type3, eid, len(tag_data))
            raw_tag = (ptag ^ actual_tag) & MASK32
            content.extend(struct.pack('>I', raw_tag))   # BIG-ENDIAN tags!
            content.extend(tag_data)
            ptag = actual_tag

        # 2) SOFTTAIL tag (if directory has a tail pointer)
        if tail is not None:
            tail_data = struct.pack('<II', tail[0], tail[1])
            actual_tag = MKTAG(LFS_TYPE_SOFTTAIL, 0x3FF, len(tail_data))
            raw_tag = (ptag ^ actual_tag) & MASK32
            content.extend(struct.pack('>I', raw_tag))
            content.extend(tail_data)
            ptag = actual_tag

        # 3) CRC tag
        #    chunk = 0x00 (valid-state for next commit = 0).
        #    The reader expects the next commit's valid bit to be 0;
        #    erased flash produces valid_bit=1 after XOR, so the mismatch
        #    correctly signals "no next commit".
        #
        #    CRC tag data size = CRC value (4 bytes) + padding to fill
        #    the remaining block space.  This matches what the littlefs C
        #    library writes and ensures the CRC covers a predictable region.
        #
        tag_and_data_size = 4 + len(content)  # revision(4) + content
        remaining = self.block_size - tag_and_data_size - 4  # -4 for CRC tag
        if remaining < 4:
            raise RuntimeError(
                "LittleFS: no room for CRC tag in metadata pair")
        crc_data_size = remaining  # CRC value (4) + padding
        # Cap at max tag data size (1022)
        if crc_data_size > 1022:
            crc_data_size = 1022

        crc_type3 = LFS_TYPE_CCRC  # chunk=0x00
        crc_tag = MKTAG(crc_type3, 0x3FF, crc_data_size)
        raw_crc_tag = (ptag ^ crc_tag) & MASK32

        # CRC covers: revision count + tags+data + CRC tag (not CRC value)
        # We'll compute it once and reuse for both blocks.
        # The CRC depends on the revision count, so we compute it for the
        # primary block first and then recompute for the alternate.
        # Actually, the CRC includes the revision count which differs, so
        # we must compute separately for each block.

        def _build_block(rev_count, content, raw_crc_tag, crc_data_size,
                         block_size):
            """Build a complete metadata block."""
            buf = bytearray()
            buf.extend(struct.pack('<I', rev_count))
            buf.extend(content)
            buf.extend(struct.pack('>I', raw_crc_tag))

            # Compute CRC over everything so far
            crc_val = lfs_crc(MASK32, bytes(buf))
            buf.extend(struct.pack('<I', crc_val))
            # Padding
            if crc_data_size > 4:
                buf.extend(b'\xFF' * (crc_data_size - 4))
            # Pad to block size
            if len(buf) > block_size:
                raise RuntimeError(
                    "LittleFS: metadata block too large (%d > %d)"
                    % (len(buf), block_size))
            buf.extend(b'\xFF' * (block_size - len(buf)))
            return bytes(buf)

        # Write alternate block (lower revision)
        alt_rev = final_rev - 1
        alt_block_data = _build_block(
            alt_rev, content, raw_crc_tag, crc_data_size, self.block_size)
        self.bd.erase(alt_block)
        self.bd.prog(alt_block, 0, alt_block_data)

        # Write primary block (higher revision)
        primary_block_data = _build_block(
            final_rev, content, raw_crc_tag, crc_data_size, self.block_size)
        self.bd.erase(primary_block)
        self.bd.prog(primary_block, 0, primary_block_data)

        return final_rev

    # ── Format ────────────────────────────────────────────────────────

    def format(self):
        """Format a new LittleFS filesystem.

        Only sets up internal state — actual disk writes happen at unmount().
        """
        self.next_block = 2   # blocks [0,1] reserved for root pair

        self._dirs['/'] = {
            'pair': [0, 1],
            'entries': [],       # list of entry dicts (see below)
            'next_id': 1,        # id=0 is the superblock entry
        }

    # ── Directory creation ────────────────────────────────────────────

    def _find_or_create_dir(self, dirpath):
        """Ensure the directory at `dirpath` exists, creating parents as needed."""
        if dirpath in self._dirs:
            return self._dirs[dirpath]

        parts = dirpath.strip('/').split('/')
        current = '/'
        for part in parts:
            if not part:
                continue
            child = current.rstrip('/') + '/' + part
            if child not in self._dirs:
                self._mkdir_impl(child, current)
            current = child

        return self._dirs.get(dirpath, self._dirs['/'])

    def _mkdir_impl(self, path, parent_path):
        """Create a subdirectory `path` inside `parent_path`."""
        parent = self._dirs[parent_path]
        dirname = path.rsplit('/', 1)[-1]

        # Allocate a new pair for this directory
        new_pair = self._alloc_pair()

        # Assign an ID for this entry in the parent directory
        entry_id = parent['next_id']
        parent['next_id'] += 1

        # Record the entry in the parent
        parent['entries'].append({
            'type': 'dir',
            'name': dirname,
            'id': entry_id,
            'pair': new_pair,
        })

        # Register the new (empty) directory
        self._dirs[path] = {
            'pair': new_pair,
            'entries': [],
            'next_id': 1,
        }

    # ── File writing ──────────────────────────────────────────────────

    def _add_file_to_dir(self, dir_path, filename, file_data):
        """Add a file entry to the specified directory."""
        dir_info = self._find_or_create_dir(dir_path)

        entry_id = dir_info['next_id']
        dir_info['next_id'] += 1

        if len(file_data) <= self.inline_max:
            # Inline file — data stored directly in the metadata pair
            dir_info['entries'].append({
                'type': 'inline',
                'name': filename,
                'id': entry_id,
                'data': file_data,
            })
        else:
            # CTZ file — data stored in data blocks with skip-list pointers
            head_block, file_size = self._write_ctz_file(file_data)
            dir_info['entries'].append({
                'type': 'ctz',
                'name': filename,
                'id': entry_id,
                'head_block': head_block,
                'file_size': file_size,
            })

    def _write_ctz_file(self, data):
        """Write file data using CTZ skip-list format.

        Returns (head_block, file_size) where head_block is the flash
        block index of the last (head) block of the skip-list.
        """
        block_size = self.block_size
        file_size = len(data)

        # ── Phase 1: determine how many blocks we need ────────────
        # Each block i has ctz_num_pointers(i) pointers (4 bytes each),
        # so data capacity = block_size - 4 * num_pointers.
        block_data_sizes = []
        offset = 0
        bi = 0
        while offset < file_size:
            num_ptrs = ctz_num_pointers(bi)
            data_cap = block_size - 4 * num_ptrs
            if data_cap <= 0:
                raise RuntimeError(
                    "LittleFS: block %d has no room for data "
                    "(%d pointers, block_size=%d)"
                    % (bi, num_ptrs, block_size))
            chunk = min(data_cap, file_size - offset)
            block_data_sizes.append(chunk)
            offset += chunk
            bi += 1

        num_blocks = len(block_data_sizes)
        if num_blocks == 0:
            # Empty file — should be inline, not CTZ
            raise RuntimeError("LittleFS: CTZ file with no data")

        # ── Phase 2: allocate flash blocks ────────────────────────
        flash_blocks = []
        for _ in range(num_blocks):
            flash_blocks.append(self._alloc(1))

        # ── Phase 3: write each block ─────────────────────────────
        offset = 0
        for i in range(num_blocks):
            self.bd.erase(flash_blocks[i])
            buf = bytearray()

            # Write CTZ skip-list pointers (to earlier blocks in the file)
            targets = ctz_pointer_targets(i)
            for target in targets:
                buf.extend(struct.pack('<I', flash_blocks[target]))

            # Write file data
            chunk = data[offset:offset + block_data_sizes[i]]
            buf.extend(chunk)
            offset += block_data_sizes[i]

            # Pad to block_size with 0xFF
            buf.extend(b'\xFF' * (block_size - len(buf)))
            self.bd.prog(flash_blocks[i], 0, bytes(buf))

        # Head block is the LAST block (CTZ skip-list is read in reverse)
        return flash_blocks[-1], file_size

    # ── Build tag list for a directory ────────────────────────────────

    def _build_dir_tags(self, dir_info):
        """Build the list of (type3, id, data) tag tuples for a directory."""
        tags = []

        for entry in dir_info['entries']:
            eid = entry['id']
            ename = entry['name'].encode('utf-8')

            # CREATE tag — marks a new entry with this id
            tags.append((LFS_TYPE_CREATE, eid, b''))

            # NAME tag — chunk field = file type (REG or DIR)
            if entry['type'] == 'dir':
                tags.append((LFS_TYPE_DIR, eid, ename))
            else:
                tags.append((LFS_TYPE_REG, eid, ename))

            # STRUCT tag — depends on entry type
            if entry['type'] == 'inline':
                tags.append((LFS_TYPE_INLINESTRUCT, eid, entry['data']))
            elif entry['type'] == 'ctz':
                ctz_data = struct.pack('<II',
                                       entry['head_block'],
                                       entry['file_size'])
                tags.append((LFS_TYPE_CTZSTRUCT, eid, ctz_data))
            elif entry['type'] == 'dir':
                pair_data = struct.pack('<II',
                                        entry['pair'][0],
                                        entry['pair'][1])
                tags.append((LFS_TYPE_DIRSTRUCT, eid, pair_data))

        return tags

    # ── Unmount: write everything to disk ─────────────────────────────

    def unmount(self):
        """Finalize the filesystem and write all metadata pairs to disk.

        This must be called after all mkdir / file write operations.
        """
        if not self._dirs:
            return

        # ── Build the directory linked list (sorted alphabetically) ──
        # In LittleFS, directories are threaded in a linked list via
        # soft-tail pointers.  The list must be in alphabetical order.
        all_dir_paths = sorted(self._dirs.keys())

        # Map each directory to its soft-tail target
        dir_tails = {}
        for i, dpath in enumerate(all_dir_paths):
            if i + 1 < len(all_dir_paths):
                next_dir = self._dirs[all_dir_paths[i + 1]]
                dir_tails[dpath] = list(next_dir['pair'])
            else:
                dir_tails[dpath] = [LFS_BLOCK_NULL, LFS_BLOCK_NULL]

        # ── Write subdirectories first (reverse alphabetical order) ──
        # This ensures that when we write a directory, its tail target
        # (the next directory) already has its block contents written.
        # Actually, we only need the pair addresses, which are already
        # allocated.  The order doesn't matter for correctness since
        # we're writing complete blocks.  But for consistency, write
        # in reverse order so deeper dirs are written first.

        subdirs = [d for d in all_dir_paths if d != '/']
        for dpath in reversed(subdirs):
            dir_info = self._dirs[dpath]
            tags = self._build_dir_tags(dir_info)
            tail = dir_tails[dpath]
            dir_info['rev'] = self._write_mdir(
                dir_info['pair'], 0, tags, tail=tail)

        # ── Write root directory (superblock pair) ─────────────────
        root = self._dirs['/']
        root_tags = []

        # Superblock entry (id=0):
        #   NAME tag  — type3 = 0x0FF, data = "littlefs"
        #   INLINESTRUCT tag — type3 = 0x201, data = superblock struct
        dv = getattr(self, '_disk_version_override', LFS_DISK_VERSION)
        sb_data = struct.pack('<IIIIII',
                              dv,
                              self.block_size,
                              self.block_count,
                              self.name_max,
                              self.file_max,
                              self.attr_max)

        root_tags.append((LFS_TYPE_SUPERBLOCK, 0, b'littlefs'))
        root_tags.append((LFS_TYPE_INLINESTRUCT, 0, sb_data))

        # Add all entries in the root directory
        root_tags.extend(self._build_dir_tags(root))

        # Write root metadata pair
        root_tail = dir_tails.get('/', [LFS_BLOCK_NULL, LFS_BLOCK_NULL])
        self._write_mdir(root['pair'], 0, root_tags, tail=root_tail)

    # ── Public API ────────────────────────────────────────────────────

    def mkdir(self, path):
        """Create a directory at the given path."""
        path = path.replace('\\', '/')
        if not path.startswith('/'):
            path = '/' + path
        path = path.rstrip('/') or '/'

        if path == '/':
            return   # root always exists

        self._find_or_create_dir(path)

    def open(self, path, mode='rb'):
        """Open a file for writing.  Returns a file-like object."""
        path = path.replace('\\', '/')
        if not path.startswith('/'):
            path = '/' + path

        parts = path.rsplit('/', 1)
        if len(parts) == 2:
            dir_path = parts[0] or '/'
            filename = parts[1]
        else:
            dir_path = '/'
            filename = parts[0]

        self._find_or_create_dir(dir_path)
        return _LFSFile(self, dir_path, filename)

    def get_image(self):
        """Return the filesystem image as bytes."""
        return bytes(self.bd.data)


class _LFSFile(object):
    """File-like object for writing to a LittleFS image."""

    def __init__(self, lfs, dir_path, filename):
        self._lfs = lfs
        self._dir_path = dir_path
        self._filename = filename
        self._data = bytearray()
        self._closed = False

    def write(self, data):
        if self._closed:
            raise ValueError("I/O operation on closed file.")
        if isinstance(data, str):
            data = data.encode('utf-8')
        self._data.extend(data)
        return len(data)

    def close(self):
        if self._closed:
            return
        self._closed = True
        self._lfs._add_file_to_dir(
            self._dir_path, self._filename, bytes(self._data))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


# ============================================================================
#  Directory walking
# ============================================================================

def _walk_dir(base_dir, follow_symlinks=False):
    """Return sorted list of (relative_path, full_path, is_dir)."""
    result = []
    for dirpath, dirnames, filenames in os.walk(base_dir,
                                                 followlinks=follow_symlinks):
        dirnames.sort()
        for d in sorted(dirnames):
            full = os.path.join(dirpath, d)
            rel = '/' + os.path.relpath(full, base_dir).replace('\\', '/')
            result.append((rel, full, True))
        for f in sorted(filenames):
            full = os.path.join(dirpath, f)
            rel = '/' + os.path.relpath(full, base_dir).replace('\\', '/')
            result.append((rel, full, False))
    return result


def _print_progress(done, total, path):
    pct = int(done * 100 / total) if total else 100
    bar_len = 30
    filled = bar_len * done // total if total else bar_len
    bar = '#' * filled + '-' * (bar_len - filled)
    sys.stderr.write('[%s] %3d%% (%d/%d)  %s\n' % (bar, pct, done, total, path))
    sys.stderr.flush()


def _calc_min_image_size(input_dir, block_size, name_max, follow_symlinks=False):
    """Calculate the minimum LittleFS image size that can fit all files.

    Uses a two-phase approach:
      1. Quick estimate based on data size + metadata overhead.
      2. Try-and-grow loop for an exact result (guaranteed correct).
    """
    entries = _walk_dir(input_dir, follow_symlinks)
    dirs = [(rel, full) for rel, full, is_dir in entries if is_dir]
    files = [(rel, full) for rel, full, is_dir in entries if not is_dir]

    if not dirs and not files:
        # Empty directory — smallest valid image is 2 blocks
        return 2 * block_size

    # --- Phase 1: quick estimate ---
    # Each directory needs a metadata pair (2 blocks).
    # Each file either stores inline (no extra blocks) or as CTZ
    # (data blocks + pointers overhead).
    inline_max = min(block_size // 8, 256)
    data_blocks = 0
    for rel, full in files:
        file_size = os.path.getsize(full)
        if file_size > inline_max:
            # Estimate CTZ data blocks
            bi = 0
            remaining = file_size
            while remaining > 0:
                num_ptrs = ctz_num_pointers(bi)
                cap = block_size - 4 * num_ptrs
                chunk = min(cap, remaining)
                remaining -= chunk
                data_blocks += 1
                bi += 1

    num_dirs = len(dirs) + 1  # +1 for root
    meta_blocks = num_dirs * 2  # each dir = 1 pair = 2 blocks
    start_blocks = meta_blocks + data_blocks
    # Add 20% overhead margin for metadata tags, CRC, alignment
    start_blocks = max(start_blocks + 2, int(start_blocks * 1.2))
    if start_blocks < 2:
        start_blocks = 2

    # --- Phase 2: try-and-grow ---
    blocks = start_blocks
    while True:
        img_size = blocks * block_size
        try:
            fs = LFS(block_size=block_size, block_count=blocks,
                     name_max=name_max)
            fs.format()
            for rel, full in dirs:
                fs.mkdir(rel)
            for rel, full in files:
                with open(full, 'rb') as fobj:
                    data = fobj.read()
                with fs.open(rel, 'wb') as dest:
                    dest.write(data)
            fs.unmount()
            return img_size
        except RuntimeError:
            blocks += 1
            if blocks > 65536:
                raise RuntimeError(
                    "LittleFS: could not fit files in 65536 blocks "
                    "(image would exceed %d bytes)" % (65536 * block_size))


# ============================================================================
#  Main CLI
# ============================================================================

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description='LittleFS Image Generator (pure Python, no external deps)',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument('input_dir',
                        help='Path to directory from which the image will be created')
    parser.add_argument('output_file',
                        help='Created image output file path')
    parser.add_argument('--image_size', type=str, default=None,
                        help='Total image size in bytes (e.g. 0x100000, 1M). '
                             'If omitted, the minimum required size is calculated automatically.')
    parser.add_argument('--block_count', type=int, default=None,
                        help='Number of flash blocks')
    parser.add_argument('--block_size', type=int, default=4096,
                        help='Flash block (sector) size in bytes')
    parser.add_argument('--name_max', type=int, default=32,
                        help='Maximum filename length')
    parser.add_argument('--disk_version', type=str, default=None,
                        help='LittleFS disk version as 0xMMmm (default: 0x00020001)')
    parser.add_argument('--follow-symlinks', action='store_true',
                        help='Follow symbolic links')
    parser.add_argument('--compact', action='store_true',
                        help='Compact image: pack data into minimum blocks')
    parser.add_argument('--no-pad', action='store_true',
                        help='Do not pad with 0xFF')

    args = parser.parse_args()

    if not os.path.isdir(args.input_dir):
        sys.exit("Error: input directory '%s' does not exist." % args.input_dir)

    # Parse size
    def parse_size(s):
        s = s.strip()
        if s.startswith('0x') or s.startswith('0X'):
            return int(s, 16)
        if s.upper().endswith('M'):
            return int(s[:-1]) * 1048576
        if s.upper().endswith('K'):
            return int(s[:-1]) * 1024
        return int(s)

    block_size = args.block_size

    if args.image_size is not None:
        image_size = parse_size(args.image_size)
        if image_size % block_size != 0:
            image_size = ((image_size + block_size - 1) // block_size) * block_size
        block_count = image_size // block_size
    elif args.block_count is not None:
        block_count = args.block_count
        image_size = block_count * block_size
    else:
        # Auto mode — calculate minimum required size
        image_size = _calc_min_image_size(
            args.input_dir, block_size, args.name_max, args.follow_symlinks)
        block_count = image_size // block_size
        print('[littlefsgen] Auto-calculated image size: %d bytes '
              '(%d blocks of %d bytes each)'
              % (image_size, block_count, block_size))

    if block_count < 2:
        print('[littlefsgen] Error: specified image size %d bytes (%d blocks) is too small. '
              'LittleFS requires at least 2 blocks (%d bytes).'
              % (image_size, block_count, 2 * block_size))
        sys.exit(2)

    # Parse disk version
    disk_version = LFS_DISK_VERSION
    if args.disk_version is not None:
        dv = args.disk_version.strip()
        if dv.startswith('0x') or dv.startswith('0X'):
            disk_version = int(dv, 16)
        else:
            disk_version = int(dv)

    print('[littlefsgen] Configuration:')
    print('  Block size:    %d  (0x%X)' % (block_size, block_size))
    print('  Image size:    %d  (0x%X)' % (image_size, image_size))
    print('  Block count:   %d' % block_count)
    print('  Name max:      %d' % args.name_max)
    print('  Disk version:  0x%08X' % disk_version)

    # Collect files
    entries = _walk_dir(args.input_dir, args.follow_symlinks)
    dirs = [(rel, full) for rel, full, is_dir in entries if is_dir]
    files = [(rel, full) for rel, full, is_dir in entries if not is_dir]
    total = len(dirs) + len(files)

    # Create filesystem
    # Use the module-level LFS_DISK_VERSION as default, but allow override
    is_auto = (args.image_size is None and args.block_count is None)
    fs = LFS(block_size=block_size, block_count=block_count,
             name_max=args.name_max)
    # Patch disk version into the unmount method if overridden
    if disk_version != LFS_DISK_VERSION:
        fs._disk_version_override = disk_version

    try:
        fs.format()

        done = 0
        # Create directories first
        for rel, full in dirs:
            fs.mkdir(rel)
            done += 1
            _print_progress(done, total, rel)

        # Write files
        for rel, full in files:
            with open(full, 'rb') as fobj:
                data = fobj.read()
            with fs.open(rel, 'wb') as dest:
                dest.write(data)
            done += 1
            _print_progress(done, total, rel)

        # Finalize — write all metadata pairs to disk
        fs.unmount()
    except RuntimeError:
        if is_auto:
            raise  # auto-mode should never fail; re-raise for debugging
        # Explicit size is too small — calculate minimum and exit
        min_size = _calc_min_image_size(args.input_dir, block_size, args.name_max, args.follow_symlinks)
        min_blocks = min_size // block_size
        print('[littlefsgen] Error: specified image size %d bytes (%d blocks) is too small for the data.'
              % (image_size, block_count))
        print('[littlefsgen] Minimum required size: %d bytes (%d blocks of %d bytes each)'
              % (min_size, min_blocks, block_size))
        sys.exit(2)

    # Write output
    image_data = fs.get_image()

    out_dir = os.path.dirname(args.output_file)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir)

    if args.no_pad:
        # Trim trailing 0xFF blocks
        buf = bytearray(image_data)
        last_non_ff = len(buf) - 1
        while last_non_ff >= 0 and buf[last_non_ff] == 0xFF:
            last_non_ff -= 1
        if last_non_ff >= 0:
            trim_point = ((last_non_ff + block_size) // block_size) * block_size
            buf = buf[:trim_point]
        with open(args.output_file, 'wb') as f:
            f.write(bytes(buf))
        print('[littlefsgen] Image written (compact, %d bytes) -> %s'
              % (len(buf), args.output_file))
    else:
        with open(args.output_file, 'wb') as f:
            f.write(image_data)
        print('[littlefsgen] Image written (%d bytes, %d blocks) -> %s'
              % (len(image_data), block_count, args.output_file))


if __name__ == '__main__':
    main()
