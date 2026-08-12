import json
import os
import sys
from enum import Enum
from typing import Literal, Optional

from helpers import CustomBaseModel, get_env
from logger import logger


class GlobalConfig:
    def __init__(self) -> None:
        logger.debug("Loading global config...")
        self.notes_path: str = get_env("GLOBNOTES_PATH", mandatory=True)
        self.stored_config = self._load_stored_config()
        self.auth_type: Optional[AuthType] = self._load_auth_type()
        self.setup_required: bool = self.auth_type is None
        self.quick_access_hide: bool = self._quick_access_hide()
        self.quick_access_title: str = self._quick_access_title()
        self.quick_access_term: str = self._quick_access_term()
        self.quick_access_sort: str = self._quick_access_sort()
        self.quick_access_limit: int = self._quick_access_limit()
        self.path_prefix: str = self._load_path_prefix()

    @property
    def _config_path(self):
        return os.path.join(self.notes_path, ".globnotes", "config.json")

    def _load_stored_config(self):
        """Load the config written by the first-run setup wizard (if any)."""
        try:
            with open(self._config_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def save_stored_config(self, config: dict) -> None:
        """Persist the first-run setup choice."""
        os.makedirs(os.path.dirname(self._config_path), exist_ok=True)
        with open(self._config_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
        self.stored_config = config

    def load_auth(self):
        if self.auth_type in (AuthType.PASSWORD, AuthType.TOTP):
            from auth.local import LocalAuth

            return LocalAuth(self)
        return None

    def load_note_storage(self):
        from notes.file_system import FileSystemNotes

        return FileSystemNotes()

    def load_file_serving(self):
        from files import FileServing

        return FileServing()

    def _load_auth_type(self):
        key = "GLOBNOTES_AUTH_TYPE"
        value = get_env(key, mandatory=False)
        if value:
            try:
                return AuthType(value.lower())
            except ValueError:
                logger.error(
                    f"Invalid value '{value}' for {key}. "
                    + "Must be one of: "
                    + ", ".join([auth_type.value for auth_type in AuthType])
                    + "."
                )
                sys.exit(1)
        # Fall back to the stored first-run setup choice (env always wins)
        stored_auth_type = (self.stored_config or {}).get("auth_type")
        if stored_auth_type:
            try:
                return AuthType(stored_auth_type)
            except ValueError:
                logger.error(
                    f"Invalid auth_type '{stored_auth_type}' in "
                    + self._config_path
                    + "."
                )
                sys.exit(1)
        # No env and no stored choice: first-run setup is required
        return None

    def _quick_access_hide(self):
        key = "GLOBNOTES_QUICK_ACCESS_HIDE"
        value = get_env(key, mandatory=False, default=False, cast_bool=True)
        if value is False:
            depricated_key = "GLOBNOTES_HIDE_RECENTLY_MODIFIED"
            value = get_env(
                depricated_key, mandatory=False, default=False, cast_bool=True
            )
            if value is True:
                logger.warning(
                    f"{depricated_key} is depricated. Please use {key} instead."
                )
        return value

    def _quick_access_title(self):
        key = "GLOBNOTES_QUICK_ACCESS_TITLE"
        return get_env(key, mandatory=False, default="RECENTLY MODIFIED")

    def _quick_access_term(self):
        key = "GLOBNOTES_QUICK_ACCESS_TERM"
        return get_env(key, mandatory=False, default="*")

    def _quick_access_sort(self):
        key = "GLOBNOTES_QUICK_ACCESS_SORT"
        value = get_env(key, mandatory=False, default="lastModified")
        valid_values = ["score", "title", "lastModified"]
        if value not in valid_values:
            logger.error(
                f"Invalid value '{value}' for {key}. "
                + "Must be one of: "
                + ", ".join(valid_values)
            )
            sys.exit(1)
        return value

    def _quick_access_limit(self):
        key = "GLOBNOTES_QUICK_ACCESS_LIMIT"
        return get_env(key, mandatory=False, default=4, cast_int=True)

    def _load_path_prefix(self):
        key = "GLOBNOTES_PATH_PREFIX"
        value = get_env(key, mandatory=False, default="")
        if value and (not value.startswith("/") or value.endswith("/")):
            logger.error(
                f"Invalid value '{value}' for {key}. "
                + "Must start with '/' and not end with '/'."
            )
            sys.exit(1)
        return value


class AuthType(str, Enum):
    NONE = "none"
    READ_ONLY = "read_only"
    PASSWORD = "password"
    TOTP = "totp"


class GlobalConfigResponseModel(CustomBaseModel):
    setup_required: bool
    auth_type: Optional[AuthType]
    quick_access_hide: bool
    quick_access_title: str
    quick_access_term: str
    quick_access_sort: str
    quick_access_limit: int


class SetupRequest(CustomBaseModel):
    mode: Literal["none", "password", "read_only"]
    username: Optional[str] = None
    password: Optional[str] = None


class SetupStatus(CustomBaseModel):
    setup_required: bool
