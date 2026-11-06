// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The globnotes MCP tools (plans/v2-mcp/design.md §3). Each tool is a plain
 * definition: Zod 4 input and output schemas, annotations, and a `run`
 * function over an injected vault (server/mcp/vault.ts). `run` returns the
 * structured result and a one-line summary, which resultText emits with
 * the result's JSON as the text block; failures throw, and
 * server/mcp/server.ts turns them into tool errors the agent can act on.
 */

import * as z from "zod/v4";
import { isReadableNotePath, isValidNotePath } from "../helpers.ts";
import { noteVersion } from "../hub/merge.ts";
import type { NoteExpectation } from "../notes/expectation.ts";
import {
  InvalidPathError,
  type Note,
  NoteExistsError,
  NoteNotFoundError,
} from "../notes/models.ts";
import type { NoteMutationLease } from "../plugins/lifecycle.ts";
import { notFound, READ_ONLY_MESSAGE, ToolError } from "./errors.ts";
import { codePointLength, codePointSlice } from "./note_parts.ts";
import { highlightsToText } from "./snippets.ts";
import type { McpVault, SearchSort } from "./vault.ts";

/** Listing responses (search, folder, tags) stay under this size, counted
 * on what they send (emittedSize), by returning fewer entries, then by
 * shortening a lone oversized entry (mcp-builder; fitPage). A note read
 * stays under it too, in parts (globnotes_get_note). */
export const CHARACTER_LIMIT = 25_000;
/** Ends every text field shortened to fit CHARACTER_LIMIT. */
export const TRUNCATED = " ... [truncated]";
/** Texts are not shortened below this length (marker included) before
 * trailing matched tags are left out instead. */
export const MIN_FIELD_CHARS = 100;

export interface ToolContext {
  vault: McpVault;
  /** The caller's write authority; null on a read-only instance. */
  lease: NoteMutationLease | null;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodObject = z.ZodObject,
> {
  name: string;
  title: string;
  description: string;
  /** Write tools are listed only when the caller may write. */
  write: boolean;
  inputSchema: I;
  outputSchema: O;
  annotations: ToolAnnotations;
  run(args: z.output<I>, ctx: ToolContext): Promise<ToolOutput<z.output<O>>>;
}

/** A successful result before it is emitted: the structured result and
 * at most one line summarizing it. */
export interface ToolOutput<S> {
  structured: S;
  summary: string;
}

/**
 * The text block of a successful result: the summary line, then the whole
 * structured result as JSON. MCP: a tool that returns structured content
 * SHOULD also return it serialized in a text block, so a client that reads
 * only text (or passes only text to its model) loses nothing.
 */
export function resultText(output: ToolOutput<unknown>): string {
  const summary = output.summary.replace(/[\r\n]+/g, " ");
  return `${summary}\n${JSON.stringify(output.structured)}`;
}

/** The characters a result sends the client: its text block plus its
 * structured content. CHARACTER_LIMIT applies to this. */
export function emittedSize(output: ToolOutput<unknown>): number {
  return resultText(output).length + JSON.stringify(output.structured).length;
}

/** A user-supplied value in a summary line: quoted and escaped, so the
 * summary stays one line whatever the value holds. */
const quote = (value: string) => JSON.stringify(value);

/** Identity helper that infers a definition's schema types for `run`. */
export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(
  definition: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return definition;
}

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** ISO 8601 (UTC, milliseconds) for a note's lastModified (Unix seconds). */
export function isoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** A path argument: any text the storage rules then judge, except NUL,
 * which no file name can hold. */
const pathText = () =>
  z.string().regex(/^[^\0]*$/, "must not contain NUL characters");

const notePath = pathText().min(1).describe(
  "Note path relative to the vault root, without the .md extension, e.g. " +
    "'Projects/Garden plan'. Folders are separated by '/'.",
);

const expectedLastModified = z.iso.datetime({ offset: true }).optional()
  .describe(
    "Stale-write guard: the last_modified value you read (from " +
      "globnotes_get_note or a search result). If the note changed since, " +
      "nothing is written and you are asked to re-read it. Update and " +
      "delete need this or expected_hash.",
  );

const expectedHash = z.string().regex(
  /^[0-9a-fA-F]{64}$/,
  "must be the 64-character hex hash a note read returned",
).optional().describe(
  "Stale-write guard by content: the hash you read (from globnotes_get_note, " +
    "or the result of a create or update). If the note's content changed " +
    "since, nothing is written and you are asked to re-read it. Unlike " +
    "last_modified it also catches changes within the same millisecond. " +
    "Update and delete need this or expected_last_modified; with both, both " +
    "must match.",
);

/** The stale-write guard a write tool's arguments ask for (design §2 row 9;
 * checked by NoteOperations under the note lock, server/notes/expectation.ts). */
function expectation(
  args: { expected_last_modified?: string; expected_hash?: string },
): NoteExpectation | undefined {
  if (
    args.expected_last_modified === undefined &&
    args.expected_hash === undefined
  ) return undefined;
  return {
    ...(args.expected_last_modified === undefined
      ? {}
      : { lastModifiedMs: new Date(args.expected_last_modified).getTime() }),
    ...(args.expected_hash === undefined
      ? {}
      : { hash: args.expected_hash.toLowerCase() }),
  };
}

/** Every write states what it read: update (renames included) and delete
 * need at least one guard. */
function requiredExpectation(
  args: {
    path: string;
    expected_last_modified?: string;
    expected_hash?: string;
  },
  action: "update" | "delete",
): NoteExpectation {
  const expect = expectation(args);
  if (!expect) {
    throw new ToolError(
      `Nothing was ${action === "update" ? "written" : "deleted"}: pass ` +
        "expected_last_modified or expected_hash (or both) from " +
        `globnotes_get_note for '${args.path}', so a note changed since you ` +
        "read it is not overwritten.",
    );
  }
  return expect;
}

const NoteOutput = z.object({
  path: z.string().describe("Note path (no .md extension)"),
  title: z.string().describe(
    "Display title: front-matter title, else first H1, else file name",
  ),
  content: z.string().describe("Full Markdown content"),
  last_modified: z.string().describe(
    "Last modification time, ISO 8601 (UTC)",
  ),
  hash: z.string().describe(
    "SHA-256 of the whole note's content (hex); pass as expected_hash to " +
      "the write tools",
  ),
});

/** Validate an agent-supplied path the way the REST API does (trimmed,
 * then the create-time rule for a new name, or the read-path rule for an
 * existing folder), as a tool error. */
function validPath(
  value: string,
  what = "path",
  rule: (value: string) => string = isValidNotePath,
): string {
  const trimmed = value.trim();
  try {
    return rule(trimmed);
  } catch (error) {
    throw new ToolError(
      `Invalid ${what} '${value}': ${(error as Error).message}.`,
    );
  }
}

function writeLease(ctx: ToolContext): NoteMutationLease {
  if (!ctx.lease) throw new ToolError(READ_ONLY_MESSAGE);
  return ctx.lease;
}

function noteOutput(note: Note): z.output<typeof NoteOutput> {
  return {
    path: note.path,
    title: note.title,
    content: note.content ?? "",
    last_modified: isoTime(note.lastModified),
    hash: noteVersion(note),
  };
}

/** Run a vault call naming `path`; a missing note becomes the agent-facing
 * not-found error (other errors pass through to toolErrorMessage). */
function readNote(ctx: ToolContext, path: string): Note {
  try {
    return ctx.vault.getNote(path);
  } catch (error) {
    if (error instanceof NoteNotFoundError) throw notFound(path);
    throw error;
  }
}

/** SQLite's own words for query text FTS5 can't parse (an unbalanced
 * double quote, for one); the index passes them through as errors. */
const QUERY_SYNTAX =
  /^(fts5: syntax error|unterminated string|unknown special query)/;

/** Run a search; a query the index can't parse becomes a tool error about
 * the query (other failures pass through to describeToolError). */
function searchIndex<T>(query: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === "ERR_SQLITE_ERROR" && QUERY_SYNTAX.test((error as Error).message)
    ) {
      throw new ToolError(
        `The search index can't parse the query '${query}'. Check that ` +
          'double quotes come in pairs ("exact phrase"), or search for ' +
          "plain words.",
      );
    }
    throw error;
  }
}

// ---- globnotes_search_notes ----

const SearchHit = z.object({
  path: z.string(),
  title: z.string(),
  last_modified: z.string().describe("ISO 8601 (UTC)"),
  score: z.number().optional().describe(
    "Relevance (higher is better); only when sorted by score",
  ),
  snippet: z.string().describe(
    "Plain-text excerpt with the matches marked «like this». A match only " +
      "in the path shows the marked path; empty when no content or path " +
      "text matched (a tag-only match, or query='*')",
  ),
  matched_tags: z.array(z.string()).describe("Tags the query matched"),
  truncated: z.array(z.enum(["snippet", "matched_tags", "title"])).optional()
    .describe(
      "Only when this single result alone exceeded the response size " +
        "limit: the fields that were shortened. snippet, title and each " +
        "matched tag are cut to one common maximum length, the longest " +
        "first; if that is not enough, trailing tags are left out (see " +
        "omitted_tags). A shortened text ends in ' ... [truncated]'. path is " +
        "never shortened; read the full note with globnotes_get_note",
    ),
  omitted_tags: z.number().int().optional().describe(
    "Matched tags left out of matched_tags to fit the size limit",
  ),
});

type SearchHitOutput = z.output<typeof SearchHit>;
type ShortenedField = "snippet" | "matched_tags" | "title";

/** The largest n in [low, high] with fits(n), or null (bisection; fits is
 * monotone in n). */
function largest(low: number, high: number, fits: (n: number) => boolean) {
  if (!fits(low)) return null;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * The one size rule for every listing tool (search, folder, tags): render
 * the requested window; while what it emits (emittedSize) is over
 * CHARACTER_LIMIT, return fewer items (halving; `render` sets
 * has_more/next_offset after the last item shown); a single item still over
 * the limit is shortened by `fitOne` (marked), never dropped.
 * `fitOne(item, excess)` gets how far the page rendered with an item is over
 * the limit.
 */
function fitPage<T, S>(
  window: T[],
  render: (page: T[]) => ToolOutput<S>,
  fitOne: (item: T, excess: (item: T) => number) => T,
): ToolOutput<S> {
  let page = window;
  let result = render(page);
  while (page.length > 1 && emittedSize(result) > CHARACTER_LIMIT) {
    page = page.slice(0, Math.ceil(page.length / 2));
    result = render(page);
  }
  if (page.length === 1 && emittedSize(result) > CHARACTER_LIMIT) {
    result = render([
      fitOne(page[0], (item) => emittedSize(render([item])) - CHARACTER_LIMIT),
    ]);
  }
  return result;
}

/** `text` shortened (marked) to the largest length at which `excess` of
 * the result is not positive; the text itself when it already fits. */
function fitText(text: string, excess: (text: string) => number): string {
  if (excess(text) <= 0) return text;
  const max = largest(
    TRUNCATED.length,
    [...text].length,
    (n) => excess(capText(text, n)) <= 0,
  );
  return capText(text, max ?? TRUNCATED.length);
}

/** `text` cut to at most `max` code points, the last ones being TRUNCATED. */
function capText(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - TRUNCATED.length)).join("") +
    TRUNCATED;
}

/**
 * Fit a single search result into the response budget. `excess(hit)` is how
 * far the page rendered with `hit` is over CHARACTER_LIMIT. One rule covers
 * every variable-size field: snippet, title and each matched tag are cut to
 * one common maximum length, the largest that fits (so the longest field is
 * shortened first and short ones stay whole). If even MIN_FIELD_CHARS does
 * not fit (only many tags can cause that), trailing tags are left out and
 * counted in omitted_tags; then, as a last resort, the cap goes lower. Every
 * shortened text ends in TRUNCATED and `truncated` names each shortened
 * field. `path` is the note's identity for globnotes_get_note and is never
 * shortened; it is bounded (segments of at most 255 bytes, and a file
 * globnotes can read fits the OS path limit, 4,096 bytes on Linux), so the
 * other fields can make room for it.
 */
export function fitHit(
  hit: SearchHitOutput,
  excess: (hit: SearchHitOutput) => number,
): SearchHitOutput {
  if (excess(hit) <= 0) return hit;
  const tags = hit.matched_tags;
  const shaped = (max: number, keepTags: number): SearchHitOutput => {
    const snippet = capText(hit.snippet, max);
    const title = capText(hit.title, max);
    const kept = tags.slice(0, keepTags).map((tag) => capText(tag, max));
    const truncated: ShortenedField[] = [];
    if (snippet !== hit.snippet) truncated.push("snippet");
    if (keepTags < tags.length || kept.some((tag, i) => tag !== tags[i])) {
      truncated.push("matched_tags");
    }
    if (title !== hit.title) truncated.push("title");
    return {
      ...hit,
      title,
      snippet,
      matched_tags: kept,
      ...(keepTags < tags.length
        ? { omitted_tags: tags.length - keepTags }
        : {}),
      ...(truncated.length ? { truncated } : {}),
    };
  };
  const longest = Math.max(
    [...hit.snippet].length,
    [...hit.title].length,
    ...tags.map((tag) => [...tag].length),
  );
  const all = tags.length;
  const fitsAt = (max: number, keepTags: number) =>
    excess(shaped(max, keepTags)) <= 0;
  const cap = largest(MIN_FIELD_CHARS, longest, (max) => fitsAt(max, all));
  if (cap !== null) return shaped(cap, all);
  const keep = largest(0, all, (n) => fitsAt(MIN_FIELD_CHARS, n));
  if (keep !== null) return shaped(MIN_FIELD_CHARS, keep);
  const low = largest(
    TRUNCATED.length,
    MIN_FIELD_CHARS,
    (max) => fitsAt(max, 0),
  );
  return shaped(low ?? TRUNCATED.length, 0);
}

const SearchOutput = z.object({
  total: z.number().int().describe(
    "Number of all results of this search (exact), not only this page's",
  ),
  count: z.number().int().describe("Results in this page"),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional().describe(
    "Pass as offset to get the next page (only when has_more)",
  ),
  results: z.array(SearchHit),
});

export const searchNotes = defineTool({
  name: "globnotes_search_notes",
  title: "Search notes",
  description:
    `Full-text search over the vault's notes (titles, content and tags). Returns one page of matches with a plain-text snippet; when has_more is true, call again with offset=next_offset.

Query syntax:
  - words: every word must match (case-insensitive), e.g. "garden compost"
  - "exact phrase" in double quotes, e.g. "\\"weekly review\\""
  - #tag: notes carrying that tag, e.g. "#recipe"
  - prefix*: words starting with prefix, e.g. "photo*"
  - * alone: every note (combine with sort=lastModified to see recent notes)

Examples: recent notes -> query="*", sort="lastModified"; notes tagged travel about Japan -> query="#travel japan"; only the Work folder -> folder="Work".
Use globnotes_get_note to read a result in full, globnotes_list_folder to browse.`,
  write: false,
  inputSchema: z.strictObject({
    query: z.string().min(1).max(500).describe(
      "Search query in globnotes syntax (see the tool description)",
    ),
    folder: pathText().optional().describe(
      "Only search inside this folder, e.g. 'Work/2024'",
    ),
    include_subfolders: z.boolean().default(true).describe(
      "With folder (or at the root): also search subfolders",
    ),
    sort: z.enum(["score", "path", "lastModified"]).default("score")
      .describe("score = relevance, path = alphabetical, lastModified = time"),
    order: z.enum(["asc", "desc"]).default("desc").describe(
      "desc = best/latest/Z first, asc = the reverse",
    ),
    limit: z.number().int().min(1).max(100).default(20).describe(
      "Maximum results in this page",
    ),
    offset: z.number().int().min(0).default(0).describe(
      "Results to skip, for pagination",
    ),
  }),
  outputSchema: SearchOutput,
  annotations: READ,
  run(args, ctx) {
    const folderArg = args.folder?.trim().replace(/^\/+|\/+$/g, "");
    const folder = folderArg
      ? validPath(folderArg, "folder", isReadableNotePath)
      : undefined;
    const sort: SearchSort = args.sort === "lastModified"
      ? "last_modified"
      : args.sort;
    // The index cuts the page and counts all matches.
    const found = searchIndex(args.query, () =>
      ctx.vault.search(args.query, {
        sort,
        order: args.order,
        nested: args.include_subfolders,
        folder,
        offset: args.offset,
        limit: args.limit,
      }));
    const hits: SearchHitOutput[] = found.results.map((r) => ({
      path: r.path,
      title: r.title,
      last_modified: isoTime(r.lastModified),
      ...(typeof r.score === "number" ? { score: r.score } : {}),
      snippet: highlightsToText(r.contentHighlights ?? r.pathHighlights),
      matched_tags: r.tagMatches ?? [],
    }));
    const render = (page: typeof hits) => {
      const end = args.offset + page.length;
      const hasMore = found.total > end;
      const structured = {
        total: found.total,
        count: page.length,
        offset: args.offset,
        has_more: hasMore,
        ...(hasMore ? { next_offset: end } : {}),
        results: page,
      };
      const scope = folder === undefined ? "" : ` in folder ${quote(folder)}`;
      let summary = page.length === 0
        ? `No results for ${quote(args.query)}${scope}${
          args.offset > 0
            ? ` at offset ${args.offset} (${found.total} in all)`
            : ""
        }. Try fewer or different words, a prefix* or query="*".`
        : `Results ${args.offset + 1}-${end} of ${found.total} for ${
          quote(args.query)
        }${scope}.`;
      if (page.some((hit) => hit.truncated)) {
        summary += " A result was shortened to fit the response limit " +
          "(see truncated); read the whole note with globnotes_get_note.";
      }
      if (hasMore) summary += ` More results: call again with offset=${end}.`;
      return { structured, summary };
    };
    // One hit can exceed the budget alone: the index's snippet window
    // counts tokens, not characters (one long word makes a long snippet),
    // and titles and tags have no length limit; fitHit shortens it.
    return Promise.resolve(fitPage(hits, render, fitHit));
  },
});

// ---- globnotes_get_note ----

const GetNoteOutput = NoteOutput.extend({
  content: z.string().describe(
    "Markdown content: the whole note, or, when has_more is true or offset " +
      "is above 0, the part from offset (in characters)",
  ),
  offset: z.number().int().describe("Characters of the note before content"),
  total_length: z.number().int().describe(
    "Characters (Unicode code points) in the whole note",
  ),
  has_more: z.boolean().describe(
    "true when the note continues after content: this is a part only",
  ),
  next_offset: z.number().int().optional().describe(
    "Pass as offset to read the next part (only when has_more)",
  ),
  truncated: z.array(z.enum(["title"])).optional().describe(
    "Only when the display title alone would take over half the response " +
      "limit: it was shortened (ends in ' ... [truncated]'); the content " +
      "never is",
  ),
});

export const getNote = defineTool({
  name: "globnotes_get_note",
  title: "Read a note",
  description:
    `Read one note: its Markdown content, display title, last_modified and hash (pass them to the write tools' expected_last_modified and expected_hash to avoid overwriting newer edits; every part of a note has the same hash). Find paths with globnotes_search_notes or globnotes_list_folder.

A note too large for one response comes in parts: has_more is true and content holds the characters from offset to next_offset; call again with offset=next_offset until has_more is false. offset and length (characters) read a chosen range. Read every part before replacing a note with globnotes_update_note, which always replaces the whole note.`,
  write: false,
  inputSchema: z.strictObject({
    path: notePath,
    offset: z.number().int().min(0).default(0).describe(
      "Characters (Unicode code points) to skip from the start of the note",
    ),
    length: z.number().int().min(1).optional().describe(
      "At most this many characters; omit for as much as fits the response " +
        "limit (the whole note when it fits)",
    ),
  }),
  outputSchema: GetNoteOutput,
  annotations: READ,
  run(args, ctx) {
    const note = noteOutput(readNote(ctx, args.path));
    const total = codePointLength(note.content);
    const start = Math.min(args.offset, total);
    const render = (content: string, title = note.title) => {
      const end = start + codePointLength(content);
      const hasMore = end < total;
      const structured = {
        ...note,
        title,
        content,
        offset: start,
        total_length: total,
        has_more: hasMore,
        ...(hasMore ? { next_offset: end } : {}),
        ...(title === note.title ? {} : { truncated: ["title" as const] }),
      };
      const whole = start === 0 && !hasMore;
      return {
        structured,
        summary: `Note ${
          quote(note.path)
        }, last_modified ${note.last_modified}, ${total} characters${
          whole
            ? "."
            : `. PARTIAL: characters ${start}-${end} of ${total}.${
              hasMore
                ? ` Call again with offset=${end} for the rest; read the ` +
                  "whole note before replacing it with globnotes_update_note."
                : ""
            }`
        }${
          title === note.title
            ? ""
            : " The title was shortened to fit the response limit."
        }`,
      };
    };
    // A display title too long to leave half the response for content is
    // shortened (marked), as the listings do; the content never is.
    const title = fitText(
      note.title,
      (t) => emittedSize(render("", t)) - CHARACTER_LIMIT / 2,
    );
    // A part is never larger than the response limit allows. Both copies
    // of content (text and structured) count, so more than CHARACTER_LIMIT
    // characters can never fit: cut there first, then find the longest
    // prefix that fits. At least one character is returned, so reading
    // in parts always advances.
    const wanted = Array.from(codePointSlice(
      note.content,
      start,
      Math.min(args.length ?? Infinity, CHARACTER_LIMIT),
    ));
    const part = (n: number) => render(wanted.slice(0, n).join(""), title);
    const fits = (n: number) => emittedSize(part(n)) <= CHARACTER_LIMIT;
    const count = fits(wanted.length)
      ? wanted.length
      : largest(Math.min(1, wanted.length), wanted.length, fits) ??
        Math.min(1, wanted.length);
    return Promise.resolve(part(count));
  },
});

// ---- globnotes_list_folder ----

/** Pagination fields shared by the listing tools whose full list is known. */
const ListPage = {
  total: z.number().int().describe("Entries in the whole list"),
  count: z.number().int().describe("Entries in this page"),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional().describe(
    "Pass as offset to get the next page (only when has_more)",
  ),
};

/** The page fields for a window of `count` entries out of `total`. */
function listPage(total: number, offset: number, count: number) {
  const end = offset + count;
  return {
    total,
    count,
    offset,
    has_more: total > end,
    ...(total > end ? { next_offset: end } : {}),
  };
}

const pageInput = (fallback: number, max: number, what: string) => ({
  limit: z.number().int().min(1).max(max).default(fallback).describe(
    `Maximum ${what} in this page`,
  ),
  offset: z.number().int().min(0).default(0).describe(
    `${what[0].toUpperCase()}${what.slice(1)} to skip, for pagination`,
  ),
});

const FolderNote = z.object({
  path: z.string(),
  title: z.string(),
  truncated: z.array(z.enum(["title"])).optional().describe(
    "Only when this note alone exceeded the response size limit: its title " +
      "was shortened (ends in ' ... [truncated]'); path is never shortened",
  ),
});

const FolderOutput = z.object({
  path: z.string().describe("The folder listed ('' = the vault root)"),
  ...ListPage,
  folders: z.array(z.object({ name: z.string(), path: z.string() })).describe(
    "Subfolders in this page (they come before the notes)",
  ),
  notes: z.array(FolderNote).describe("Notes in this page"),
});

type FolderEntry =
  | { kind: "folder"; name: string; path: string }
  | { kind: "note"; note: z.output<typeof FolderNote> };

export const listFolder = defineTool({
  name: "globnotes_list_folder",
  title: "List a folder",
  description:
    "List one folder of the vault: its subfolders, then the notes directly inside it (not recursive), one page at a time; when has_more is true, call again with offset=next_offset. Omit path for the vault root, then pass a folder's path to go deeper. To find notes by content use globnotes_search_notes instead.",
  write: false,
  inputSchema: z.strictObject({
    path: pathText().default("").describe(
      "Folder path, e.g. 'Projects/2024'; '' or omitted = the vault root",
    ),
    ...pageInput(100, 500, "entries"),
  }),
  outputSchema: FolderOutput,
  annotations: READ,
  run(args, ctx) {
    const path = args.path.trim().replace(/^\/+|\/+$/g, "");
    let level;
    try {
      level = ctx.vault.listFolder(path, args.offset, args.limit);
    } catch (error) {
      if (error instanceof NoteNotFoundError) {
        throw new ToolError(
          `Folder '${path}' not found. Call globnotes_list_folder without ` +
            "a path to see the top-level folders.",
        );
      }
      if (error instanceof InvalidPathError) {
        throw new ToolError(`Invalid folder '${path}': ${error.message}.`);
      }
      throw error;
    }
    // The storage layer returned this page's window only.
    const window: FolderEntry[] = [
      ...level.folders.map((f) => ({ kind: "folder" as const, ...f })),
      ...level.notes.map((note) => ({ kind: "note" as const, note })),
    ];
    const render = (page: FolderEntry[]) => {
      const folders = page.flatMap((e) =>
        e.kind === "folder" ? [{ name: e.name, path: e.path }] : []
      );
      const notes = page.flatMap((e) => e.kind === "note" ? [e.note] : []);
      const structured = {
        path,
        ...listPage(level.total, args.offset, page.length),
        folders,
        notes,
      };
      const end = args.offset + page.length;
      let summary = `Folder ${
        quote(path || "/")
      }: ${level.folderCount} folder(s), ${level.noteCount} note(s)${
        level.total === 0
          ? "."
          : page.length === 0
          ? `; none at offset ${args.offset}.`
          : `; entries ${args.offset + 1}-${end} of ${level.total}.`
      }`;
      if (notes.some((n) => n.truncated)) {
        summary += " A title was shortened to fit the response limit.";
      }
      if (structured.has_more) {
        summary += ` More entries: call again with offset=${end}.`;
      }
      return { structured, summary };
    };
    return Promise.resolve(fitPage(
      window,
      render,
      (entry, excess): FolderEntry => {
        // Folder entries are bounded (a name is one path segment); a note's
        // title is not, and its path is its identity.
        if (entry.kind === "folder") return entry;
        const { note } = entry;
        const title = fitText(note.title, (t) =>
          excess({
            kind: "note",
            note: { ...note, title: t, truncated: ["title"] },
          }));
        return title === note.title ? entry : {
          kind: "note",
          note: { ...note, title, truncated: ["title"] },
        };
      },
    ));
  },
});

// ---- globnotes_list_tags ----

const TagsOutput = z.object({
  ...ListPage,
  tags: z.array(z.string()).describe(
    "Tags in this page, in the vault's tag order",
  ),
  truncated: z.boolean().optional().describe(
    "Only when the one tag on this page alone exceeded the response size " +
      "limit: it was shortened (ends in ' ... [truncated]'); search its notes " +
      "with its beginning and a trailing *, e.g. query='#abc*'",
  ),
});

export const listTags = defineTool({
  name: "globnotes_list_tags",
  title: "List tags",
  description:
    "List the tags used in the vault (lowercase, without '#'), one page at a time; when has_more is true, call again with offset=next_offset. Search a tag's notes with globnotes_search_notes and query='#tag'.",
  write: false,
  inputSchema: z.strictObject({ ...pageInput(500, 2000, "tags") }),
  outputSchema: TagsOutput,
  annotations: READ,
  run(args, ctx) {
    // The index returned this page's window only.
    const found = ctx.vault.tags(args.offset, args.limit);
    const render = (page: { tag: string; truncated: boolean }[]) => {
      const structured = {
        ...listPage(found.total, args.offset, page.length),
        tags: page.map((t) => t.tag),
        ...(page.some((t) => t.truncated) ? { truncated: true } : {}),
      };
      const end = args.offset + page.length;
      let summary = found.total === 0
        ? "The vault has no tags."
        : page.length === 0
        ? `The vault has ${found.total} tag(s); none at offset ${args.offset}.`
        : `Tags ${args.offset + 1}-${end} of ${found.total}.`;
      if (structured.truncated) {
        summary += " The tag was shortened to fit the response limit.";
      }
      if (structured.has_more) {
        summary += ` More tags: call again with offset=${end}.`;
      }
      return { structured, summary };
    };
    return Promise.resolve(fitPage(
      found.tags.map((tag) => ({
        tag,
        truncated: false,
      })),
      render,
      (item, excess) => {
        const tag = fitText(
          item.tag,
          (t) => excess({ tag: t, truncated: true }),
        );
        return tag === item.tag ? item : { tag, truncated: true };
      },
    ));
  },
});

// ---- globnotes_create_note ----

export const createNote = defineTool({
  name: "globnotes_create_note",
  title: "Create a note",
  description:
    "Create a new note. Missing folders in the path are created. Fails if a note already exists at the path (then use globnotes_update_note). Returns the created note.",
  write: true,
  inputSchema: z.strictObject({
    path: notePath,
    content: z.string().describe("Markdown content, e.g. '# Title\\n\\nBody'"),
  }),
  outputSchema: NoteOutput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run(args, ctx) {
    const lease = writeLease(ctx);
    const path = validPath(args.path);
    const note = noteOutput(
      await ctx.vault.createNote({ path, content: args.content }, lease),
    );
    return {
      structured: note,
      summary: `Created note ${
        quote(note.path)
      }, last_modified ${note.last_modified}.`,
    };
  },
});

// ---- globnotes_update_note ----

const UpdateOutput = NoteOutput.extend({
  moved_files: z.array(
    z.object({ old_path: z.string(), new_path: z.string() }),
  ).describe("Attachments moved along with a renamed note"),
});

export const updateNote = defineTool({
  name: "globnotes_update_note",
  title: "Update or rename a note",
  description:
    `Replace a note's content, rename/move it, or both. The new content replaces the whole note, so read it first with globnotes_get_note (every part, while has_more is true) and pass its last_modified as expected_last_modified and its hash as expected_hash (at least one is required, also for a rename).

Like the web app, changing the first '# Heading' of a note without a front-matter title renames the note to match; the result's path is the final path.
Examples: fix a typo -> path + content + expected_last_modified + expected_hash; move to another folder -> path + new_path="Archive/Old plan".`,
  write: true,
  inputSchema: z.strictObject({
    path: notePath,
    content: z.string().optional().describe(
      "New Markdown content (the whole note). Omit to only rename",
    ),
    new_path: pathText().optional().describe(
      "New path to rename/move the note to. Omit to keep the path",
    ),
    expected_last_modified: expectedLastModified,
    expected_hash: expectedHash,
    file_refs: z.enum(["none", "move", "relink"]).default("none").describe(
      "On rename, what happens to attachments the note links with relative " +
        "paths: none = leave them, move = move them with the note, relink = " +
        "rewrite the links to keep pointing at them",
    ),
  }),
  outputSchema: UpdateOutput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run(args, ctx) {
    const lease = writeLease(ctx);
    if (args.content === undefined && args.new_path === undefined) {
      throw new ToolError(
        "Nothing to change: pass content, new_path or both.",
      );
    }
    const newPath = args.new_path === undefined
      ? undefined
      : validPath(args.new_path, "new_path");
    const expect = requiredExpectation(args, "update");
    let note;
    try {
      note = await ctx.vault.updateNote(
        args.path,
        { newContent: args.content, newPath },
        args.file_refs,
        lease,
        expect,
      );
    } catch (error) {
      // The note that exists is at the target, not at `path`.
      if (error instanceof NoteExistsError) {
        throw renameCollision(args.path, newPath);
      }
      throw error;
    }
    const structured = {
      ...noteOutput(note),
      moved_files: note.movedFiles.map((f) => ({
        old_path: f.oldPath,
        new_path: f.newPath,
      })),
    };
    const moved = structured.moved_files.length;
    return {
      structured,
      summary: `Updated note ${quote(args.path)}${
        note.path === args.path ? "" : `, now at ${quote(note.path)}`
      }, last_modified ${structured.last_modified}${
        moved ? `; ${moved} attachment(s) moved` : ""
      }.`,
    };
  },
});

/** NoteExistsError from an update: the note in the way is at the target
 * path (new_path, or the one the new first heading derives), not at
 * `path`. */
function renameCollision(path: string, newPath: string | undefined) {
  return new ToolError(
    newPath === undefined
      ? `Note '${path}' can't be renamed to match its new first heading: a ` +
        "note with that name already exists in its folder. Re-read the " +
        "note, then change the heading or pass new_path."
      : `Note '${path}' can't be moved to '${newPath}': a note already ` +
        "exists there. Re-read the note, then choose another new_path.",
  );
}

// ---- globnotes_delete_note ----

const DeleteOutput = z.object({
  deleted: z.string().describe("Path of the deleted note"),
});

export const deleteNote = defineTool({
  name: "globnotes_delete_note",
  title: "Delete a note",
  description:
    "Delete a note permanently. Pass the last_modified and hash you read as expected_last_modified and expected_hash (at least one is required) so a note edited since is not deleted.",
  write: true,
  inputSchema: z.strictObject({
    path: notePath,
    expected_last_modified: expectedLastModified,
    expected_hash: expectedHash,
  }),
  outputSchema: DeleteOutput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run(args, ctx) {
    const lease = writeLease(ctx);
    await ctx.vault.deleteNote(
      args.path,
      lease,
      requiredExpectation(args, "delete"),
    );
    return {
      structured: { deleted: args.path },
      summary: `Deleted note ${quote(args.path)}.`,
    };
  },
});
