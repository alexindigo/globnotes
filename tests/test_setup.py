import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

AUTH_ENV_VARS = (
    "GLOBNOTES_USERNAME",
    "GLOBNOTES_PASSWORD",
    "GLOBNOTES_SECRET_KEY",
    "GLOBNOTES_TOTP_KEY",
)


def _fresh_client(tmp_path, monkeypatch, auth_type=None):
    """A TestClient with a fresh app instance. When auth_type is None, no
    auth env vars are set at all (first-run setup mode)."""
    monkeypatch.setenv("GLOBNOTES_PATH", str(tmp_path))
    if auth_type is None:
        monkeypatch.delenv("GLOBNOTES_AUTH_TYPE", raising=False)
        for var in AUTH_ENV_VARS:
            monkeypatch.delenv(var, raising=False)
    else:
        monkeypatch.setenv("GLOBNOTES_AUTH_TYPE", auth_type)
    sys.modules.pop("main", None)
    import main

    return TestClient(main.app)


@pytest.fixture()
def setup_client(tmp_path, monkeypatch):
    return _fresh_client(tmp_path, monkeypatch, auth_type=None)


class TestSetupMode:
    def test_setup_status_reports_required(self, setup_client):
        response = setup_client.get("/_/api/setup")
        assert response.status_code == 200
        assert response.json()["setupRequired"] is True

    def test_config_reports_setup_required(self, setup_client):
        response = setup_client.get("/_/api/config")
        assert response.json()["setupRequired"] is True
        assert response.json()["authType"] is None

    def test_data_apis_return_503_until_setup(self, setup_client):
        assert setup_client.get("/_/api/notes/a/b").status_code == 503
        assert (
            setup_client.get("/_/api/search", params={"term": "*"}).status_code
            == 503
        )
        assert (
            setup_client.post(
                "/_/api/notes", json={"title": "a", "content": "x"}
            ).status_code
            == 503
        )
        assert setup_client.get("/a.jpg").status_code == 503
        assert setup_client.get("/_/api/tags").status_code == 503
        assert setup_client.get("/_/api/note-index").status_code == 503

    def test_read_only_flow(self, setup_client, tmp_path):
        response = setup_client.post("/_/api/setup", json={"mode": "read_only"})
        assert response.status_code == 200
        assert response.json()["setupRequired"] is False
        # Reads work
        assert setup_client.get("/_/api/notes/a/b").status_code == 404
        assert (
            setup_client.get(
                "/_/api/search", params={"term": "*"}
            ).status_code
            == 200
        )
        # Writes are rejected with 403, without a restart
        assert (
            setup_client.post(
                "/_/api/notes", json={"title": "a/b", "content": "x"}
            ).status_code
            == 403
        )
        assert (
            setup_client.patch(
                "/_/api/notes/a/b", json={"newContent": "y"}
            ).status_code
            == 403
        )
        assert setup_client.delete("/_/api/notes/a/b").status_code == 403
        assert (
            setup_client.post(
                "/_/api/files",
                files={"file": ("a.png", b"p", "image/png")},
            ).status_code
            == 403
        )
        # The choice is persisted
        config_path = os.path.join(
            str(tmp_path), ".globnotes", "config.json"
        )
        with open(config_path) as f:
            assert json.load(f)["auth_type"] == "read_only"

    def test_read_only_persists_across_restart(
        self, setup_client, tmp_path, monkeypatch
    ):
        setup_client.post("/_/api/setup", json={"mode": "read_only"})
        client2 = _fresh_client(tmp_path, monkeypatch, auth_type=None)
        assert client2.get("/_/api/setup").json()["setupRequired"] is False
        assert client2.get("/_/api/notes/a/b").status_code == 404
        assert (
            client2.post(
                "/_/api/notes", json={"title": "a/b", "content": "x"}
            ).status_code
            == 403
        )

    def test_disable_auth_flow(self, setup_client, tmp_path):
        response = setup_client.post("/_/api/setup", json={"mode": "none"})
        assert response.status_code == 200
        assert response.json()["setupRequired"] is False
        # Data APIs work immediately
        assert setup_client.get("/_/api/notes/a/b").status_code == 404
        # The choice is persisted
        config_path = os.path.join(
            str(tmp_path), ".globnotes", "config.json"
        )
        with open(config_path) as f:
            assert json.load(f)["auth_type"] == "none"
        # Setup cannot be repeated
        assert (
            setup_client.post("/_/api/setup", json={"mode": "none"}).status_code
            == 409
        )

    def test_password_flow(self, setup_client, tmp_path):
        response = setup_client.post(
            "/_/api/setup",
            json={
                "mode": "password",
                "username": "Alice",
                "password": "secret",
            },
        )
        assert response.status_code == 200
        assert response.json()["setupRequired"] is False
        # Data APIs now require a token
        assert setup_client.get("/_/api/notes/a/b").status_code == 401
        # Login works (username is lowercased)
        response = setup_client.post(
            "/_/api/token", json={"username": "alice", "password": "secret"}
        )
        assert response.status_code == 200
        token = response.json()["access_token"]
        response = setup_client.get(
            "/_/api/notes/a/b",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 404
        # Wrong password is rejected
        assert (
            setup_client.post(
                "/_/api/token",
                json={"username": "alice", "password": "wrong"},
            ).status_code
            == 401
        )
        # The stored password is hashed, not plaintext
        with open(
            os.path.join(str(tmp_path), ".globnotes", "config.json")
        ) as f:
            config = json.load(f)
        assert config["password_hash"].startswith("pbkdf2_sha256$")
        assert "secret" not in config["password_hash"]

    def test_password_flow_requires_credentials(self, setup_client):
        response = setup_client.post(
            "/_/api/setup",
            json={"mode": "password", "username": "", "password": ""},
        )
        assert response.status_code == 400

    def test_setup_persists_across_restart(
        self, setup_client, tmp_path, monkeypatch
    ):
        setup_client.post(
            "/_/api/setup",
            json={
                "mode": "password",
                "username": "alice",
                "password": "secret",
            },
        )
        # Simulate a restart: fresh app, same storage dir, still no env vars
        client2 = _fresh_client(tmp_path, monkeypatch, auth_type=None)
        assert client2.get("/_/api/setup").json()["setupRequired"] is False
        assert client2.get("/_/api/notes/a/b").status_code == 401
        response = client2.post(
            "/_/api/token", json={"username": "alice", "password": "secret"}
        )
        assert response.status_code == 200


class TestEnvPrecedence:
    def test_env_auth_wins_over_stored_config(
        self, tmp_path, monkeypatch
    ):
        # Stored config says auth is disabled...
        config_dir = os.path.join(str(tmp_path), ".globnotes")
        os.makedirs(config_dir)
        with open(os.path.join(config_dir, "config.json"), "w") as f:
            json.dump({"auth_type": "none"}, f)
        # ...but env says password
        monkeypatch.setenv("GLOBNOTES_USERNAME", "bob")
        monkeypatch.setenv("GLOBNOTES_PASSWORD", "hunter2")
        monkeypatch.setenv("GLOBNOTES_SECRET_KEY", "testsecret")
        client = _fresh_client(tmp_path, monkeypatch, auth_type="password")
        assert client.get("/_/api/setup").json()["setupRequired"] is False
        assert client.get("/_/api/notes/a/b").status_code == 401
        response = client.post(
            "/_/api/token", json={"username": "bob", "password": "hunter2"}
        )
        assert response.status_code == 200
