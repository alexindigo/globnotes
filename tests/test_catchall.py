import os


def _write(root, rel, content):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if isinstance(content, bytes) else "w"
    with open(path, mode) as f:
        f.write(content)
    return path


class TestCatchAll:
    def test_note_page_returns_html(self, client, tmp_path):
        _write(str(tmp_path), "dad/recipes/soup.md", "# Soup")
        response = client.get("/dad/recipes/soup")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]

    def test_md_suffix_returns_html(self, client, tmp_path):
        _write(str(tmp_path), "dad/quicknote.md", "# Quick")
        response = client.get("/dad/quicknote.md")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]

    def test_vault_file_served_at_root(self, client, tmp_path):
        _write(str(tmp_path), "dad/assets/broth.jpg", b"jpgdata")
        response = client.get("/dad/assets/broth.jpg")
        assert response.status_code == 200
        assert response.content == b"jpgdata"

    def test_missing_file_is_404(self, client):
        assert client.get("/dad/nope.png").status_code == 404

    def test_dotted_note_title_returns_html(self, client, tmp_path):
        _write(str(tmp_path), "a/v2.1.md", "# Versioned")
        response = client.get("/a/v2.1")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]

    def test_missing_note_returns_html(self, client):
        # The client shows its own "not found" state.
        response = client.get("/no/such/note")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]

    def test_machinery_segment_is_404(self, client):
        assert client.get("/_/bogus").status_code == 404

    def test_hidden_path_is_404(self, client, tmp_path):
        _write(str(tmp_path), ".secret/thing.md", "x")
        assert client.get("/.secret/thing.md").status_code == 404
        _write(str(tmp_path), "dad/.hidden.jpg", b"x")
        assert client.get("/dad/.hidden.jpg").status_code == 404

    def test_traversal_is_rejected(self, client):
        # API route: rejected (the dot-segment rule fires before the
        # validator, so 404 not 400 - either is a refusal).
        response = client.get("/_/api/files/..%2F..%2Fetc%2Fpasswd")
        assert response.status_code in (400, 404)
        # Catch-all: never serves the file, whatever the encoding.
        response = client.get("/..%2F..%2Fetc%2Fpasswd")
        assert response.status_code in (400, 404)
        assert b"root:" not in response.content

    def test_app_pages_return_html(self, client):
        for page in ("/", "/_/login", "/_/new", "/_/search"):
            response = client.get(page)
            assert response.status_code == 200, page
            assert "text/html" in response.headers["content-type"]

    def test_raw_markdown_via_api_files(self, client, tmp_path):
        _write(str(tmp_path), "dad/recipes/soup.md", "# Soup\n")
        response = client.get("/_/api/files/dad/recipes/soup.md")
        assert response.status_code == 200
        assert response.text == "# Soup\n"
