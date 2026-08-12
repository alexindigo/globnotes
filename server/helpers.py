import hashlib
import os
import re
import secrets
import sys

from pydantic import BaseModel

from logger import logger


def camel_case(snake_case_str: str) -> str:
    """Return the declared snake_case string in camelCase."""
    parts = [part for part in snake_case_str.split("_") if part != ""]
    return parts[0] + "".join(part.title() for part in parts[1:])


def is_valid_filename(value):
    """Raise ValueError if the declared string contains any of the following
    characters: <>:"/\\|?*"""
    invalid_chars = r'<>:"/\|?*'
    if any(invalid_char in value for invalid_char in invalid_chars):
        raise ValueError(
            "title cannot include any of the following characters: "
            + invalid_chars
        )
    return value


NOTE_PATH_INVALID_CHARS = r'<>:"\|?*'
NOTE_PATH_MAX_SEGMENT_BYTES = 255


def is_valid_note_path(value):
    """Raise ValueError if the declared string is not a valid note path.

    A note path is a POSIX-style relative path with segments separated by
    '/'. Each segment must be non-empty, must not be '.' or '..', must not
    start with '.', must not contain any of <>:"\\|?* and must be at most
    255 bytes."""
    if not value:
        raise ValueError("title cannot be empty")
    for segment in value.split("/"):
        if not segment:
            raise ValueError("title cannot contain empty path segments")
        if segment in (".", ".."):
            raise ValueError(
                "title cannot contain '.' or '..' path segments"
            )
        if segment.startswith("."):
            raise ValueError("title path segments cannot start with '.'")
        if any(char in segment for char in NOTE_PATH_INVALID_CHARS):
            raise ValueError(
                "title cannot include any of the following characters: "
                + NOTE_PATH_INVALID_CHARS
            )
        if len(segment.encode("utf-8")) > NOTE_PATH_MAX_SEGMENT_BYTES:
            raise ValueError("title path segments cannot exceed 255 bytes")
    return value


def resolve_in_root(root: str, rel_path: str) -> str:
    """Resolve rel_path inside root and verify containment.

    Returns the absolute, symlink-resolved path. Raises ValueError if
    rel_path is not a valid note path or if the resolved path escapes root
    (via '..' segments or symlinks)."""
    is_valid_note_path(rel_path)
    root_real = os.path.realpath(root)
    resolved = os.path.realpath(os.path.join(root_real, rel_path))
    if os.path.commonpath([root_real, resolved]) != root_real:
        raise ValueError(f"'{rel_path}' resolves outside the root directory")
    return resolved


def strip_whitespace(value):
    """Return the declared string with leading and trailing whitespace
    removed."""
    return value.strip()


def hash_password(password: str, iterations: int = 100_000) -> str:
    """Hash a password for stored (file-backed) credentials."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, iterations
    )
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Verify a password against a hash produced by hash_password."""
    try:
        _, iterations, salt_hex, digest_hex = stored.split("$")
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            int(iterations),
        )
        return secrets.compare_digest(digest.hex(), digest_hex)
    except (AttributeError, ValueError):
        return False


def get_env(
    key, mandatory=False, default=None, cast_int=False, cast_bool=False
):
    """Get an environment variable. If `mandatory` is True and environment
    variable isn't set, exit the program"""
    value = os.environ.get(key)
    if mandatory and not value:
        logger.error(f"Environment variable {key} must be set.")
        sys.exit(1)
    if not mandatory and not value:
        return default
    if cast_int:
        try:
            value = int(value)
        except (TypeError, ValueError):
            logger.error(f"Invalid value '{value}' for {key}.")
            sys.exit(1)
    if cast_bool:
        value = value.lower()
        if value == "true":
            value = True
        elif value == "false":
            value = False
        else:
            logger.error(f"Invalid value '{value}' for {key}.")
            sys.exit(1)
    return value


def rewrite_index_html(html_file, path_prefix):
    """Publish the path prefix to the client (meta tag) and point the built
    asset references at it when one is configured."""
    with open(html_file, "r", encoding="utf-8") as f:
        html = f.read()
    if path_prefix:
        html = html.replace('"/_/', f'"{path_prefix}/_/')
    if 'name="globnotes-prefix"' in html:
        html = re.sub(
            r'(<meta name="globnotes-prefix" content=")[^"]*',
            r"\1" + path_prefix,
            html,
        )
    else:
        meta = f'<meta name="globnotes-prefix" content="{path_prefix}">'
        html = html.replace("<head>", "<head>\n    " + meta, 1)
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(html)


class CustomBaseModel(BaseModel):
    class Config:
        alias_generator = camel_case
        populate_by_name = True
        from_attributes = True
