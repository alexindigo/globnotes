import os

import pytest


class TestRenamePreviewRoute:
    """The rename-preview route must not be shadowed by the greedy
    {title:path} note route (it was, silently: every preview call 404'd
    and the client saved without the dialog)."""

    def test_rename_preview_returns_refs(self, client):
        # create note with an image ref via the API
        assert (
            client.post(
                "/_/api/notes",
                json={
                    "title": "rename-me/moving-note",
                    "content": "![pic](assets/pic.png)",
                },
            ).status_code
            == 200
        )
        # the referenced file exists beside the note
        assets = os.path.join(
            os.environ["GLOBNOTES_PATH"], "rename-me", "assets"
        )
        os.makedirs(assets, exist_ok=True)
        with open(os.path.join(assets, "pic.png"), "wb") as f:
            f.write(b"png")

        response = client.get(
            "/_/api/rename-preview",
            params={
                "title": "rename-me/moving-note",
                "new_title": "archive/moving-note",
            },
        )
        assert response.status_code == 200
        refs = response.json()
        assert len(refs) == 1
        assert refs[0]["path"] == "rename-me/assets/pic.png"
