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
