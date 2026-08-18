from abc import ABC, abstractmethod
from typing import Literal

from .models import Note, NoteCreate, NoteUpdate, SearchResult


class BaseNotes(ABC):
    @abstractmethod
    def create(self, data: NoteCreate) -> Note:
        """Create a new note."""
        pass

    @abstractmethod
    def get(self, title: str) -> Note:
        """Get a specific note."""
        pass

    @abstractmethod
    def update(
        self, title: str, new_data: NoteUpdate, file_refs: str = "none"
    ) -> Note:
        """Update a specific note."""
        pass

    @abstractmethod
    def preview_rename(
        self, title: str, new_title: str
    ) -> list[dict]:
        """Scan refs that would be affected by a rename."""
        pass

    @abstractmethod
    def rewrite_refs(self, old_path: str, new_path: str) -> None:
        """Rewrite stale file references across all notes."""
        pass

    @abstractmethod
    def delete(self, title: str) -> None:
        """Delete a specific note."""
        pass

    @abstractmethod
    def search(
        self,
        term: str,
        sort: Literal["score", "title", "last_modified"] = "score",
        order: Literal["asc", "desc"] = "desc",
        limit: int = None,
        nested: bool = True,
        folder: str = None,
    ) -> list[SearchResult]:
        """Search for notes."""
        pass

    @abstractmethod
    def get_tags(self) -> list[str]:
        """Get a list of all indexed tags."""
        pass

    @abstractmethod
    def get_titles(self) -> list[str]:
        """Get a list of all note titles."""
        pass

    @abstractmethod
    def list_level(self, path: str = "") -> dict:
        """List immediate children (folders and notes) of one directory
        level for the lazy sidebar tree."""
        pass

    @abstractmethod
    def sync_index(self) -> None:
        """Synchronously run an incremental index sync."""
        pass

    @abstractmethod
    def start_background_sync(self) -> None:
        """Run the initial full index sync in the background."""
        pass

    @property
    @abstractmethod
    def index_status(self) -> dict:
        """Report sync progress for the status endpoint."""
        pass
