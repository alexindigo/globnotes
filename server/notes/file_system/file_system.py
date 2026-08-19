import glob
import os
import re
import shutil
import threading
import time
from datetime import datetime
from typing import List, Literal, Set, Tuple

import whoosh
from whoosh import writing
from whoosh.analysis import CharsetFilter, StemmingAnalyzer
from whoosh.fields import DATETIME, ID, KEYWORD, TEXT, SchemaClass
from whoosh.highlight import ContextFragmenter, WholeFragmenter
from whoosh.index import Index, LockError
from whoosh.qparser import MultifieldParser
from whoosh.qparser.dateparse import DateParserPlugin
from whoosh.query import Every
from whoosh.searching import Hit
from whoosh.support.charset import accent_map

from helpers import get_env, is_valid_note_path, resolve_in_root
from logger import logger

from ..base import BaseNotes
from ..models import Note, NoteCreate, NoteUpdate, SearchResult

MARKDOWN_EXT = ".md"
INDEX_SCHEMA_VERSION = "6"

StemmingFoldingAnalyzer = StemmingAnalyzer() | CharsetFilter(accent_map)


class IndexSchema(SchemaClass):
    filename = ID(unique=True, stored=True)
    last_modified = DATETIME(stored=True, sortable=True)
    title = TEXT(
        field_boost=2.0, analyzer=StemmingFoldingAnalyzer, sortable=True
    )
    content = TEXT(analyzer=StemmingFoldingAnalyzer)
    tags = KEYWORD(lowercase=True, field_boost=2.0)


class FileSystemNotes(BaseNotes):
    TAGS_RE = re.compile(r"(?:(?<=^#)|(?<=\s#))[a-zA-Z0-9_-]+(?=\s|$)")
    CODEBLOCK_RE = re.compile(r"`{1,3}.*?`{1,3}", re.DOTALL)
    TAGS_WITH_HASH_RE = re.compile(
        r"(?:(?<=^)|(?<=\s))#[a-zA-Z0-9_-]+(?=\s|$)"
    )

    def __init__(self):
        self.storage_path = get_env("GLOBNOTES_PATH", mandatory=True)
        if not os.path.exists(self.storage_path):
            raise NotADirectoryError(
                f"'{self.storage_path}' is not a valid directory."
            )
        self.index = self._load_index()
        self._sync_lock = threading.Lock()
        self._syncing = False
        self._initial_sync_complete = False
        self._sync_done = 0
        self._sync_total = 0
        self._scan_cache = None

    @property
    def index_status(self) -> dict:
        return {
            "syncing": self._syncing,
            "initial": not self._initial_sync_complete,
            "done": self._sync_done,
            "total": self._sync_total,
        }

    def sync_index(self) -> None:
        """Synchronously run an incremental index sync (tests, manual)."""
        self._sync_index_with_retry()

    def start_background_sync(self) -> None:
        """Run the initial full index sync in a daemon thread so the web
        server can start serving immediately. The sync commits in batches
        (bounding RAM) and yields the lock between batches so user actions
        (saves, searches) preempt it."""
        def _run():
            self._syncing = True
            try:
                self._full_sync_batched()
                self._initial_sync_complete = True
                logger.info(
                    f"Initial index sync complete "
                    f"({self._sync_total} notes)"
                )
            except Exception as e:
                logger.error(f"Background index sync failed: {e}")
            finally:
                self._syncing = False

        threading.Thread(
            target=_run, daemon=True, name="index-sync"
        ).start()

    def _full_sync_batched(self) -> None:
        """Full sync in batches: prune/update phase in one writer, then the
        add-new phase in committed batches with a delay between them."""
        batch_size = int(
            os.environ.get("GLOBNOTES_INDEX_BATCH_SIZE", "200")
        )
        batch_delay = float(
            os.environ.get("GLOBNOTES_INDEX_BATCH_DELAY", "0.1")
        )

        with self._sync_lock:
            # Phase 1: prune deleted + update modified (bounded by index size)
            indexed = set()
            deleted = set()
            writer = self.index.writer()
            with self.index.searcher() as searcher:
                for idx_note in searcher.all_stored_fields():
                    idx_filename = idx_note["filename"]
                    idx_filepath = os.path.join(
                        self.storage_path, idx_filename
                    )
                    if not os.path.exists(idx_filepath):
                        writer.delete_by_term("filename", idx_filename)
                        deleted.add(idx_filename)
                    elif (
                        datetime.fromtimestamp(
                            os.path.getmtime(idx_filepath)
                        )
                        != idx_note["last_modified"]
                    ):
                        self._add_note_to_index(
                            writer, self._get_by_filename(idx_filename)
                        )
                    indexed.add(idx_filename)
            writer.commit()

        # Phase 2: add new in batches, yielding the lock between batches.
        # Breadth-first: shallow notes are indexed first so top-level
        # search becomes useful early. Phase 1 deletions and mid-sync
        # external deletions are skipped.
        new_files = [
            f
            for f in self._list_all_note_filenames()
            if f not in indexed and f not in deleted
        ]
        new_files.sort(key=lambda f: f.count("/"))
        self._sync_total = len(new_files)
        self._sync_done = 0
        for i in range(0, len(new_files), batch_size):
            batch = new_files[i : i + batch_size]
            with self._sync_lock:
                writer = self.index.writer()
                for filename in batch:
                    try:
                        self._add_note_to_index(
                            writer, self._get_by_filename(filename)
                        )
                    except FileNotFoundError:
                        continue
                writer.commit()
            self._sync_done += len(batch)
            if batch_delay > 0:
                time.sleep(batch_delay)

    def _reindex_note(self, title: str) -> None:
        """Immediately (re)index a single note — user saves preempt the
        background sync. Failures are logged, never raised: the note is
        already safely on disk and the next sync will catch up."""
        try:
            with self._sync_lock:
                writer = self.index.writer()
                self._add_note_to_index(
                    writer, self._get_by_filename(title + MARKDOWN_EXT)
                )
                writer.commit()
        except Exception as e:
            logger.warning(f"Failed to reindex '{title}': {e}")

    def _delete_from_index(self, title: str) -> None:
        try:
            with self._sync_lock:
                writer = self.index.writer()
                writer.delete_by_term("filename", title + MARKDOWN_EXT)
                writer.commit()
        except Exception as e:
            logger.warning(f"Failed to delete '{title}' from index: {e}")

    def create(self, data: NoteCreate) -> Note:
        """Create a new note."""
        filepath = self._path_from_title(data.title)
        try:
            os.makedirs(os.path.dirname(filepath), exist_ok=True)
            self._write_file(filepath, data.content)
        except (NotADirectoryError, IsADirectoryError) as e:
            raise FileExistsError(
                f"Failed to create '{data.title}': {e.strerror}"
            )
        self._reindex_note(data.title)
        self._invalidate_scan_cache()
        return Note(
            title=data.title,
            content=data.content,
            last_modified=os.path.getmtime(filepath),
        )

    def get(self, title: str) -> Note:
        """Get a specific note."""
        is_valid_note_path(title)
        filepath = self._path_from_title(title)
        content = self._read_file(filepath)
        return Note(
            title=title,
            content=content,
            last_modified=os.path.getmtime(filepath),
        )

    _LOCAL_REF_MD = re.compile(r"(!?\[[^\]]*\])\(\s*([^)\s]+)\s*\)")
    _LOCAL_REF_HTML = re.compile(r'src="([^"]+)"')

    def _classify_ref(
        self, url, old_dir, out, *, check_existence=True
    ):
        if url.startswith(("http://", "https://", "//", "#")):
            return
        root = self.storage_path
        if url.startswith("/"):
            rel = url.lstrip("/")
            kind = "absolute"
        elif url.startswith("../") or url.startswith("./"):
            old_rel = os.path.relpath(old_dir, root).replace("\\", "/")
            rel = (
                old_rel + "/"
                if old_rel != "."
                else ""
            ) + url
            rel = os.path.normpath(rel).replace("\\", "/")
            kind = "relative"
        else:
            old_rel = os.path.relpath(old_dir, root).replace("\\", "/")
            rel = (old_rel + "/" + url) if old_rel != "." else url
            kind = "same-folder"
        if check_existence:
            try:
                resolved = resolve_in_root(root, rel)
            except ValueError:
                return
            if not os.path.isfile(resolved):
                return
        out.append({"url": url, "path": rel, "kind": kind})

    def _scan_local_refs(
        self, content, old_dir, *, check_existence=True
    ):
        refs = []
        for m in self._LOCAL_REF_MD.finditer(content):
            self._classify_ref(
                m.group(2), old_dir, refs,
                check_existence=check_existence,
            )
        for m in self._LOCAL_REF_HTML.finditer(content):
            self._classify_ref(
                m.group(1), old_dir, refs,
                check_existence=check_existence,
            )
        return refs

    @staticmethod
    def _rebase_url(url, old_dir, new_dir, moved_files):
        if url.startswith(("http://", "https://", "//", "#")):
            return url

        if url.startswith("/"):
            target = url.lstrip("/")
        elif url.startswith("../") or url.startswith("./"):
            target = os.path.normpath(
                os.path.join(
                    "" if old_dir == "." else old_dir, url
                )
            ).replace("\\", "/")
        else:
            target = (old_dir + "/" + url) if old_dir else url

        target = moved_files.get(target, target)

        if not new_dir:
            return "/" + target if target else url
        new_parts = new_dir.split("/")
        target_parts = target.split("/")
        i = 0
        while (
            i < min(len(target_parts), len(new_parts))
            and target_parts[i] == new_parts[i]
        ):
            i += 1
        up = len(new_parts) - i
        rest = "/".join(target_parts[i:])
        if up == 0:
            return "./" + rest if rest and "/" not in rest else rest
        return "../" * up + rest

    @staticmethod
    def _resolve_ref_url(url, note_dir):
        if url.startswith("/"):
            return url.lstrip("/")
        if url.startswith("../") or url.startswith("./"):
            rel = os.path.normpath(
                os.path.join(note_dir.replace("\\", "/"), url)
            ).replace("\\", "/")
            return rel
        return (
            note_dir.replace("\\", "/") + "/" + url
            if note_dir != "."
            else url
        )

    def update(
        self, title: str, data: NoteUpdate, file_refs: str = "none"
    ) -> Note:
        """Update a specific note."""
        is_valid_note_path(title)
        old_title = title
        filepath = self._path_from_title(title)
        old_dir = os.path.dirname(filepath)
        moved_files = {}

        if data.new_title is not None and data.new_title != title:
            new_filepath = self._path_from_title(data.new_title)
            new_dir = os.path.dirname(new_filepath)

            if filepath != new_filepath and os.path.isfile(new_filepath):
                raise FileExistsError(
                    f"Failed to rename. '{data.new_title}' already exists."
                )

            action_refs = file_refs in ("move", "relink")
            if action_refs:
                current_content = (
                    data.new_content
                    if data.new_content is not None
                    else self._read_file(filepath)
                )
                refs = self._scan_local_refs(current_content, old_dir)

                if refs:
                    old_rel_dir = os.path.relpath(old_dir, self.storage_path).replace("\\", "/")
                    new_rel_dir = os.path.relpath(new_dir, self.storage_path).replace("\\", "/")
                    if old_rel_dir == ".":
                        old_rel_dir = ""
                    if new_rel_dir == ".":
                        new_rel_dir = ""

                    if file_refs == "move":
                        for r in refs:
                            if r["kind"] != "same-folder" and (
                                r["kind"] != "absolute"
                                or not r["path"].startswith(old_rel_dir + "/" if old_rel_dir else "")
                            ):
                                continue
                            old_file = os.path.join(
                                self.storage_path, r["path"]
                            )
                            # Preserve the subpath within the note's folder:
                            # recipes/assets/pic.png -> cooking/assets/pic.png
                            sub = (
                                r["path"][len(old_rel_dir) :].lstrip("/")
                                if old_rel_dir
                                else r["path"]
                            )
                            new_rel = (
                                new_rel_dir + "/" + sub if new_rel_dir else sub
                            )
                            new_file = os.path.join(
                                self.storage_path, new_rel
                            )
                            try:
                                os.makedirs(os.path.dirname(new_file), exist_ok=True)
                                shutil.move(old_file, new_file)
                                moved_files[r["path"]] = new_rel
                            except OSError:
                                continue

                    content_written = current_content
                    for r in refs:
                        new_url = self._rebase_url(
                            r["url"], old_rel_dir, new_rel_dir, moved_files
                        )
                        if new_url == r["url"]:
                            continue
                        content_written = re.sub(
                            r"(!?\[[^\]]*\])\(\s*"
                            + re.escape(r["url"])
                            + r"\s*\)",
                            r"\1(" + new_url + ")",
                            content_written,
                        )
                        content_written = re.sub(
                            r'src="' + re.escape(r["url"]) + r'"',
                            f'src="{new_url}"',
                            content_written,
                        )
                    if data.new_content is not None:
                        data.new_content = content_written
                    else:
                        current_content = content_written

            try:
                os.makedirs(new_dir, exist_ok=True)
                os.rename(filepath, new_filepath)
            except (NotADirectoryError, IsADirectoryError) as e:
                raise FileExistsError(
                    f"Failed to rename to '{data.new_title}': {e.strerror}"
                )
            self._prune_empty_parents(old_dir)
            if action_refs and refs:
                self._write_file(
                    new_filepath, current_content, overwrite=True
                )
            title = data.new_title
            filepath = new_filepath

        if data.new_content is not None:
            self._write_file(filepath, data.new_content, overwrite=True)
            content = data.new_content
        else:
            content = self._read_file(filepath)

        moved = [
            {"oldPath": old, "newPath": new}
            for old, new in moved_files.items()
        ]
        if old_title != title:
            self._delete_from_index(old_title)
        self._reindex_note(title)
        self._invalidate_scan_cache()
        return Note(
            title=title,
            content=content,
            last_modified=os.path.getmtime(filepath),
            moved_files=moved,
        )

    def preview_rename(
        self, title: str, new_title: str
    ) -> list[dict]:
        is_valid_note_path(title)
        is_valid_note_path(new_title)
        filepath = self._path_from_title(title)
        old_dir = os.path.dirname(filepath)
        content = self._read_file(filepath)
        return self._scan_local_refs(content, old_dir)

    def rewrite_refs(self, old_path: str, new_path: str):
        root = self.storage_path
        fname = old_path.rsplit("/", 1)[-1]

        for filepath in glob.iglob(
            os.path.join(glob.escape(root), "**", "*.md"), recursive=True
        ):
            content = self._read_file(filepath)
            if fname not in content:
                continue

            note_dir = os.path.dirname(filepath)
            refs = self._scan_local_refs(
                content, note_dir, check_existence=False
            )
            changed = False
            note_rel = os.path.relpath(note_dir, root).replace("\\", "/")
            for r in refs:
                if r["path"] != old_path:
                    continue
                new_url = self._rebase_url(
                    r["url"],
                    note_rel,
                    note_rel,
                    {old_path: new_path},
                )
                if new_url == r["url"]:
                    continue
                content = re.sub(
                    r"(!?\[[^\]]*\])\(\s*"
                    + re.escape(r["url"])
                    + r"\s*\)",
                    r"\1(" + new_url + ")",
                    content,
                )
                content = re.sub(
                    r'src="' + re.escape(r["url"]) + r'"',
                    f'src="{new_url}"',
                    content,
                )
                changed = True

            if changed:
                self._write_file(filepath, content, overwrite=True)

    def delete(self, title: str) -> None:
        """Delete a specific note."""
        is_valid_note_path(title)
        filepath = self._path_from_title(title)
        os.remove(filepath)
        self._prune_empty_parents(os.path.dirname(filepath))
        self._delete_from_index(title)
        self._invalidate_scan_cache()

    def search(
        self,
        term: str,
        sort: Literal["score", "title", "last_modified"] = "score",
        order: Literal["asc", "desc"] = "desc",
        limit: int = None,
        nested: bool = True,
        folder: str = None,
    ) -> Tuple[SearchResult, ...]:
        """Search the index for the given term. When nested is False, only
        root-level notes are included. When folder is given, only notes
        under that folder path are included."""
        if self._initial_sync_complete:
            self._sync_index_with_retry()
        term = self._pre_process_search_term(term)
        with self.index.searcher() as searcher:
            # Parse Query
            if term == "*":
                query = Every()
            else:
                parser = MultifieldParser(
                    self._fieldnames_for_term(term), self.index.schema
                )
                parser.add_plugin(DateParserPlugin())
                query = parser.parse(term)

            # Determine Sort By
            # Note: For the 'sort' option, "score" is converted to None as
            # that is the default for searches anyway and it's quicker for
            # Whoosh if you specify None.
            sort = sort if sort in ["title", "last_modified"] else None

            # Determine Sort Direction
            # Note: Confusingly, when sorting by 'score', reverse = True means
            # asc so we have to flip the logic for that case!
            reverse = order == "desc"
            if sort is None:
                reverse = not reverse

            # Run Search
            # When filtering (by nested and/or folder), fetch without a
            # limit and apply the limit after filtering.
            fetch_limit = limit if (nested and folder is None) else None
            results = searcher.search(
                query,
                sortedby=sort,
                reverse=reverse,
                limit=fetch_limit,
                terms=True,
            )
            hits = [
                hit
                for hit in results
                if self._in_scope(hit["filename"], folder, nested)
            ]
            if limit is not None:
                hits = hits[:limit]
            return tuple(self._search_result_from_hit(hit) for hit in hits)

    @staticmethod
    def _in_scope(filename: str, folder: str, nested: bool) -> bool:
        """Return True if the note filename is inside the search scope:
        optionally under the given folder, and optionally only directly at
        that level (nested=False means no deeper subdirectories)."""
        title = filename[: -len(MARKDOWN_EXT)]
        if folder is not None:
            if not (title == folder or title.startswith(folder + "/")):
                return False
        if not nested:
            rest = title[len(folder) + 1 :] if folder else title
            if "/" in rest:
                return False
        return True

    def get_tags(self) -> list[str]:
        """Return a list of all indexed tags. Note: Tags no longer in use will
        only be cleared when the index is next optimized."""
        if self._initial_sync_complete:
            self._sync_index_with_retry()
        with self.index.reader() as reader:
            tags = reader.field_terms("tags")
            return [tag for tag in tags]

    def get_titles(self) -> list[str]:
        """Return a list of all note titles (paths relative to the storage
        root, without extension). Always fresh (read from the filesystem,
        not the index)."""
        return [
            self._strip_ext(filename)
            for filename in self._list_all_note_filenames()
        ]

    @property
    def _index_path(self):
        return os.path.join(self.storage_path, ".globnotes")

    def _path_from_title(self, title: str) -> str:
        return resolve_in_root(self.storage_path, title + MARKDOWN_EXT)

    def _prune_empty_parents(self, dirpath: str) -> None:
        """Remove empty parent directories up to (but excluding) the storage
        root. Stops at the first non-empty or non-removable directory (e.g. a
        mount point)."""
        root = os.path.realpath(self.storage_path)
        dirpath = os.path.realpath(dirpath)
        while dirpath != root and os.path.commonpath([root, dirpath]) == root:
            try:
                os.rmdir(dirpath)
            except OSError:
                break
            dirpath = os.path.dirname(dirpath)

    def _get_by_filename(self, filename: str) -> Note:
        """Get a note by its filename."""
        return self.get(self._strip_ext(filename))

    def _load_index(self) -> Index:
        """Load the note index or create new if not exists."""
        index_dir_exists = os.path.exists(self._index_path)
        if index_dir_exists and whoosh.index.exists_in(
            self._index_path, indexname=INDEX_SCHEMA_VERSION
        ):
            logger.info("Loading existing index")
            return whoosh.index.open_dir(
                self._index_path, indexname=INDEX_SCHEMA_VERSION
            )
        else:
            if index_dir_exists:
                logger.info("Deleting outdated index")
                self._clear_dir(self._index_path)
            else:
                os.mkdir(self._index_path)
            logger.info("Creating new index")
            return whoosh.index.create_in(
                self._index_path, IndexSchema, indexname=INDEX_SCHEMA_VERSION
            )

    @classmethod
    def _extract_tags(cls, content) -> Tuple[str, Set[str]]:
        """Strip tags from the given content and return a tuple consisting of:

        - The content without the tags.
        - A set of tags converted to lowercase."""
        content_ex_codeblock = re.sub(cls.CODEBLOCK_RE, "", content)
        _, tags = cls._re_extract(cls.TAGS_RE, content_ex_codeblock)
        content_ex_tags, _ = cls._re_extract(cls.TAGS_RE, content)
        try:
            tags = [tag.lower() for tag in tags]
            return (content_ex_tags, set(tags))
        except IndexError:
            return (content, set())

    def _add_note_to_index(
        self, writer: writing.IndexWriter, note: Note
    ) -> None:
        """Add a Note object to the index using the given writer. If the
        filename already exists in the index an update will be performed
        instead."""
        content_ex_tags, tag_set = self._extract_tags(note.content)
        tag_string = " ".join(tag_set)
        writer.update_document(
            filename=note.title + MARKDOWN_EXT,
            last_modified=datetime.fromtimestamp(note.last_modified),
            title=note.title,
            content=content_ex_tags,
            tags=tag_string,
        )

    def _list_all_note_filenames(self) -> List[str]:
        """Return a list of all note filenames, relative to the storage
        path. Hidden directories (such as the index directory) are
        skipped. Cached briefly: a full recursive scan is expensive on
        large vaults; our own writes invalidate immediately."""
        ttl = float(os.environ.get("GLOBNOTES_SCAN_CACHE_TTL", "15"))
        now = time.monotonic()
        if (
            self._scan_cache is not None
            and now - self._scan_cache[0] < ttl
        ):
            return self._scan_cache[1]
        filenames = [
            os.path.relpath(filepath, self.storage_path)
            for filepath in glob.glob(
                os.path.join(self.storage_path, "**/*" + MARKDOWN_EXT),
                recursive=True,
            )
        ]
        self._scan_cache = (now, filenames)
        return filenames

    def _invalidate_scan_cache(self) -> None:
        self._scan_cache = None

    def list_level(self, path: str = "") -> dict:
        """List the immediate children (folders and notes) of one directory
        level — the lazy sidebar tree. One scandir per call: fast even on
        large vaults, and user-expanded folders are fetched on demand."""
        if path:
            is_valid_note_path(path)
            dirpath = resolve_in_root(self.storage_path, path)
        else:
            dirpath = self.storage_path
        if not os.path.isdir(dirpath):
            raise FileNotFoundError(f"'{path}' is not a directory")
        folders, notes = [], []
        with os.scandir(dirpath) as it:
            for entry in it:
                if entry.name.startswith("."):
                    continue
                if entry.is_dir(follow_symlinks=False):
                    child_path = (
                        os.path.join(path, entry.name) if path else entry.name
                    )
                    folders.append({"name": entry.name, "path": child_path})
                elif entry.name.endswith(MARKDOWN_EXT):
                    title = entry.name[: -len(MARKDOWN_EXT)]
                    notes.append(
                        os.path.join(path, title) if path else title
                    )
        return {
            "folders": sorted(folders, key=lambda f: f["name"]),
            "notes": sorted(notes),
        }

    def _sync_index(self, optimize: bool = False, clean: bool = False) -> None:
        """Synchronize the index with the notes directory.
        Specify clean=True to completely rebuild the index"""
        indexed = set()
        deleted = set()
        writer = self.index.writer()
        if clean:
            writer.mergetype = writing.CLEAR  # Clear the index
        with self.index.searcher() as searcher:
            for idx_note in searcher.all_stored_fields():
                idx_filename = idx_note["filename"]
                idx_filepath = os.path.join(self.storage_path, idx_filename)
                # Delete missing
                if not os.path.exists(idx_filepath):
                    writer.delete_by_term("filename", idx_filename)
                    deleted.add(idx_filename)
                    logger.info(f"'{idx_filename}' removed from index")
                # Update modified
                elif (
                    datetime.fromtimestamp(os.path.getmtime(idx_filepath))
                    != idx_note["last_modified"]
                ):
                    logger.info(f"'{idx_filename}' updated")
                    self._add_note_to_index(
                        writer, self._get_by_filename(idx_filename)
                    )
                    indexed.add(idx_filename)
                # Ignore already indexed
                else:
                    indexed.add(idx_filename)
        # Add new — skip anything phase 1 just deleted (the scan cache may
        # still list it), and tolerate files deleted mid-sync.
        for filename in self._list_all_note_filenames():
            if filename not in indexed and filename not in deleted:
                try:
                    self._add_note_to_index(
                        writer, self._get_by_filename(filename)
                    )
                    logger.info(f"'{filename}' added to index")
                except FileNotFoundError:
                    continue
        writer.commit(optimize=optimize)
        logger.info("Index synchronized")

    def _sync_index_with_retry(
        self,
        optimize: bool = False,
        clean: bool = False,
        max_retries: int = 8,
        retry_delay: float = 0.25,
    ) -> None:
        for _ in range(max_retries):
            try:
                self._sync_index(optimize=optimize, clean=clean)
                return
            except LockError:
                logger.warning(f"Index locked, retrying in {retry_delay}s")
                time.sleep(retry_delay)
        logger.error(f"Failed to sync index after {max_retries} retries")

    @classmethod
    def _pre_process_search_term(cls, term):
        term = term.strip()
        # Replace "#tagname" with "tags:tagname"
        term = re.sub(
            cls.TAGS_WITH_HASH_RE,
            lambda tag: "tags:" + tag.group(0)[1:],
            term,
        )
        return term

    @staticmethod
    def _re_extract(pattern, string) -> Tuple[str, List[str]]:
        """Similar to re.sub but returns a tuple of:

        - `string` with matches removed
        - list of matches"""
        matches = []
        text = re.sub(pattern, lambda tag: matches.append(tag.group()), string)
        return (text, matches)

    @staticmethod
    def _strip_ext(filename):
        """Return the given filename without the extension."""
        return os.path.splitext(filename)[0]

    @staticmethod
    def _clear_dir(path):
        """Delete all contents of the given directory."""
        for item in os.listdir(path):
            item_path = os.path.join(path, item)
            if os.path.isfile(item_path):
                os.remove(item_path)
            elif os.path.isdir(item_path):
                shutil.rmtree(item_path)

    def _search_result_from_hit(self, hit: Hit):
        matched_fields = self._get_matched_fields(hit.matched_terms())

        title = self._strip_ext(hit["filename"])
        last_modified = hit["last_modified"].timestamp()

        # If the search was ordered using a text field then hit.score is the
        # value of that field. This isn't useful so only set self._score if it
        # is a float.
        score = hit.score if type(hit.score) is float else None

        if "title" in matched_fields:
            hit.results.fragmenter = WholeFragmenter()
            title_highlights = hit.highlights("title", text=title)
        else:
            title_highlights = None

        if "content" in matched_fields:
            hit.results.fragmenter = ContextFragmenter()
            content = self._read_file(self._path_from_title(title))
            content_ex_tags, _ = FileSystemNotes._extract_tags(content)
            content_highlights = hit.highlights(
                "content",
                text=content_ex_tags,
            )
        else:
            content_highlights = None

        tag_matches = (
            [field[1] for field in hit.matched_terms() if field[0] == "tags"]
            if "tags" in matched_fields
            else None
        )

        return SearchResult(
            title=title,
            last_modified=last_modified,
            score=score,
            title_highlights=title_highlights,
            content_highlights=content_highlights,
            tag_matches=tag_matches,
        )

    def _fieldnames_for_term(self, term: str) -> List[str]:
        """Return a list of field names to search based on the given term. If
        the term includes a phrase then only search title and content. If the
        term does not include a phrase then also search tags."""
        fields = ["title", "content"]
        if '"' not in term:
            # If the term does not include a phrase then also search tags
            fields.append("tags")
        return fields

    @staticmethod
    def _get_matched_fields(matched_terms):
        """Return a set of matched fields from a set of ('field', 'term') "
        "tuples generated by whoosh.searching.Hit.matched_terms()."""
        return set([matched_term[0] for matched_term in matched_terms])

    @staticmethod
    def _read_file(filepath: str):
        logger.debug(f"Reading from '{filepath}'")
        with open(filepath, "r") as f:
            content = f.read()
        return content

    @staticmethod
    def _write_file(filepath: str, content: str, overwrite: bool = False):
        logger.debug(f"Writing to '{filepath}'")
        with open(filepath, "w" if overwrite else "x") as f:
            f.write(content)
