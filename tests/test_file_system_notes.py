import os

import pytest

from notes.models import NoteCreate, NoteUpdate


class TestCreate:
    def test_creates_nested_note_with_directories(self, notes):
        note = notes.create(NoteCreate(title="a/b/c", content="hello"))
        assert note.title == "a/b/c"
        filepath = os.path.join(notes.storage_path, "a", "b", "c.md")
        with open(filepath) as f:
            assert f.read() == "hello"

    def test_duplicate_raises(self, notes):
        notes.create(NoteCreate(title="a/b", content="one"))
        with pytest.raises(FileExistsError):
            notes.create(NoteCreate(title="a/b", content="two"))

    def test_file_blocking_path_segment_raises_file_exists(self, notes):
        with open(os.path.join(notes.storage_path, "blocker"), "w") as f:
            f.write("plain file, not a note")
        with pytest.raises(FileExistsError):
            notes.create(NoteCreate(title="blocker/note", content="x"))

    def test_directory_named_like_note_file_raises_file_exists(self, notes):
        os.makedirs(os.path.join(notes.storage_path, "a.md"))
        with pytest.raises(FileExistsError):
            notes.create(NoteCreate(title="a", content="x"))


class TestGet:
    def test_get_nested_note(self, notes):
        notes.create(NoteCreate(title="dad/recipes/soup", content="yum"))
        note = notes.get("dad/recipes/soup")
        assert note.content == "yum"

    def test_get_missing_raises_not_found(self, notes):
        with pytest.raises(FileNotFoundError):
            notes.get("no/such/note")

    def test_get_rejects_traversal(self, notes):
        with pytest.raises(ValueError):
            notes.get("../../etc/passwd")


class TestUpdate:
    def test_rename_moves_across_directories(self, notes):
        notes.create(NoteCreate(title="a/b", content="content"))
        note = notes.update("a/b", NoteUpdate(new_title="x/y/z"))
        assert note.title == "x/y/z"
        assert not os.path.exists(
            os.path.join(notes.storage_path, "a", "b.md")
        )
        with open(os.path.join(notes.storage_path, "x", "y", "z.md")) as f:
            assert f.read() == "content"

    def test_rename_prunes_empty_old_parents(self, notes):
        notes.create(NoteCreate(title="a/b/c", content="x"))
        notes.update("a/b/c", NoteUpdate(new_title="d"))
        assert not os.path.exists(os.path.join(notes.storage_path, "a"))

    def test_rename_keeps_non_empty_old_parents(self, notes):
        notes.create(NoteCreate(title="a/b/c", content="x"))
        notes.create(NoteCreate(title="a/other", content="y"))
        notes.update("a/b/c", NoteUpdate(new_title="d"))
        assert os.path.isdir(os.path.join(notes.storage_path, "a"))
        assert not os.path.exists(
            os.path.join(notes.storage_path, "a", "b")
        )

    def test_rename_to_existing_raises(self, notes):
        notes.create(NoteCreate(title="a", content="1"))
        notes.create(NoteCreate(title="b/c", content="2"))
        with pytest.raises(FileExistsError):
            notes.update("a", NoteUpdate(new_title="b/c"))

    def test_update_content_only(self, notes):
        notes.create(NoteCreate(title="a/b", content="old"))
        note = notes.update("a/b", NoteUpdate(new_content="new"))
        assert note.content == "new"


class TestDelete:
    def test_delete_prunes_empty_parents(self, notes):
        notes.create(NoteCreate(title="x/y/z", content="x"))
        notes.delete("x/y/z")
        assert not os.path.exists(os.path.join(notes.storage_path, "x"))
        assert os.path.isdir(notes.storage_path)

    def test_delete_tolerates_unremovable_parent(self, notes, monkeypatch):
        notes.create(NoteCreate(title="mounted/note", content="x"))
        real_rmdir = os.rmdir

        def fake_rmdir(path):
            if os.path.basename(path) == "mounted":
                raise OSError(16, "Device or resource busy")
            return real_rmdir(path)

        monkeypatch.setattr(os, "rmdir", fake_rmdir)
        notes.delete("mounted/note")  # must not raise
        assert os.path.isdir(os.path.join(notes.storage_path, "mounted"))


class TestIndexAndSearch:
    def test_external_nested_files_are_indexed(self, notes):
        os.makedirs(os.path.join(notes.storage_path, "x", "y"))
        with open(
            os.path.join(notes.storage_path, "x", "y", "z.md"), "w"
        ) as f:
            f.write("external content")
        titles = [r.title for r in notes.search("*")]
        assert "x/y/z" in titles

    def test_hidden_index_dir_is_not_indexed(self, notes):
        notes.create(NoteCreate(title="real/note", content="x"))
        titles = [r.title for r in notes.search("*")]
        assert all(not title.startswith(".") for title in titles)

    def test_search_matches_path_segment(self, notes):
        notes.create(
            NoteCreate(title="school/quicknote", content="nothing special")
        )
        results = notes.search("school")
        assert any(r.title == "school/quicknote" for r in results)

    def test_external_delete_is_removed_from_index(self, notes):
        notes.create(NoteCreate(title="gone/soon", content="x"))
        notes.search("*")  # ensure it is indexed
        os.remove(os.path.join(notes.storage_path, "gone", "soon.md"))
        titles = [r.title for r in notes.search("*")]
        assert "gone/soon" not in titles

    def test_tags_still_work(self, notes):
        notes.create(NoteCreate(title="a/b", content="has #taggy inside"))
        assert "taggy" in notes.get_tags()
