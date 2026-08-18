import os

import pytest


@pytest.fixture()
def tree_vault(tmp_path, monkeypatch):
    """A vault with a nested structure for tree endpoint tests."""
    monkeypatch.setenv("GLOBNOTES_PATH", str(tmp_path))
    monkeypatch.setenv("GLOBNOTES_AUTH_TYPE", "none")
    for rel in [
        "alpha/one.md",
        "alpha/two.md",
        "alpha/deep/three.md",
        "beta/four.md",
        "root-note.md",
        ".hidden/secret.md",
    ]:
        path = os.path.join(tmp_path, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("# x")
    import sys

    sys.modules.pop("main", None)
    import main
    from fastapi.testclient import TestClient

    return TestClient(main.app)


class TestTreeEndpoint:
    def test_root_level_returns_immediate_children_only(self, tree_vault):
        response = tree_vault.get("/_/api/tree")
        assert response.status_code == 200
        body = response.json()
        assert [f["path"] for f in body["folders"]] == ["alpha", "beta"]
        assert all(f["hasChildren"] for f in body["folders"])
        assert body["notes"] == ["root-note"]

    def test_subfolder_level_returns_its_children(self, tree_vault):
        response = tree_vault.get("/_/api/tree", params={"path": "alpha"})
        assert response.status_code == 200
        body = response.json()
        assert [f["path"] for f in body["folders"]] == ["alpha/deep"]
        assert body["folders"][0]["hasChildren"] is True
        assert sorted(body["notes"]) == ["alpha/one", "alpha/two"]

    def test_hidden_dirs_are_skipped(self, tree_vault):
        body = tree_vault.get("/_/api/tree").json()
        assert not any(f["name"].startswith(".") for f in body["folders"])
        assert not any(n.startswith(".") for n in body["notes"])

    def test_missing_folder_is_404(self, tree_vault):
        response = tree_vault.get("/_/api/tree", params={"path": "nope"})
        assert response.status_code == 404

    def test_traversal_is_rejected(self, tree_vault):
        response = tree_vault.get("/_/api/tree", params={"path": "../.."})
        assert response.status_code in (400, 404)
