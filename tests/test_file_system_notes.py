import os
import time

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


class TestPriorityReindex:
    def test_create_is_searchable_without_any_sync(self, notes):
        notes._initial_sync_complete = False
        notes.create(NoteCreate(title="fresh/note", content="needle"))
        results = notes.search("needle")
        assert any(r.title == "fresh/note" for r in results)

    def test_delete_is_unsearchable_without_any_sync(self, notes):
        notes._initial_sync_complete = False
        notes.create(NoteCreate(title="gone/note", content="needle"))
        notes.delete("gone/note")
        results = notes.search("needle")
        assert not any(r.title == "gone/note" for r in results)

    def test_rename_removes_old_title_from_index(self, notes):
        notes._initial_sync_complete = False
        notes.create(NoteCreate(title="old/name", content="needle"))
        notes.update("old/name", NoteUpdate(new_title="new/name"))
        results = notes.search("needle")
        titles = [r.title for r in results]
        assert "new/name" in titles
        assert "old/name" not in titles


class TestBackgroundSync:
    def test_background_sync_completes_and_indexes(self, notes):
        notes._initial_sync_complete = False
        # Write a note directly on disk (no API, so no priority reindex)
        path = os.path.join(notes.storage_path, "ext", "note.md")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("external needle")
        notes.start_background_sync()
        for _ in range(100):
            if notes._initial_sync_complete:
                break
            time.sleep(0.05)
        assert notes._initial_sync_complete
        results = notes.search("external needle")
        assert any(r.title == "ext/note" for r in results)

    def test_index_status_shape(self, notes):
        status = notes.index_status
        assert set(status) == {"syncing", "initial", "done", "total"}
        assert status["initial"] is False  # fixture marks sync complete


class TestScanCache:
    def test_consecutive_title_reads_scan_once(self, notes, monkeypatch):
        import glob as glob_module

        calls = {"n": 0}
        real_glob = glob_module.glob

        def counting_glob(*args, **kwargs):
            calls["n"] += 1
            return real_glob(*args, **kwargs)

        monkeypatch.setattr(glob_module, "glob", counting_glob)
        notes.get_titles()
        notes.get_titles()
        assert calls["n"] == 1

    def test_create_invalidates_the_cache(self, notes, monkeypatch):
        import glob as glob_module

        calls = {"n": 0}
        real_glob = glob_module.glob

        def counting_glob(*args, **kwargs):
            calls["n"] += 1
            return real_glob(*args, **kwargs)

        monkeypatch.setattr(glob_module, "glob", counting_glob)
        notes.get_titles()
        notes.create(NoteCreate(title="new/note", content="x"))
        titles = notes.get_titles()
        assert "new/note" in titles
        assert calls["n"] == 2


class TestRenameStrategies:
    @pytest.fixture
    def note_with_images(self, notes):
        old_dir = os.path.join(notes.storage_path, "recipes")
        os.makedirs(old_dir, exist_ok=True)
        img = os.path.join(old_dir, "soup.png")
        with open(img, "w") as f:
            f.write("image1")
        shared = os.path.join(old_dir, "shared.png")
        with open(shared, "w") as f:
            f.write("image2")
        content = "look at the soup ![soup](soup.png) and also [shared](shared.png)"
        notes.create(NoteCreate(title="recipes/soup", content=content))
        return notes

    def test_preview_rename(self, note_with_images):
        refs = note_with_images.preview_rename(
            "recipes/soup", "cooking/soup"
        )
        assert len(refs) == 2
        kinds = {r["kind"] for r in refs}
        assert kinds == {"same-folder"}

    def test_move_strategy(self, note_with_images):
        note = note_with_images.update(
            "recipes/soup",
            NoteUpdate(new_title="cooking/soup"),
            file_refs="move",
        )
        assert note.moved_files
        old_img = os.path.join(
            note_with_images.storage_path, "recipes", "soup.png"
        )
        new_img = os.path.join(
            note_with_images.storage_path, "cooking", "soup.png"
        )
        assert not os.path.isfile(old_img)
        assert os.path.isfile(new_img)
        assert "soup.png" in note.content
        assert "shared.png" in note.content

    def test_relink_strategy(self, note_with_images):
        note = note_with_images.update(
            "recipes/soup",
            NoteUpdate(new_title="cooking/soup"),
            file_refs="relink",
        )
        old_img = os.path.join(
            note_with_images.storage_path, "recipes", "soup.png"
        )
        assert os.path.isfile(old_img)
        assert "../recipes/soup.png" in note.content
        assert "../recipes/shared.png" in note.content

    def test_none_strategy(self, note_with_images):
        note = note_with_images.update(
            "recipes/soup",
            NoteUpdate(new_title="cooking/soup"),
            file_refs="none",
        )
        assert "soup.png" in note.content
        assert "shared.png" in note.content

    def test_move_preserves_subdirectory_structure(self, notes):
        # note references an image in a SUBDIRECTORY of its folder
        assets = os.path.join(notes.storage_path, "recipes", "assets")
        os.makedirs(assets, exist_ok=True)
        with open(os.path.join(assets, "pic.png"), "w") as f:
            f.write("image")
        notes.create(
            NoteCreate(
                title="recipes/soup", content="![pic](assets/pic.png)"
            )
        )
        note = notes.update(
            "recipes/soup",
            NoteUpdate(new_title="cooking/soup"),
            file_refs="move",
        )
        # the file keeps its subpath under the note's new folder
        assert os.path.isfile(
            os.path.join(
                notes.storage_path, "cooking", "assets", "pic.png"
            )
        )
        assert not os.path.exists(
            os.path.join(notes.storage_path, "recipes", "assets", "pic.png")
        )
        # and the link still points at the assets/ subpath
        assert "assets/pic.png" in note.content

    def test_rewrite_refs(self, note_with_images):
        note_with_images.create(
            NoteCreate(
                title="other/page",
                content="links to old ![soup](/recipes/soup.png)",
            )
        )
        note_with_images.update(
            "recipes/soup",
            NoteUpdate(new_title="cooking/soup"),
            file_refs="move",
        )
        note_with_images.rewrite_refs(
            "recipes/soup.png", "cooking/soup.png"
        )
        other = note_with_images.get("other/page")
        assert "/recipes/soup.png" not in other.content
        assert "cooking/soup.png" in other.content
