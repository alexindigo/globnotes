import router from "./router.js";

class Note {
  constructor(note) {
    this.path = note?.path;
    this.title = note?.title;
    this.lastModified = note?.lastModified;
    this.content = note?.content;
  }

  get lastModifiedAsDate() {
    return new Date(this.lastModified * 1000);
  }

  get lastModifiedAsString() {
    return this.lastModifiedAsDate.toLocaleString();
  }
}

class SearchResult extends Note {
  constructor(searchResult) {
    super(searchResult);
    this.score = searchResult.score;
    this.pathHighlights = searchResult.pathHighlights;
    this.contentHighlights = searchResult.contentHighlights;
    this.tagMatches = searchResult.tagMatches;
  }

  get pathHighlightsOrPath() {
    return this.pathHighlights ? this.pathHighlights : this.path;
  }

  get includesHighlights() {
    if (
      this.pathHighlights ||
      this.contentHighlights ||
      (this.tagMatches != null && this.tagMatches.length)
    ) {
      return true;
    } else {
      return false;
    }
  }
}

export { Note, SearchResult };
