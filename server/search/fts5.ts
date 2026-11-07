// SPDX-License-Identifier: LGPL-3.0-only

import { DatabaseSync } from "node:sqlite";
import { createUuid } from "../../shared/uuid.ts";
import * as path from "@std/path";
import { type Environment, processEnvironment } from "@server/environment.ts";
import type { Indexer } from "@server/state.ts";
import { isReadableNotePath } from "@server/helpers.ts";
import { logger } from "@server/logger.ts";
import {
  pageWindow,
  type SearchPage,
  type SearchQuery,
  type SearchResult,
  type TagPage,
} from "@server/notes/models.ts";
import { state } from "@server/state.ts";
import { translateQuery } from "@server/search/query.ts";
import { extractTags } from "@server/search/tags.ts";
import { resolveTitleInfo } from "@server/search/titles.ts";

const MARKDOWN_EXT = ".md";
const SNIPPET_COLS = 48;
/** Whoosh parity: highlights wrap matches in <b class="match term0">. The
 * note text between marks is not escaped (server/mcp/snippets.ts). */
export const MARK_OPEN = '<b class="match term0">';
export const MARK_CLOSE = "</b>";

interface FtsRow {
  path: string;
  filename: string;
  /** Space-joined raw tags (for tagMatches computation). */
  tags: string;
  lastModified: number;
  score: number | null;
  pathHighlights: string | null;
  contentHighlights: string | null;
  /** Display title from notes_meta (join); falls back to basename. */
  title: string | null;
}

/** `x IN ${IN_LIST}` with one bound parameter, a JSON array: the way every
 * list reaches SQL here. One `?` per element would make the statement's
 * parameter count grow with the list, and SQLite refuses more than
 * SQLITE_MAX_VARIABLE_NUMBER (32,766 by default since 3.32.0; this
 * runtime's build), so a long list would fail the query. */
const IN_LIST = "(SELECT value FROM json_each(?))";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How the indexer reaches the disk: note reads and its database. The
 * defaults are the real ones; tests inject failures or instrumentation
 * through them (ARCHITECTURE: default adapters). */
export interface IndexerAdapters {
  readText(filepath: string): string;
  openDatabase(filepath: string): DatabaseSync;
}

export const fileAdapters: IndexerAdapters = {
  readText: (filepath) => Deno.readTextFileSync(filepath),
  openDatabase: (filepath) => new DatabaseSync(filepath),
};

export class Fts5Indexer implements Indexer {
  #db: DatabaseSync;
  #indexPath: string;
  #status = { syncing: false, initial: false, done: 0, total: 0, failed: 0 };
  readonly #environment: Environment;
  readonly #adapters: IndexerAdapters;
  #savepoints = 0;

  constructor(
    stateDir: string,
    environment: Environment = processEnvironment,
    adapters: Partial<IndexerAdapters> = {},
  ) {
    this.#environment = environment;
    this.#adapters = { ...fileAdapters, ...adapters };
    // The arg IS the state dir (index.sqlite's home) — no join; the
    // caller resolves GLOBNOTES_INDEX_PATH vs <vault>/.globnotes.
    Deno.mkdirSync(stateDir, { recursive: true });
    this.#indexPath = path.join(stateDir, "index.sqlite");
    this.#db = this.#adapters.openDatabase(this.#indexPath);
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
    failed: number;
  } {
    return {
      syncing: this.#status.syncing,
      initial: !this.#status.initial,
      done: this.#status.done,
      total: this.#status.total,
      failed: this.#status.failed,
    };
  }

  reindexNote(path: string): void {
    this.#indexFile(path + MARKDOWN_EXT);
  }

  /** Index one file by its vault-relative FILENAME — no title validation.
   * The filesystem is the source of truth: real vaults contain titles the
   * note API can't address (`?`, `:`, `*`…), and Python indexes them just
   * the same (its sync reads by filename, not via the validated path). */
  #indexFile(filename: string): void {
    const filepath = path.join(state.config.notesPath, filename);
    const content = this.#adapters.readText(filepath);
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
  }

  deleteFromIndex(path: string): void {
    this.#deleteByFilename(path + MARKDOWN_EXT);
  }

  /** Plan §3.2/§3.3: ordinary saves/indexing no longer respawn pools.
   * Change notifications are delivered at a serialized batch boundary
   * instead; render replicas receive legacy onSync broadcast, the service
   * runtime receives one on-sync fact. */
  #batchSynced(changedPaths: string[], initial: boolean): void {
    const fact = {
      operationId: createUuid(),
      action: "sync" as const,
      origin: "external" as const,
      timestamp: new Date().toISOString(),
      initial,
      changedPaths,
    };
    state.lifecycle?.syncCompleted(fact);
  }

  /** Run `fn` as one unit of index writes: a savepoint, which outside a
   * transaction is the transaction. Without one every statement is its own
   * commit, synced to disk (WAL, synchronous=FULL): indexing a note took
   * about 15 ms that way, so 10,000 notes took minutes and each batch held
   * the event loop for seconds (plans/mcp-v3 S1 row 5). */
  #transaction<T>(fn: () => T): T {
    const name = `index_write_${this.#savepoints++}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.#db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#db.exec(`ROLLBACK TO ${name}`);
      this.#db.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      this.#savepoints--;
    }
  }

  /** One note's work in a batched pass, as its own savepoint inside the
   * pass's transaction: a failure rolls back only that note's writes (an
   * indexed note keeps its previous entry) and is logged, so one unreadable
   * or vanished note never aborts the pass, the rest of its batch, the
   * new-file phase or the sync-completed event. A note that vanished
   * mid-pass is expected (an outside delete); any other failure is an
   * error. Returns whether the work completed. */
  #perNote(filename: string, what: "update" | "add", fn: () => void): boolean {
    try {
      this.#transaction(fn);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        logger.info(`'${filename}' vanished during the index ${what}`);
      } else {
        logger.error(
          `Index ${what} of '${filename}' failed; the other notes continue:`,
          error,
        );
      }
      return false;
    }
  }

  /** Insert/replace a note in the FTS table, the raw-tag table, and the
   * display-metadata table, as one unit. */
  #upsertNote(
    path: string,
    contentExTags: string,
    tagSet: Set<string>,
    filename: string,
    lastModified: number,
    titleInfo?: { title: string; h1: string | null; aliases: string[] },
  ): void {
    this.#transaction(() =>
      this.#writeNote(
        path,
        contentExTags,
        tagSet,
        filename,
        lastModified,
        titleInfo,
      )
    );
  }

  #writeNote(
    path: string,
    contentExTags: string,
    tagSet: Set<string>,
    filename: string,
    lastModified: number,
    titleInfo?: { title: string; h1: string | null; aliases: string[] },
  ): void {
    this.#deleteByFilename(filename);
    this.#db
      .prepare(
        `INSERT INTO notes_fts (title, content, tags, filename, last_modified)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        path,
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
      title: this.#basename(filename),
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
        meta.title,
        meta.h1,
        JSON.stringify(meta.aliases),
      );
  }

  #deleteByFilename(filename: string): void {
    this.#transaction(() => {
      this.#db
        .prepare(`DELETE FROM notes_fts WHERE filename = ?`)
        .run(filename);
      this.#db
        .prepare(`DELETE FROM notes_tags WHERE filename = ?`)
        .run(filename);
      this.#db
        .prepare(`DELETE FROM notes_meta WHERE filename = ?`)
        .run(filename);
    });
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
    this.#status = {
      syncing: true,
      initial: false,
      done: 0,
      total: 0,
      failed: 0,
    };
    try {
      const fsFiles = new Set(state.notes.listAllNoteFilenames());
      // All indexed mtimes in one scan: a lookup per file by filename is a
      // full scan of the FTS5 table each, quadratic in the vault size.
      const indexedMtimes = this.#indexedMtimes();
      const indexed = [...indexedMtimes.keys()];
      // Full-precision mtimes (Python compares datetimes exactly; floored
      // seconds miss same-second external writes).
      const fsMtime = (filename: string) =>
        (Deno.statSync(path.join(state.config.notesPath, filename)).mtime
          ?.getTime() ?? 0) / 1000;

      // Prune deleted; update modified. Python stats each INDEXED file
      // directly for deletion (the filename-list cache must not hide
      // external deletes).
      this.#transaction(() => {
        for (const filename of indexed) {
          this.#perNote(filename, "update", () => {
            if (!this.#fileExists(filename)) {
              this.#deleteByFilename(filename);
              logger.info(`'${filename}' removed from index`);
            } else if (indexedMtimes.get(filename) !== fsMtime(filename)) {
              // File changed on disk since last index.
              this.reindexNote(this.#stripExt(filename));
              logger.info(`'${filename}' updated`);
            }
          });
        }
      });

      // Add new — breadth-first so top-level notes are indexed early.
      const newFiles = [...fsFiles]
        .filter((f) => !indexedMtimes.has(f))
        .sort((a, b) => a.split("/").length - b.split("/").length);
      this.#status.total = newFiles.length;
      const batchSize = Number(
        this.#environment.get("GLOBNOTES_INDEX_BATCH_SIZE") ?? "200",
      );
      const batchDelay =
        Number(this.#environment.get("GLOBNOTES_INDEX_BATCH_DELAY") ?? "0.1") *
        1000;
      const added: string[] = [];
      for (let i = 0; i < newFiles.length; i += batchSize) {
        const batch = newFiles.slice(i, i + batchSize);
        const batchAdded: string[] = [];
        this.#transaction(() => {
          for (const filename of batch) {
            if (
              this.#perNote(filename, "add", () => this.#indexFile(filename))
            ) {
              batchAdded.push(filename);
            }
          }
        });
        // Facts and progress describe committed additions, never attempts.
        added.push(...batchAdded);
        this.#status.done += batchAdded.length;
        this.#status.failed += batch.length - batchAdded.length;
        if (batchDelay > 0) await delay(batchDelay);
      }
      if (newFiles.length > 0) {
        logger.info(
          `Initial index sync complete (${this.#status.done} indexed, ${this.#status.failed} failed of ${newFiles.length} notes)`,
        );
      }
      // Initial indexing is inventory plus on-sync — never fake creates.
      this.#batchSynced(
        added.map((f) => this.#stripExt(f)),
        true,
      );
    } catch (e) {
      logger.error(`Background index sync failed: ${(e as Error).message}`);
    } finally {
      this.#status.initial = true;
      this.#status.syncing = false;
    }
  }

  getTags(): string[] {
    return this.#tags(0, undefined, false).tags;
  }

  /** One page of the sorted tag list, windowed in the query. */
  tagsPage(offset = 0, limit?: number): TagPage {
    return this.#tags(offset, limit, true);
  }

  #tags(
    start: number,
    max: number | undefined,
    count: boolean,
  ): TagPage {
    const { offset, limit } = pageWindow(start, max);
    const tags = this.#db
      .prepare(
        "SELECT DISTINCT tag FROM notes_tags ORDER BY tag LIMIT ? OFFSET ?",
      )
      .all(limit ?? -1, offset)
      .map((r) => (r as { tag: string }).tag);
    const total = count
      ? (this.#db
        .prepare("SELECT count(DISTINCT tag) AS n FROM notes_tags")
        .get() as { n: number }).n
      : offset + tags.length;
    return { total, tags };
  }

  /** SearchNotes: ported from file_system.py, positional for the REST
   * route and plugins. One page of searchPage, without its total. */
  search(
    term: string,
    sort: "score" | "path" | "last_modified" = "score",
    order: "asc" | "desc" = "desc",
    limit?: number,
    nested = true,
    folder?: string,
    offset = 0,
  ): SearchResult[] {
    return this.#search(
      term,
      { sort, order, limit, nested, folder, offset },
      false,
    ).results;
  }

  /** One page of a search and the number of all its results. */
  searchPage(term: string, query: SearchQuery = {}): SearchPage {
    return this.#search(term, query, true);
  }

  /**
   * The search behind search() and searchPage(). The logical result list is
   * every FTS match in scope, in the requested order, then (for an exact
   * alias of the raw term whose note is not among those matches) the alias
   * note, unscoped, as Obsidian's quick switcher does. The page is a window
   * of that list cut in SQL: scope, order, LIMIT and OFFSET in the query,
   * snippets only for the page's rows, so a page's work and memory do not
   * grow with its offset and nothing outside it is materialized.
   */
  #search(term: string, query: SearchQuery, count: boolean): SearchPage {
    const { offset, limit } = pageWindow(query.offset, query.limit);
    // The index follows the hub's change log (server/hub/subscribers.ts):
    // a page reads it as it is, with no scan of the vault first.
    const sort = query.sort ?? "score";
    const order = query.order ?? "desc";
    // A folder filter names an existing folder: the read-path rule.
    if (query.folder !== undefined) isReadableNotePath(query.folder);
    const scope = this.#scope(query.folder, query.nested ?? true);
    const matchQuery = translateQuery(term);
    const rows = this.#pageRows(matchQuery, sort, order, scope, offset, limit);
    let matches: number | undefined = count
      ? this.#count(matchQuery, scope)
      : undefined;
    let total = matches;

    // Alias hits: exact (case-insensitive) alias match on the raw term,
    // after the matches when not already among them (Obsidian
    // quick-switcher parity).
    if (matchQuery !== null) {
      const aliasPath = this.resolveAlias(term);
      const aliasFile = aliasPath === null ? null : aliasPath + MARKDOWN_EXT;
      const alias = aliasFile === null ||
          this.#matches(matchQuery, scope, aliasFile)
        ? undefined
        : this.#noteRow(aliasFile);
      if (alias) {
        if (total !== undefined) total++;
        // The alias row's position is the number of matches; only a page
        // that is not full can reach it.
        if (limit === undefined || rows.length < limit) {
          matches ??= rows.length > 0
            ? offset + rows.length
            : this.#count(matchQuery, scope);
          if (matches === offset + rows.length) rows.push(alias);
        }
      }
    }
    return {
      total: total ?? offset + rows.length,
      results: this.#toSearchResults(rows, term),
    };
  }

  /** The SQL condition (and its arguments) for a search scope: inside
   * `folder` (the folder's own same-named note included, as before), and
   * without `nested` only its direct children. SQLite's length() and
   * substr() both count characters, so the prefix test is exact. */
  #scope(
    folder: string | undefined,
    nested: boolean,
  ): { sql: string; args: string[] } {
    const filename = "notes_fts.filename";
    if (folder === undefined) {
      return nested
        ? { sql: "", args: [] }
        : { sql: ` AND instr(${filename}, '/') = 0`, args: [] };
    }
    const prefix = folder + "/";
    const inside = `substr(${filename}, 1, length(?)) = ?`;
    const direct = nested
      ? ""
      : ` AND instr(substr(${filename}, length(?) + 1), '/') = 0`;
    return {
      sql: ` AND (${filename} = ? OR (${inside}${direct}))`,
      args: [
        folder + MARKDOWN_EXT,
        prefix,
        prefix,
        ...(nested ? [] : [prefix]),
      ],
    };
  }

  /** The page's rows: ordered, scoped and windowed by SQLite. Highlights
   * and snippets are computed afterwards for these rows only. */
  #pageRows(
    matchQuery: string | null,
    sort: "score" | "path" | "last_modified",
    order: "asc" | "desc",
    scope: { sql: string; args: string[] },
    offset: number,
    limit: number | undefined,
  ): FtsRow[] {
    const bm25 = "bm25(notes_fts, 10.0, 1.0, 10.0, 0.0, 0.0)";
    // Python: Every() scores 1.0 for match-all; field-sorted searches get
    // score=None (hit.score is the field value, not a float); relevance
    // sort carries the bm25 score.
    const scoreExpr = matchQuery === null
      ? (sort === "score" ? "1.0 AS score" : "NULL AS score")
      : sort === "score"
      ? `${bm25} AS score`
      : "NULL AS score";

    let sql =
      `SELECT notes_fts.rowid AS id, notes_fts.title AS path, notes_fts.filename, notes_fts.tags, notes_fts.last_modified AS lastModified, meta.display_title AS title, ${scoreExpr}
      FROM notes_fts
      LEFT JOIN notes_meta meta ON meta.filename = notes_fts.filename
      WHERE ${matchQuery !== null ? "notes_fts MATCH ?" : "1"}${scope.sql}`;
    const args: (string | number)[] = [
      ...(matchQuery !== null ? [matchQuery] : []),
      ...scope.args,
    ];

    // Index insertion order (rowid) breaks ties, so pages of one order
    // never overlap or skip. Match-all + relevance sort is that order
    // alone (== Whoosh docnum order).
    if (sort === "path" || sort === "last_modified") {
      sql += ` ORDER BY ${sort} ${order === "desc" ? "DESC" : "ASC"},`;
    } else if (matchQuery !== null) {
      // FTS5 bm25: lower is better. Python's score DESC (best first) maps
      // to bm25 ASC; order=asc flips it.
      sql += ` ORDER BY ${bm25} ${order === "asc" ? "DESC" : "ASC"},`;
    } else {
      sql += " ORDER BY";
    }
    sql += " notes_fts.rowid LIMIT ? OFFSET ?";
    args.push(limit ?? -1, offset);

    const rows = this.#db.prepare(sql).all(
      ...args,
    ) as unknown as (FtsRow & { id: number })[];
    if (matchQuery === null || rows.length === 0) return rows;

    // Highlights and snippets for the page's rows only (computing them in
    // the page query would compute them for every match before the sort).
    // The ids travel as one JSON parameter (IN_LIST), so the statement's
    // parameter count never grows with the page.
    const highlighted = new Map(
      (this.#db.prepare(
        `SELECT rowid AS id,
          highlight(notes_fts, 0, '${MARK_OPEN}', '${MARK_CLOSE}') AS pathHighlights,
          snippet(notes_fts, 1, '${MARK_OPEN}', '${MARK_CLOSE}', '…', ${SNIPPET_COLS}) AS contentHighlights
        FROM notes_fts WHERE notes_fts MATCH ? AND rowid IN ${IN_LIST}`,
      ).all(
        matchQuery,
        JSON.stringify(rows.map((row) => row.id)),
      ) as unknown as {
        id: number;
        pathHighlights: string | null;
        contentHighlights: string | null;
      }[]).map((row) => [row.id, row]),
    );
    return rows.map((row) => ({
      ...row,
      pathHighlights: highlighted.get(row.id)?.pathHighlights ?? null,
      contentHighlights: highlighted.get(row.id)?.contentHighlights ?? null,
    }));
  }

  /** How many notes the query matches in scope. */
  #count(
    matchQuery: string | null,
    scope: { sql: string; args: string[] },
  ): number {
    return (this.#db.prepare(
      `SELECT count(*) AS n FROM notes_fts WHERE ${
        matchQuery !== null ? "notes_fts MATCH ?" : "1"
      }${scope.sql}`,
    ).get(
      ...(matchQuery !== null ? [matchQuery] : []),
      ...scope.args,
    ) as { n: number }).n;
  }

  /** Whether the note `filename` is among the query's matches in scope. */
  #matches(
    matchQuery: string,
    scope: { sql: string; args: string[] },
    filename: string,
  ): boolean {
    return this.#db.prepare(
      `SELECT 1 FROM notes_fts WHERE notes_fts MATCH ?
        AND notes_fts.filename = ?${scope.sql} LIMIT 1`,
    ).get(matchQuery, filename, ...scope.args) !== undefined;
  }

  /** A note's result row without a score or highlights (an alias hit). */
  #noteRow(filename: string): FtsRow | undefined {
    const row = this.#db.prepare(
      `SELECT notes_fts.title AS path, notes_fts.filename, notes_fts.tags,
        notes_fts.last_modified AS lastModified,
        meta.display_title AS title, NULL AS score
      FROM notes_fts
      LEFT JOIN notes_meta meta ON meta.filename = notes_fts.filename
      WHERE notes_fts.filename = ? LIMIT 1`,
    ).get(filename) as FtsRow | undefined;
    return row &&
      { ...row, pathHighlights: null, contentHighlights: null };
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
      const path = row.filename.slice(0, -MARKDOWN_EXT.length);
      return {
        path,
        title: row.title ?? path.split("/").pop() ?? path,
        lastModified: row.lastModified,
        score: row.score,
        pathHighlights: row.pathHighlights?.includes(MARK_OPEN)
          ? row.pathHighlights
          : null,
        contentHighlights: row.contentHighlights?.includes(MARK_OPEN)
          ? row.contentHighlights
          : null,
        tagMatches,
      };
    });
  }

  /** Every indexed filename with its indexed mtime, in one scan. */
  #indexedMtimes(): Map<string, number> {
    const rows = this.#db
      .prepare("SELECT filename, last_modified FROM notes_fts")
      .all() as { filename: string; last_modified: number }[];
    return new Map(rows.map((r) => [r.filename, r.last_modified]));
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
  titlesFor(filenames: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    if (filenames.length === 0) return out;
    const rows = this.#db
      .prepare(
        `SELECT filename, display_title FROM notes_meta WHERE filename IN ${IN_LIST}`,
      )
      .all(JSON.stringify(filenames)) as {
        filename: string;
        display_title: string;
      }[];
    for (const r of rows) out[r.filename] = r.display_title;
    return out;
  }

  /** Display metadata (title + aliases) for a batch of bare note paths. */
  noteMetaFor(
    paths: string[],
  ): Record<string, { title: string; aliases: string[] }> {
    const out: Record<string, { title: string; aliases: string[] }> = {};
    if (paths.length === 0) return out;
    const filenames = paths.map((p) => p + MARKDOWN_EXT);
    const rows = this.#db
      .prepare(
        `SELECT filename, display_title, aliases FROM notes_meta WHERE filename IN ${IN_LIST}`,
      )
      .all(JSON.stringify(filenames)) as {
        filename: string;
        display_title: string;
        aliases: string;
      }[];
    for (const r of rows) {
      let aliases: string[] = [];
      try {
        aliases = JSON.parse(r.aliases);
      } catch {
        aliases = [];
      }
      out[r.filename.slice(0, -MARKDOWN_EXT.length)] = {
        title: r.display_title,
        aliases,
      };
    }
    return out;
  }

  /** Resolve an alias to a note title (front-matter aliases, exact
   * case-insensitive match). Returns null when nothing claims it. */
  resolveAlias(
    target: string,
    eligible?: (path: string) => boolean,
  ): string | null {
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
    const match = rows.find((row) =>
      !eligible || eligible(this.#stripExt(row.filename))
    );
    return match ? this.#stripExt(match.filename) : null;
  }
}
