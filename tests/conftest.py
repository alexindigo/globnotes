import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if os.path.join(REPO_ROOT, "server") not in sys.path:
    sys.path.insert(0, os.path.join(REPO_ROOT, "server"))


def _ensure_client_dist():
    """main.py requires client/dist/index.html at import time (base href
    replacement and the StaticFiles mount). Create a minimal stand-in if the
    real build output is absent. The directory is gitignored."""
    dist = os.path.join(REPO_ROOT, "client", "dist")
    index = os.path.join(dist, "index.html")
    if not os.path.exists(index):
        os.makedirs(dist, exist_ok=True)
        with open(index, "w", encoding="utf-8") as f:
            f.write(
                '<!doctype html><html><head><base href="/"></head>'
                "<body></body></html>"
            )


_ensure_client_dist()


@pytest.fixture()
def notes(tmp_path, monkeypatch):
    """A FileSystemNotes instance backed by a temporary directory."""
    monkeypatch.setenv("GLOBNOTES_PATH", str(tmp_path))
    from notes.file_system import FileSystemNotes

    return FileSystemNotes()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """A TestClient with a fresh app instance backed by a temporary
    directory, with auth disabled."""
    monkeypatch.setenv("GLOBNOTES_PATH", str(tmp_path))
    monkeypatch.setenv("GLOBNOTES_AUTH_TYPE", "none")
    sys.modules.pop("main", None)
    import main
    from fastapi.testclient import TestClient

    return TestClient(main.app)
