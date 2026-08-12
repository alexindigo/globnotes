import os


def _write(root, rel, content):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if isinstance(content, bytes) else "w"
    with open(path, mode) as f:
        f.write(content)
    return path


class TestGetFile:
    def test_serves_nested_file(self, client, tmp_path):
        _write(str(tmp_path), "dad/assets/broth.jpg", b"jpgdata")
        response = client.get("/dad/assets/broth.jpg")
        assert response.status_code == 200
        assert response.content == b"jpgdata"

    def test_serves_markdown_as_plain_text(self, client, tmp_path):
        _write(str(tmp_path), "a/b.md", "# Hi")
        response = client.get("/_/api/files/a/b.md")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/plain")
        assert response.text == "# Hi"

    def test_html_is_forced_download(self, client, tmp_path):
        _write(str(tmp_path), "x/page.html", "<script>alert(1)</script>")
        response = client.get("/x/page.html")
        assert response.status_code == 200
        assert "attachment" in response.headers["content-disposition"]

    def test_svg_has_script_blocking_csp(self, client, tmp_path):
        _write(str(tmp_path), "x/pic.svg", "<svg></svg>")
        response = client.get("/x/pic.svg")
        assert response.status_code == 200
        assert (
            response.headers.get("content-security-policy")
            == "script-src 'none'"
        )

    def test_dotfiles_are_404(self, client, tmp_path):
        _write(str(tmp_path), ".secret/thing.md", "x")
        assert client.get("/.secret/thing.md").status_code == 404

    def test_traversal_is_rejected(self, client):
        response = client.get("/..%2F..%2Fetc%2Fpasswd")
        assert response.status_code in (400, 404)

    def test_missing_is_404(self, client):
        assert client.get("/no/such.jpg").status_code == 404

    def test_api_prefix_route_also_works(self, client, tmp_path):
        _write(str(tmp_path), "a.png", b"p")
        assert client.get("/_/api/files/a.png").status_code == 200


class TestUploadFile:
    def test_upload_lands_in_directory(self, client, tmp_path):
        response = client.post(
            "/_/api/files",
            files={"file": ("photo.jpg", b"data", "image/jpeg")},
            data={"directory": "dad/recipes"},
        )
        assert response.status_code == 200
        assert response.json()["filename"] == "photo.jpg"
        assert response.json()["url"] == "photo.jpg"
        uploaded = os.path.join(
            str(tmp_path), "dad", "recipes", "photo.jpg"
        )
        with open(uploaded, "rb") as f:
            assert f.read() == b"data"

    def test_upload_to_root(self, client, tmp_path):
        response = client.post(
            "/_/api/files", files={"file": ("a.png", b"p", "image/png")}
        )
        assert response.status_code == 200
        assert os.path.isfile(os.path.join(str(tmp_path), "a.png"))

    def test_collision_gets_datetime_suffix(self, client, tmp_path):
        _write(str(tmp_path), "photo.jpg", b"old")
        response = client.post(
            "/_/api/files",
            files={"file": ("photo.jpg", b"new", "image/jpeg")},
        )
        assert response.status_code == 200
        assert response.json()["filename"] != "photo.jpg"
        assert response.json()["filename"].startswith("photo_")

    def test_dotfile_upload_rejected(self, client):
        response = client.post(
            "/_/api/files", files={"file": (".hidden", b"x", "text/plain")}
        )
        assert response.status_code == 400

    def test_markdown_upload_validates_title(self, client, tmp_path):
        response = client.post(
            "/_/api/files",
            files={"file": ("ok note.md", b"# hi", "text/markdown")},
        )
        assert response.status_code == 200
        response = client.post(
            "/_/api/files",
            files={"file": ("bad<name>.md", b"x", "text/markdown")},
        )
        assert response.status_code == 400

    def test_upload_directory_traversal_rejected(self, client):
        response = client.post(
            "/_/api/files",
            files={"file": ("a.png", b"p", "image/png")},
            data={"directory": "../escape"},
        )
        assert response.status_code == 400
