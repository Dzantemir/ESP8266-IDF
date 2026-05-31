# SPDX-FileCopyrightText: 2021-2026 Espressif Systems (Shanghai) CO LTD
# SPDX-License-Identifier: Apache-2.0

import os
from datetime import datetime
from typing import List, Optional, Tuple, Union

from .entry import Entry
from .exceptions import FatalError
from .exceptions import WriteDirectoryException
from .fat import FAT
from .fat import Cluster
from .fatfs_state import FATFSState
from .long_filename_utils import build_lfn_full_name
from .long_filename_utils import build_lfn_unique_entry_name_order
from .long_filename_utils import get_required_lfn_entries_count
from .long_filename_utils import split_name_to_lfn_entries
from .long_filename_utils import split_name_to_lfn_entry_blocks
from .utils import DATETIME
from .utils import INVALID_SFN_CHARS_PATTERN
from .utils import MAX_EXT_SIZE
from .utils import MAX_NAME_SIZE
from .utils import FATDefaults
from .utils import build_lfn_short_entry_name
from .utils import build_name
from .utils import lfn_checksum
from .utils import required_clusters_count
from .utils import split_content_into_sectors
from .utils import split_to_name_and_extension


class File:
    """
    The class File provides API to write into the files. It represents file in the FS.
    """

    ATTR_ARCHIVE = 0x20
    ENTITY_TYPE = ATTR_ARCHIVE

    def __init__(self, name, fat, fatfs_state, entry, extension=''):
        # type: (str, FAT, FATFSState, Entry, str) -> None
        self.name = name
        self.extension = extension
        self.fatfs_state = fatfs_state
        self.fat = fat
        self.size = 0
        self._first_cluster = None  # type: Optional[Cluster]
        self._entry = entry

    @property
    def entry(self):
        # type: () -> Entry
        return self._entry

    @property
    def first_cluster(self):
        # type: () -> Optional[Cluster]
        return self._first_cluster

    @first_cluster.setter
    def first_cluster(self, value):
        # type: (Cluster) -> None
        self._first_cluster = value

    def name_equals(self, name, extension):
        # type: (str, str) -> bool
        equals_ = build_name(name, extension) == build_name(self.name, self.extension)
        return equals_

    def write(self, content):
        # type: (bytes) -> None
        self.entry.update_content_size(len(content))
        # we assume that the correct amount of clusters is allocated
        current_cluster = self._first_cluster
        for content_part in split_content_into_sectors(content, self.fatfs_state.boot_sector_state.sector_size * self.fatfs_state.boot_sector_state.sectors_per_cluster):
            content_as_list = content_part
            if current_cluster is None:
                raise FatalError('No free space left!')

            address = current_cluster.cluster_data_address
            self.fatfs_state.binary_image[address: address + len(content_part)] = content_as_list
            current_cluster = current_cluster.next_cluster


class Directory:
    """
    The Directory class provides API to add files and directories into the directory
    and to find the file according to path and write it.
    """

    ATTR_DIRECTORY = 0x10
    ATTR_ARCHIVE = 0x20
    ENTITY_TYPE = ATTR_DIRECTORY

    CURRENT_DIRECTORY = '.'
    PARENT_DIRECTORY = '..'

    def __init__(
        self,
        name,
        fat,
        fatfs_state,
        entry=None,
        cluster=None,
        size=None,
        extension='',
        parent=None,
    ):
        # type: (str, FAT, FATFSState, Optional[Entry], Optional[Cluster], Optional[int], str, Optional[Directory]) -> None
        self.name = name
        self.fatfs_state = fatfs_state
        self.extension = extension

        self.fat = fat
        self.size = size or self.fatfs_state.boot_sector_state.sector_size

        # if directory is root its parent is itself
        self.parent = parent or self  # type: Directory
        self._first_cluster = cluster  # type: Optional[Cluster]

        # entries will be initialized after the cluster allocation
        self.entries = []  # type: List[Entry]
        self.entities = []  # type: List[Union[File, Directory]]
        self._entry = entry  # currently not in use

    @property
    def is_root(self):
        # type: () -> bool
        return self.parent is self

    @property
    def first_cluster(self):
        # type: () -> Cluster
        return self._first_cluster

    @first_cluster.setter
    def first_cluster(self, value):
        # type: (Cluster) -> None
        self._first_cluster = value

    def name_equals(self, name, extension):
        # type: (str, str) -> bool
        equals_ = build_name(name, extension) == build_name(self.name, self.extension)
        return equals_

    @property
    def entries_count(self):
        # type: () -> int
        entries_count_ = self.size // FATDefaults.ENTRY_SIZE
        return entries_count_

    def create_entries(self, cluster):
        # type: (Cluster) -> List[Entry]
        return [
            Entry(entry_id=i, parent_dir_entries_address=cluster.cluster_data_address, fatfs_state=self.fatfs_state)
            for i in range(self.entries_count)
        ]

    def init_directory(self):
        # type: () -> None
        self.entries = self.create_entries(self._first_cluster)

        # the root directory doesn't contain link to itself nor the parent
        if self.is_root:
            return
        # if the directory is not root we initialize the reference to itself and to the parent directory
        for dir_id, name_ in ((self, self.CURRENT_DIRECTORY), (self.parent, self.PARENT_DIRECTORY)):
            new_dir_ = self.find_free_entry() or self.chain_directory()
            new_dir_.allocate_entry(
                first_cluster_id=dir_id.first_cluster.id,
                entity_name=name_,
                entity_extension='',
                entity_type=dir_id.ENTITY_TYPE,
            )

    def lookup_entity(self, object_name, extension):
        # type: (str, str) -> Union[File, Directory, None]
        for entity in self.entities:
            if build_name(entity.name, entity.extension) == build_name(object_name, extension):
                return entity
        return None

    @staticmethod
    def _is_end_of_path(path_as_list):
        # type: (List[str]) -> bool
        return len(path_as_list) == 1

    def recursive_search(self, path_as_list, current_dir):
        # type: (List[str], Directory) -> Union[File, Directory]
        name, extension = split_to_name_and_extension(path_as_list[0])
        next_obj = current_dir.lookup_entity(name, extension)
        if next_obj is None:
            raise FileNotFoundError('No such file or directory!')
        if self._is_end_of_path(path_as_list) and next_obj.name_equals(name, extension):
            return next_obj
        return self.recursive_search(path_as_list[1:], next_obj)

    def find_free_entry(self):
        # type: () -> Optional[Entry]
        for entry in self.entries:
            if entry.is_empty:
                return entry
        return None

    def _extend_directory(self):
        # type: () -> None
        current = self.first_cluster
        while current.next_cluster is not None:
            current = current.next_cluster
        new_cluster = self.fat.find_free_cluster()
        current.set_in_fat(new_cluster.id)
        assert current is not new_cluster
        current.next_cluster = new_cluster
        self.entries += self.create_entries(new_cluster)

    def chain_directory(self):
        # type: () -> Entry
        self._extend_directory()
        free_entry = self.find_free_entry()
        if free_entry is None:
            raise FatalError('No more space left!')
        return free_entry

    @staticmethod
    def allocate_long_name_object(
        free_entry,
        name,
        extension,
        target_dir,
        free_cluster_id,
        entity_type,
        date,
        time,
    ):
        # type: (Entry, str, str, Directory, int, int, DATETIME, DATETIME) -> Entry
        lfn_full_name = build_lfn_full_name(name, extension)
        lfn_unique_entry_order = build_lfn_unique_entry_name_order(target_dir.entities, name)
        lfn_short_entry_name = build_lfn_short_entry_name(
            name, extension, lfn_unique_entry_order, lfn=lfn_full_name
        )
        checksum = lfn_checksum(lfn_short_entry_name)
        entries_count = get_required_lfn_entries_count(lfn_full_name)

        # entries in long file name entries chain starts with the last entry
        split_names_reversed = list(reversed(list(enumerate(split_name_to_lfn_entries(lfn_full_name, entries_count)))))
        for i, name_split_to_entry in split_names_reversed:
            order = i + 1
            blocks_ = split_name_to_lfn_entry_blocks(name_split_to_entry)
            lfn_names = blocks_
            free_entry.allocate_entry(
                first_cluster_id=free_cluster_id,
                entity_name=name,
                entity_extension=extension,
                entity_type=entity_type,
                lfn_order=order,
                lfn_names=lfn_names,
                lfn_checksum_=checksum,
                lfn_is_last=order == entries_count,
            )
            free_entry = target_dir.find_free_entry() or target_dir.chain_directory()
        free_entry.allocate_entry(
            first_cluster_id=free_cluster_id,
            entity_name=lfn_short_entry_name[:MAX_NAME_SIZE],
            entity_extension=lfn_short_entry_name[MAX_NAME_SIZE:],
            entity_type=entity_type,
            lfn_order=Entry.SHORT_ENTRY_LN,
            date=date,
            time=time,
        )
        return free_entry

    @staticmethod
    def _is_valid_sfn(name, extension):
        # type: (str, str) -> bool
        if INVALID_SFN_CHARS_PATTERN.search(name) or INVALID_SFN_CHARS_PATTERN.search(extension):
            return False
        ret = len(name) <= MAX_NAME_SIZE and len(extension) <= MAX_EXT_SIZE
        return ret

    @staticmethod
    def _is_sfn_case_compatible(name, extension):
        # type: (str, str) -> bool
        """
        Check if the name can be represented as a short entry with DIR_NTRes flags.
        DIR_NTRes can only indicate all-uppercase or all-lowercase for each component.
        Mixed-case names (e.g. 'MyFile') require LFN entries instead.
        """
        name_ok = name == name.upper() or name == name.lower()
        ext_ok = not extension or extension == extension.upper() or extension == extension.lower()
        return name_ok and ext_ok

    def allocate_object(
        self,
        name,
        entity_type,
        object_timestamp_,
        path_from_root=None,
        extension='',
        is_empty=False,
    ):
        # type: (str, int, datetime, Optional[List[str]], str, bool) -> Tuple[Optional[Cluster], Entry, Directory]
        """
        Method finds the target directory in the path
        and allocates cluster (both the record in FAT and cluster in the data region)
        and entry in the specified directory
        """

        free_cluster = None  # type: Optional[Cluster]
        free_cluster_id = 0x00
        if not is_empty:
            free_cluster = self.fat.find_free_cluster()
            free_cluster_id = free_cluster.id

        target_dir = self if not path_from_root else self.recursive_search(path_from_root, self)
        free_entry = target_dir.find_free_entry() or target_dir.chain_directory()

        fatfs_date_ = (object_timestamp_.year, object_timestamp_.month, object_timestamp_.day)
        fatfs_time_ = (object_timestamp_.hour, object_timestamp_.minute, object_timestamp_.second)

        if not self.fatfs_state.long_names_enabled or (self._is_valid_sfn(name, extension) and self._is_sfn_case_compatible(name, extension)):
            free_entry.allocate_entry(
                first_cluster_id=free_cluster_id,
                entity_name=name,
                entity_extension=extension,
                date=fatfs_date_,
                time=fatfs_time_,
                fits_short=True,
                entity_type=entity_type,
            )
            return free_cluster, free_entry, target_dir
        return (
            free_cluster,
            self.allocate_long_name_object(
                free_entry=free_entry,
                name=name,
                extension=extension,
                target_dir=target_dir,
                free_cluster_id=free_cluster_id,
                entity_type=entity_type,
                date=fatfs_date_,
                time=fatfs_time_,
            ),
            target_dir,
        )

    def new_file(
        self,
        name,
        extension,
        path_from_root,
        object_timestamp_,
        is_empty,
    ):
        # type: (str, str, Optional[List[str]], datetime, bool) -> None
        free_cluster, free_entry, target_dir = self.allocate_object(
            name=name,
            extension=extension,
            entity_type=Directory.ATTR_ARCHIVE,
            path_from_root=path_from_root,
            object_timestamp_=object_timestamp_,
            is_empty=is_empty,
        )

        file_ = File(name=name, fat=self.fat, extension=extension, fatfs_state=self.fatfs_state, entry=free_entry)
        file_.first_cluster = free_cluster
        target_dir.entities.append(file_)

    def new_directory(
        self,
        name,
        parent,
        path_from_root,
        object_timestamp_,
    ):
        # type: (str, Directory, Optional[List[str]], datetime) -> None
        free_cluster, free_entry, target_dir = self.allocate_object(
            name=name,
            entity_type=Directory.ATTR_DIRECTORY,
            path_from_root=path_from_root,
            object_timestamp_=object_timestamp_,
        )

        directory = Directory(
            name=name, fat=self.fat, parent=parent, fatfs_state=self.fatfs_state, entry=free_entry
        )
        directory.first_cluster = free_cluster
        directory.init_directory()
        target_dir.entities.append(directory)

    def write_to_file(self, path, content):
        # type: (List[str], bytes) -> None
        entity_to_write = self.recursive_search(path, self)
        if isinstance(entity_to_write, File):
            clusters_cnt = required_clusters_count(
                cluster_size=self.fatfs_state.boot_sector_state.sector_size * self.fatfs_state.boot_sector_state.sectors_per_cluster, content=content
            )
            self.fat.allocate_chain(entity_to_write.first_cluster, clusters_cnt)
            entity_to_write.write(content)
        else:
            raise WriteDirectoryException('`%s` is a directory!' % os.path.join(*path))


