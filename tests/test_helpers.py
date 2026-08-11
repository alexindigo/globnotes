import os

import pytest

from helpers import is_valid_note_path, resolve_in_root


class TestIsValidNotePath:
    @pytest.mark.parametrize(
        "title",
        [
            "note",
            "My Note",
            "a/b",
            "a/b/c/d/e",
            "dad/recipes/soup",
            "émojis🎉/ok",
            " spaces ok /inside ",
        ],
    )
    def test_valid(self, title):
        assert is_valid_note_path(title) == title

    @pytest.mark.parametrize(
        "title",
        [
            "",
            "a//b",
            "/a",
            "a/",
            "./a",
            "a/./b",
            "..",
            "../a",
            "a/../b",
            "a/b/..",
            ".hidden",
            "a/.hidden",
            "a/.hidden/b",
            "a<b",
            "a>b",
            "a:b",
            'a"b',
            "a\\b",
            "a|b",
            "a?b",
            "a*b",
            "a" * 256,
            "ok/" + "a" * 256,
        ],
    )
    def test_invalid(self, title):
        with pytest.raises(ValueError):
            is_valid_note_path(title)

    def test_segment_of_exactly_255_bytes_is_valid(self):
        assert is_valid_note_path("a" * 255 + "/b")


class TestResolveInRoot:
    def test_resolves_inside_root(self, tmp_path):
        resolved = resolve_in_root(str(tmp_path), "a/b/c.md")
        expected = os.path.join(os.path.realpath(tmp_path), "a", "b", "c.md")
        assert resolved == expected

    def test_rejects_traversal(self, tmp_path):
        with pytest.raises(ValueError):
            resolve_in_root(str(tmp_path), "../escape.md")

    def test_rejects_symlink_escape(self, tmp_path):
        external = tmp_path / "external"
        external.mkdir()
        root = tmp_path / "root"
        root.mkdir()
        (root / "link").symlink_to(external, target_is_directory=True)
        with pytest.raises(ValueError):
            resolve_in_root(str(root), "link/note.md")

    def test_allows_symlink_that_stays_inside(self, tmp_path):
        root = tmp_path / "root"
        (root / "real").mkdir(parents=True)
        (root / "link").symlink_to(root / "real", target_is_directory=True)
        resolved = resolve_in_root(str(root), "link/note.md")
        assert resolved == str(root / "real" / "note.md")
