class TestNoteRoutes:
    def test_create_and_get_nested(self, client):
        response = client.post(
            "/_/api/notes", json={"title": "a/b/c", "content": "hi"}
        )
        assert response.status_code == 200
        response = client.get("/_/api/notes/a/b/c")
        assert response.status_code == 200
        assert response.json()["title"] == "a/b/c"
        assert response.json()["content"] == "hi"

    def test_get_missing_is_404(self, client):
        assert client.get("/_/api/notes/no/such").status_code == 404

    def test_get_invalid_title_is_400(self, client):
        assert client.get("/_/api/notes/a<b").status_code == 400

    def test_create_invalid_titles_rejected(self, client):
        for title in ["../evil", "a//b", ".hidden/x", "a/../b"]:
            response = client.post(
                "/_/api/notes", json={"title": title, "content": "x"}
            )
            assert response.status_code in (400, 422), title

    def test_create_duplicate_is_409(self, client):
        client.post("/_/api/notes", json={"title": "a/b", "content": "1"})
        response = client.post(
            "/_/api/notes", json={"title": "a/b", "content": "2"}
        )
        assert response.status_code == 409

    def test_patch_rename_nested(self, client):
        client.post("/_/api/notes", json={"title": "a/b", "content": "x"})
        response = client.patch("/_/api/notes/a/b", json={"newTitle": "x/y/z"})
        assert response.status_code == 200
        assert client.get("/_/api/notes/a/b").status_code == 404
        assert client.get("/_/api/notes/x/y/z").status_code == 200

    def test_patch_content(self, client):
        client.post("/_/api/notes", json={"title": "a/b", "content": "old"})
        response = client.patch(
            "/_/api/notes/a/b", json={"newContent": "new"}
        )
        assert response.status_code == 200
        assert response.json()["content"] == "new"

    def test_delete_nested(self, client):
        client.post("/_/api/notes", json={"title": "a/b", "content": "x"})
        assert client.delete("/_/api/notes/a/b").status_code == 200
        assert client.get("/_/api/notes/a/b").status_code == 404

    def test_search_returns_nested_titles(self, client):
        client.post(
            "/_/api/notes",
            json={"title": "dad/recipes/soup", "content": "yum"},
        )
        response = client.get("/_/api/search", params={"term": "*"})
        titles = [r["title"] for r in response.json()]
        assert "dad/recipes/soup" in titles

    def test_note_index_returns_all_titles(self, client):
        client.post("/_/api/notes", json={"title": "a/b", "content": "1"})
        client.post("/_/api/notes", json={"title": "c", "content": "2"})
        response = client.get("/_/api/note-index")
        assert response.status_code == 200
        assert sorted(response.json()) == ["a/b", "c"]

    def test_search_nested_filter(self, client):
        client.post(
            "/_/api/notes",
            json={"title": "root-note", "content": "needle"},
        )
        client.post(
            "/_/api/notes",
            json={"title": "sub/nested-note", "content": "needle"},
        )
        everything = client.get(
            "/_/api/search", params={"term": "needle"}
        ).json()
        assert len(everything) == 2
        flat = client.get(
            "/_/api/search", params={"term": "needle", "nested": "false"}
        ).json()
        assert [r["title"] for r in flat] == ["root-note"]

    def test_search_nested_filter_applies_before_limit(self, client):
        client.post(
            "/_/api/notes", json={"title": "z-root", "content": "needle"}
        )
        for i in range(3):
            client.post(
                "/_/api/notes",
                json={"title": f"sub/n{i}", "content": "needle"},
            )
        response = client.get(
            "/_/api/search",
            params={
                "term": "needle",
                "nested": "false",
                "limit": 1,
                "sort": "title",
            },
        ).json()
        assert len(response) == 1
        assert response[0]["title"] == "z-root"

    def test_search_folder_filter(self, client):
        client.post(
            "/_/api/notes", json={"title": "dad/a", "content": "needle"}
        )
        client.post(
            "/_/api/notes",
            json={"title": "dad/recipes/b", "content": "needle"},
        )
        client.post(
            "/_/api/notes", json={"title": "mom/c", "content": "needle"}
        )
        client.post(
            "/_/api/notes", json={"title": "daddy/d", "content": "needle"}
        )

        dad = client.get(
            "/_/api/search", params={"term": "needle", "folder": "dad"}
        ).json()
        assert sorted(r["title"] for r in dad) == ["dad/a", "dad/recipes/b"]

        recipes = client.get(
            "/_/api/search",
            params={"term": "needle", "folder": "dad/recipes"},
        ).json()
        assert [r["title"] for r in recipes] == ["dad/recipes/b"]

        # No partial-segment matches
        assert (
            client.get(
                "/_/api/search", params={"term": "needle", "folder": "da"}
            ).json()
            == []
        )

        # Invalid folder path
        assert (
            client.get(
                "/_/api/search", params={"term": "needle", "folder": "../x"}
            ).status_code
            == 400
        )

    def test_search_folder_filter_applies_before_limit(self, client):
        client.post(
            "/_/api/notes", json={"title": "dad/one", "content": "needle"}
        )
        client.post(
            "/_/api/notes", json={"title": "dad/two", "content": "needle"}
        )
        client.post(
            "/_/api/notes", json={"title": "mom/three", "content": "needle"}
        )
        response = client.get(
            "/_/api/search",
            params={
                "term": "needle",
                "folder": "dad",
                "limit": 1,
                "sort": "title",
                "order": "asc",
            },
        ).json()
        assert len(response) == 1
        assert response[0]["title"] == "dad/one"
