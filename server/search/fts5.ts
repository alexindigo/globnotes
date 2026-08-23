// SPDX-License-Identifier: LGPL-3.0-only

import { DatabaseSync } from "node:sqlite";
import * as path from "@std/path";
import type { Indexer } from "@server/state.ts";
import { isValidNotePath } from "@server/helpers.ts";
import { logger } from "@server/logger.ts";
import type { SearchResult } from "@server/notes/models.ts";
import { state } from "@server/state.ts";
import { translateQuery } from "@server/search/query.ts";
import { extractTags } from "@server/search/tags.ts";
import { resolveTitleInfo } from "@server/search/titles.ts";

const MARKDOWN_EXT = ".md";
const SNIPPET_COLS = 48;
/** Whoosh parity: highlights wrap matches in <b class="match term0">. */
const MARK_OPEN = '<b class="match term0">';
const MARK_CLOSE = "</b>";

interface FtsRow {
  title: string;
  filename: string;
  /** Space-joined raw tags (for tagMatches computation). */
  tags: string;
  lastModified: number;
  score: number | null;
  titleHighlights: string | null;
  contentHighlights: string | null;
  /** Display title from notes_meta (join); falls back to basename. */
  displayTitle: string | null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Fts5Indexer implements Indexer {
  #db: DatabaseSync;
  #indexPath: string;
  #status = { syncing: false, initial: false, done: 0, total: 0 };

  constructor(storagePath: string) {
    const indexDir = path.join(storagePath, ".globnotes");
    Deno.mkdirSync(indexDir, { recursive: true });
    this.#indexPath = path.join(indexDir, "index.sqlite");
    this.#db = new DatabaseSync(this.#indexPath);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#initSchema();
    this.#migrate();
    this.#probeFts5();
  }

  #initSchema(): void {
    this.#db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, content, tags,
        filename UNINDEXED,
        last_modified UNINDEXED,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `);
    // Raw tags for the listing endpoint (Python tags = KEYWORD,
    // unstemmed, lowercase). FTS5 tokenizers are per-table — the
    // stemmed tags column above serves search ranking, this plain
    // table serves the raw listing.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS notes_tags(
        filename TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (filename, tag)
      );
    `);
    // Display metadata (display title, first H1, aliases). Resolved at
    // index time from front matter + content; served to clients.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS notes_meta(
        filename TEXT PRIMARY KEY,
        display_title TEXT NOT NULL,
        h1 TEXT,
        aliases TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  /** Index is derived data: on schema-version mismatch, wipe and let the
   * background sync rebuild everything from the markdown files. */
  #migrate(): void {
    const SCHEMA_VERSION = 10;
    const row = this.#db.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    if (row && row.user_version !== SCHEMA_VERSION) {
      logger.info(
        `index schema v${row.user_version} → v${SCHEMA_VERSION}; rebuilding`,
      );
      this.#db.exec("DELETE FROM notes_fts");
      this.#db.exec("DELETE FROM notes_tags");
      this.#db.exec("DELETE FROM notes_meta");
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  /** FTS5 probe — fails loudly if the build lacks FTS5 (fallback to
   * @db/sqlite in that case; see plans/plugin-system §3). */
  #probeFts5(): void {
    try {
      this.#db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __probe USING fts5(x)");
      this.#db.exec("DROP TABLE IF EXISTS __probe");
    } catch (e) {
      throw new Error(
        "FTS5 is unavailable in Deno's node:sqlite. Fallback to @db/sqlite " +
          "with DENO_SQLITE_PATH is required. Cause: " + (e as Error).message,
      );
    }
  }

  get indexStatus(): {
    syncing: boolean;
    initial: boolean;
    done: number;
    total: number;
  } {
    return {
      syncing: this.#status.syncing,
      initial: !this.#status.initial,
      done: this.#status.done,
      total: this.#status.total,
    };
  }

  reindexNote(title: string): void {
    this.#indexFile(title + MARKDOWN_EXT);
  }

  /** Index one file by its vault-relative FILENAME — no title validation.
   * The filesystem is the source of truth: real vaults contain titles the
   * note API can't address (`?`, `:`, `*`…), and Python indexes them just
   * the same (its sync reads by filename, not via the validated path). */
  #indexFile(filename: string): void {
    const filepath = path.join(state.config.notesPath, filename);
    const content = Deno.readTextFileSync(filepath);
    const mtime = (Deno.statSync(filepath).mtime?.getTime() ?? 0) / 1000;
    const { contentExTags, tagSet } = extractTags(content);
    this.#upsertNote(
      this.#stripExt(filename),
      contentExTags,
      tagSet,
      filename,
      mtime,
      resolveTitleInfo(this.#basename(filename), content),
    );
    this.#notifyPlugins();
  }

  deleteFromIndex(title: string): void {
    this.#deleteByFilename(title + MARKDOWN_EXT);
    this.#notifyPlugins();
  }

  /** Plan §4: reinstantiate plugins on every sync (state resets; hats
   * rebuild their detection in onSync). Fire-and-forget; skipped when
   * the pool was never started (no render has happened yet). */
  #notifyPlugins(): void {
    const plugins = state.plugins;
    if (!plugins || plugins.hosts.size === 0) return;
    plugins.syncAll().catch((e) => logger.error(`plugin sync failed: ${e}`));
  }

  /** Insert/replace a note in the FTS table, the raw-tag table, and the
   * display-metadata table. */
  #upsertNote(
    title: string,
    contentExTags: string,
    tagSet: Set<string>,
    filename: string,
    lastModified: number,
    titleInfo?: { displayTitle: string; h1: string | null; aliases: string[] },
  ): void {
    this.#deleteByFilename(filename);
    this.#db
      .prepare(
        `INSERT INTO notes_fts (title, content, tags, filename, last_modified)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        title,
        contentExTags,
        [...tagSet].join(" "),
        filename,
        lastModified,
      );
    // Python tags = KEYWORD(lowercase): raw, whole-token, lowercased.
    const insertTag = this.#db.prepare(
      "INSERT OR IGNORE INTO notes_tags (filename, tag) VALUES (?, ?)",
    );
    for (const tag of tagSet) {
      insertTag.run(filename, tag.toLowerCase());
    }
    const meta = titleInfo ?? {
      displayTitle: this.#basename(filename),
      h1: null,
      aliases: [],
    };
    this.#db
      .prepare(
        `INSERT INTO notes_meta (filename, display_title, h1, aliases)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        filename,
        meta.displayTitle,
        meta.h1,
        JSON.stringify(meta.aliases),
      );
  }

  #deleteByFilename(filename: string): void {
    this.#db
      .prepare(`DELETE FROM notes_fts WHERE filename = ?`)
      .run(filename);
    this.#db
      .prepare(`DELETE FROM notes_tags WHERE filename = ?`)
      .run(filename);
    this.#db
      .prepare(`DELETE FROM notes_meta WHERE filename = ?`)
      .run(filename);
  }

  #fileExists(filename: string): boolean {
    try {
      return Deno.statSync(path.join(state.config.notesPath, filename))
        .isFile;
    } catch {
      return false;
    }
  }

  /** Kick off the batched full-index sync in the background
   * (Python: start_background_sync, daemon thread).
   * Two phases: prune/update (one transaction), then add-new (batched). */
  startBackgroundSync(): void {
    this.#runBackgroundSync();
  }

  async #runBackgroundSync(): Promise<void> {
    this.#status = { syncing: true, initial: false, done: 0, total: 0 };
    try {
      const fsFiles = new Set(state.notes.listAllNoteFilenames());
      const indexed = this.#allIndexedFilenames();
      // Full-precision mtimes (Python compares datetimes exactly; floored
      // seconds miss same-second external writes).
      const fsMtime = (filename: string) =>
        (Deno.statSync(path.join(state.config.notesPath, filename)).mtime
          ?.getTime() ?? 0) / 1000;

      // Prune deleted; update modified. Python stats each INDEXED file
      // directly for deletion (the filename-list cache must not hide
      // external deletes).
      const deleted = new Set<string>();
      for (const filename of indexed) {
        if (!this.#fileExists(filename)) {
          this.#deleteByFilename(filename);
          deleted.add(filename);
          logger.info(`'${filename}' removed from index`);
        } else {
          const dbMtime = this.#indexedMtime(filename);
          if (dbMtime !== fsMtime(filename)) {
            // File changed on disk since last index.
            this.reindexNote(this.#stripExt(filename));
            logger.info(`'${filename}' updated`);
          }
        }
      }

      // Add new — breadth-first so top-level notes are indexed early.
      const newFiles = [...fsFiles]
        .filter((f) => !indexed.includes(f))
        .sort((a, b) => a.split("/").length - b.split("/").length);
      this.#status.total = newFiles.length;
      const batchSize = Number(
        Deno.env.get("GLOBNOTES_INDEX_BATCH_SIZE") ?? "200",
      );
      const batchDelay =
        Number(Deno.env.get("GLOBNOTES_INDEX_BATCH_DELAY") ?? "0.1") * 1000;
      for (let i = 0; i < newFiles.length; i += batchSize) {
        const batch = newFiles.slice(i, i + batchSize);
        for (const filename of batch) {
          try {
            // Tolerate deletions mid-sync and external writes.
            this.#indexFile(filename);
          } catch {
            // Python: continue on FileNotFoundError
          }
        }
        this.#status.done += batch.length;
        if (batchDelay > 0) await delay(batchDelay);
      }
      if (newFiles.length > 0) {
        logger.info(`Initial index sync complete (${newFiles.length} notes)`);
      }
    } catch (e) {
      logger.error(`Background index sync failed: ${(e as Error).message}`);
    } finally {
      this.#status.initial = true;
      this.#status.syncing = false;
    }
  }

  /** Incremental sync before each search/tags call (Python
   * sync_index_with_retry after initial complete). Adds new notes,
   * removes deleted, updates modified. */
  syncIndex(): void {
    const indexed = this.#allIndexedFilenames();
    const fsFiles = state.notes.listAllNoteFilenames();
    const indexedSet = new Set(indexed);
    const deleted = new Set<string>();
    for (const filename of indexedSet) {
      // Python stats each indexed file directly (cache can't hide deletes).
      if (!this.#fileExists(filename)) {
        this.#deleteByFilename(filename);
        deleted.add(filename);
        logger.info(`'${filename}' removed from index`);
      }
    }
    for (const filename of fsFiles) {
      // Skip anything phase 1 just deleted (the scan cache may be stale).
      if (deleted.has(filename)) continue;
      if (!indexedSet.has(filename)) {
        try {
          this.#indexFile(filename);
          logger.info(`'${filename}' added to index`);
        } catch {
          // Tolerate deletions mid-scan (Python: continue on NotFound).
        }
      } else {
        const fsMtime =
          (Deno.statSync(path.join(state.config.notesPath, filename)).mtime
            ?.getTime() ?? 0) / 1000;
        if (fsMtime !== this.#indexedMtime(filename)) {
          this.#indexFile(filename);
          logger.info(`'${filename}' updated`);
        }
      }
    }
  }

  getTags(): string[] {
    if (this.#status.initial) this.syncIndex();
    return this.#db
      .prepare("SELECT DISTINCT tag FROM notes_tags ORDER BY tag")
      .all()
      .map((r) => (r as { tag: string }).tag);
  }

  /** SearchNotes: ported from file_system.py. Folder/nested filtering is
   * done in TS after the SQL fetch (same as Python). */
  search(
    term: string,
    sort: "score" | "title" | "last_modified" = "score",
    order: "asc" | "desc" = "desc",
    limit?: number,
    nested = true,
    folder?: string,
  ): SearchResult[] {
    // Python: sync_index_with_retry before every search, but only after
    // the initial sync completed (before that, only priority-reindexed
    // notes are visible).
    if (this.#status.initial) this.syncIndex();
    if (folder !== undefined) {
      isValidNotePath(folder);
    }
    const matchQuery = translateQuery(term);
    let results = this.#runSearch(
      matchQuery,
      sort,
      order,
      limit,
      nested,
      folder,
    );

    // Alias hits: exact (case-insensitive) alias match on the raw term,
    // merged in when not already present (Obsidian quick-switcher parity).
    if (matchQuery !== null) {
      const aliasTitle = this.resolveAlias(term);
      if (
        aliasTitle !== null &&
        !results.some((r) => this.#stripExt(r.filename) === aliasTitle)
      ) {
        const aliasRows = this.#runSearch(
          null,
          sort,
          order,
          undefined,
          true,
          undefined,
        )
          .filter((r) => this.#stripExt(r.filename) === aliasTitle);
        if (aliasRows.length > 0) {
          aliasRows[0].score = null;
          results = [...results, ...aliasRows];
        }
      }
    }
    if (limit !== undefined) {
      results = results.slice(0, limit);
    }
    return this.#toSearchResults(results, term);
  }

  #runSearch(
    matchQuery: string | null,
    sort: "score" | "title" | "last_modified",
    order: "asc" | "desc",
    limit: number | undefined,
    nested: boolean,
    folder: string | undefined,
  ): FtsRow[] {
    const bm25 = "bm25(notes_fts, 10.0, 1.0, 10.0, 0.0, 0.0)";
    const snippetExpr =
      `snippet(notes_fts, 1, '${MARK_OPEN}', '${MARK_CLOSE}', '…', ${SNIPPET_COLS})`;
    const highlightExpr =
      `highlight(notes_fts, 0, '${MARK_OPEN}', '${MARK_CLOSE}')`;

    // Python: Every() scores 1.0 for match-all; field-sorted searches get
    // score=None (hit.score is the field value, not a float); relevance
    // sort carries the bm25 score.
    const scoreExpr = matchQuery === null
      ? (sort === "score" ? "1.0 AS score" : "NULL AS score")
      : sort === "score"
      ? `${bm25} AS score`
      : "NULL AS score";

    let sql =
      `SELECT notes_fts.title, notes_fts.filename, notes_fts.tags, notes_fts.last_modified AS lastModified, meta.display_title AS displayTitle, ${scoreExpr}${
        matchQuery !== null
          ? `, ${highlightExpr} AS titleHighlights, ${snippetExpr} AS contentHighlights`
          : ""
      } FROM notes_fts
      LEFT JOIN notes_meta meta ON meta.filename = notes_fts.filename`;

    const args: (string | number)[] = [];
    if (matchQuery !== null) {
      sql += ` WHERE notes_fts MATCH ?`;
      args.push(matchQuery);
    }

    if (sort === "title" || sort === "last_modified") {
      sql += ` ORDER BY ${sort}`;
      sql += order === "desc" ? " DESC" : " ASC";
    } else if (matchQuery !== null) {
      // FTS5 bm25: lower is better. Python's score DESC (best first) maps
      // to bm25 ASC; order=asc flips it.
      sql += ` ORDER BY ${bm25} ${order === "asc" ? "DESC" : "ASC"}`;
    }
    // Match-all + relevance sort: natural rowid order == Whoosh docnum
    // order (both are index insertion order).

    const filterNeeded = folder !== undefined || !nested;
    if (limit !== undefined && !filterNeeded) {
      sql += " LIMIT ?";
      args.push(limit);
    }

    let rows = this.#db.prepare(sql).all(...args) as unknown as FtsRow[];

    if (filterNeeded) {
      rows = rows.filter((row) => this.#inScope(row.filename, folder, nested));
      if (limit !== undefined) rows = rows.slice(0, limit);
    }

    return rows;
  }

  #inScope(
    filename: string,
    folder: string | undefined,
    nested: boolean,
  ): boolean {
    const title = filename.slice(0, -MARKDOWN_EXT.length);
    if (folder !== undefined) {
      if (!(title === folder || title.startsWith(folder + "/"))) return false;
    }
    if (!nested) {
      const rest = folder ? title.slice(folder.length + 1) : title;
      if (rest.includes("/")) return false;
      return true;
    }
    return true;
  }

  /** Python: highlights exist only on fields that actually matched; the
   * tag_matches list carries the matched tag terms (whole-token,
   * lowercase, as indexed). */
  #toSearchResults(rows: FtsRow[], term: string): SearchResult[] {
    // Query fragments for tagMatches (Whoosh matched_terms parity): word
    // characters from the raw term. Phrase searches never match tags
    // (Python's _fieldnames_for_term).
    const fragments = term.includes('"')
      ? []
      : (term.match(/[\p{L}\p{N}_]+\*?/gu) ?? [])
        .map((f) => ({
          prefix: f.endsWith("*"),
          text: f.replace(/\*$/, "").toLowerCase(),
        }))
        .filter((f) => f.text !== "");
    return rows.map((row) => {
      let tagMatches: string[] | null = null;
      if (fragments.length > 0 && row.tags) {
        const matched = row.tags.split(" ").filter(Boolean).filter((tag) => {
          const lower = tag.toLowerCase();
          return fragments.some((f) =>
            f.prefix ? lower.startsWith(f.text) : lower === f.text
          );
        });
        if (matched.length > 0) {
          tagMatches = matched.map((t) => t.toLowerCase());
        }
      }
      const title = row.filename.slice(0, -MARKDOWN_EXT.length);
      return {
        title,
        displayTitle: row.displayTitle ?? title.split("/").pop() ?? title,
        lastModified: row.lastModified,
        score: row.score,
        titleHighlights: row.titleHighlights?.includes(MARK_OPEN)
          ? row.titleHighlights
          : null,
        contentHighlights: row.contentHighlights?.includes(MARK_OPEN)
          ? row.contentHighlights
          : null,
        tagMatches,
      };
    });
  }

  #allIndexedFilenames(): string[] {
    return this.#db
      .prepare("SELECT filename FROM notes_fts")
      .all()
      .map((r) => (r as { filename: string }).filename);
  }

  #indexedMtime(filename: string): number {
    const row = this.#db
      .prepare("SELECT last_modified FROM notes_fts WHERE filename = ?")
      .get(filename) as { last_modified: number } | undefined;
    return row?.last_modified ?? 0;
  }

  #stripExt(filename: string): string {
    const idx = filename.lastIndexOf(MARKDOWN_EXT);
    return idx > 0 ? filename.slice(0, idx) : filename;
  }

  #basename(filename: string): string {
    const base = filename.split("/").pop() ?? filename;
    const idx = base.lastIndexOf(MARKDOWN_EXT);
    return idx > 0 ? base.slice(0, idx) : base;
  }

  /** Display titles for a batch of filenames (sidebar tree labels). */
  displayTitlesFor(filenames: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    if (filenames.length === 0) return out;
    const marks = filenames.map(() => "?").join(",");
    const rows = this.#db
      .prepare(
        `SELECT filename, display_title FROM notes_meta WHERE filename IN (${marks})`,
      )
      .all(...filenames) as { filename: string; display_title: string }[];
    for (const r of rows) out[r.filename] = r.display_title;
    return out;
  }

  /** Resolve an alias to a note title (front-matter aliases, exact
   * case-insensitive match). Returns null when nothing claims it. */
  resolveAlias(target: string): string | null {
    const rows = this.#db
      .prepare(
        `SELECT filename FROM notes_meta
         WHERE EXISTS (
           SELECT 1 FROM json_each(notes_meta.aliases)
           WHERE lower(json_each.value) = lower(?)
         )`,
      )
      .all(target.trim()) as { filename: string }[];
    rows.sort((a, b) => a.filename.localeCompare(b.filename));
    return rows.length > 0 ? this.#stripExt(rows[0].filename) : null;
  }
}
