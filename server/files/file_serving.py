import mimetypes
import os
import shutil
import urllib.parse
from datetime import datetime, timezone

from fastapi import UploadFile
from fastapi.responses import FileResponse

from helpers import get_env, is_valid_note_path, resolve_in_root
from logger import logger

from .models import FileCreateResponse

MARKDOWN_EXT = ".md"

# Extensions served inline (browser-renderable). Everything else is served
# as a forced download, so script-capable files (e.g. .html) can never
# execute within the application's origin.
INLINE_EXTENSIONS = {
    ".avif",
    ".bmp",
    ".css",
    ".flac",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".json",
    ".m4a",
    ".mov",
    ".mp3",
    ".mp4",
    ".oga",
    ".ogg",
    ".pdf",
    ".png",
    ".svg",
    ".webm",
    ".webp",
    ".xml",
}

# Extensions served as plain text (including markdown, so raw notes can be
# fetched directly - useful for agents).
TEXT_EXTENSIONS = {".csv", ".log", ".md", ".txt", ".yaml", ".yml"}

SVG_EXT = ".svg"


class FileServing:
    """Serves and accepts files from anywhere in the notes tree. There is
    no special attachments directory - files live alongside the notes that
    reference them."""

    def __init__(self):
        self.storage_path = get_env("GLOBNOTES_PATH", mandatory=True)
        if not os.path.exists(self.storage_path):
            raise NotADirectoryError(
                f"'{self.storage_path}' is not a valid directory."
            )

    def get(self, path: str) -> FileResponse:
        """Get a file from anywhere in the notes tree."""
        # Hidden files and directories are none of the app's business.
        if any(segment.startswith(".") for segment in path.split("/")):
            raise FileNotFoundError(f"'{path}' not found.")
        filepath = resolve_in_root(self.storage_path, path)
        if not os.path.isfile(filepath):
            raise FileNotFoundError(f"'{path}' not found.")
        ext = os.path.splitext(filepath)[1].lower()
        headers = {}
        filename = None
        if ext in TEXT_EXTENSIONS:
            media_type = "text/plain; charset=utf-8"
        elif ext == SVG_EXT:
            # SVG can carry script; neutralise it even when the file is
            # opened as a top-level document.
            media_type = "image/svg+xml"
            headers["Content-Security-Policy"] = "script-src 'none'"
        else:
            media_type = mimetypes.guess_type(filepath)[0]
        if ext not in INLINE_EXTENSIONS and ext not in TEXT_EXTENSIONS:
            # Forced download (FileResponse sets Content-Disposition:
            # attachment when given a filename).
            filename = os.path.basename(filepath)
        return FileResponse(
            filepath,
            media_type=media_type,
            headers=headers,
            filename=filename,
        )

    def create(self, directory: str, file: UploadFile) -> FileCreateResponse:
        """Upload a file into the given directory (relative to the notes
        root), creating the directory if needed."""
        if directory:
            target_dir = resolve_in_root(self.storage_path, directory)
        else:
            target_dir = os.path.realpath(self.storage_path)
        filename = self._validated_filename(file.filename)
        os.makedirs(target_dir, exist_ok=True)
        filepath = os.path.join(target_dir, filename)
        if os.path.exists(filepath):
            filename = self._datetime_suffix_filename(filename)
            filepath = os.path.join(target_dir, filename)
        logger.info(f"Uploading to '{filepath}'")
        with open(filepath, "xb") as f:
            shutil.copyfileobj(file.file, f)
        return FileCreateResponse(
            filename=filename,
            url=urllib.parse.quote(filename),
        )

    @staticmethod
    def _validated_filename(filename: str) -> str:
        filename = os.path.basename(filename or "")
        if not filename or filename.startswith("."):
            raise ValueError(f"Invalid filename '{filename}'.")
        name, ext = os.path.splitext(filename)
        if ext.lower() == MARKDOWN_EXT:
            # Uploaded markdown becomes a note, so its stem must be a valid
            # note title - otherwise the note could never be opened.
            is_valid_note_path(name)
        return filename

    @staticmethod
    def _datetime_suffix_filename(filename: str) -> str:
        """Add a timestamp suffix to the filename."""
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
        name, ext = os.path.splitext(filename)
        return f"{name}_{timestamp}{ext}"
