// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The globnotes MCP tools (plans/v2-mcp/design.md §3). Each tool is a plain
 * definition: Zod 4 input and output schemas, annotations, and a `run`
 * function over an injected vault (server/mcp/vault.ts). `run` returns the
 * structured result and its concise text rendering; failures throw, and
 * server/mcp/server.ts turns them into tool errors the agent can act on.
 */

import * as z from "zod/v4";
import { isValidNotePath } from "../helpers.ts";
import {
  InvalidPathError,
  type Note,
  NoteExistsError,
  NoteNotFoundError,
} from "../notes/models.ts";
import type { NoteMutationLease } from "../plugins/lifecycle.ts";
import { notFound, READ_ONLY_MESSAGE, ToolError } from "./errors.ts";
import { highlightsToText } from "./snippets.ts";
import type { McpVault, SearchSort } from "./vault.ts";

/** Responses stay under this size by returning fewer search results
 * (mcp-builder); a single note is returned whole. */
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
  run(
    args: z.output<I>,
    ctx: ToolContext,
  ): Promise<{ structured: z.output<O>; text: string }>;
}

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
      "nothing is written and you are asked to re-read it. Omit to skip " +
      "the check.",
  );

const NoteOutput = z.object({
  path: z.string().describe("Note path (no .md extension)"),
  title: z.string().describe(
    "Display title: front-matter title, else first H1, else file name",
  ),
  content: z.string().describe("Full Markdown content"),
  last_modified: z.string().describe(
    "Last modification time, ISO 8601 (UTC)",
  ),
});

/** Validate an agent-supplied note path the way the REST API does
 * (trimmed, then isValidNotePath), as a tool error. */
function validPath(value: string, what = "path"): string {
  const trimmed = value.trim();
  try {
    return isValidNotePath(trimmed);
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

/** The stale-write guard (design §2 row 9): best effort, before the write. */
function assertUnchanged(
  ctx: ToolContext,
  path: string,
  expected: string | undefined,
): void {
  if (expected === undefined) return;
  const current = isoTime(readNote(ctx, path).lastModified);
  if (current !== new Date(expected).toISOString()) {
    throw new ToolError(
      `Note '${path}' changed since you read it (expected last_modified ` +
        `${expected}, now ${current}). Nothing was written. Call ` +
        "globnotes_get_note to re-read it, then retry with the new " +
        "last_modified.",
    );
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
  /** The largest n in [low, high] with fits(n), or null (bisection; fits
   * is monotone in n). */
  const largest = (low: number, high: number, fits: (n: number) => boolean) => {
    if (!fits(low)) return null;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    return low;
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
    "Matches found while filling this page (at most offset + count + 1). " +
      "Not a count of all matching notes",
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
    const folder = folderArg ? validPath(folderArg, "folder") : undefined;
    const sort: SearchSort = args.sort === "lastModified"
      ? "last_modified"
      : args.sort;
    // The index has no offset: fetch one more than the window to know
    // whether another page exists.
    const found = searchIndex(args.query, () =>
      ctx.vault.search(
        args.query,
        sort,
        args.order,
        args.offset + args.limit + 1,
        args.include_subfolders,
        folder,
      ));
    let hits: SearchHitOutput[] = found.slice(
      args.offset,
      args.offset + args.limit,
    ).map((r) => ({
      path: r.path,
      title: r.title,
      last_modified: isoTime(r.lastModified),
      ...(typeof r.score === "number" ? { score: r.score } : {}),
      snippet: highlightsToText(r.contentHighlights ?? r.pathHighlights),
      matched_tags: r.tagMatches ?? [],
    }));
    const render = (page: typeof hits) => {
      const end = args.offset + page.length;
      const hasMore = found.length > end;
      const structured = {
        total: found.length,
        count: page.length,
        offset: args.offset,
        has_more: hasMore,
        ...(hasMore ? { next_offset: end } : {}),
        results: page,
      };
      const lines = page.length === 0
        ? [
          `No notes match '${args.query}'${
            folder === undefined ? "" : ` in '${folder}'`
          }${
            args.offset > 0 ? ` at offset ${args.offset}` : ""
          }. Try fewer or different words, a prefix* or query="*".`,
        ]
        : [`Results ${args.offset + 1}–${end} for '${args.query}':`];
      for (const hit of page) {
        lines.push(
          `- ${hit.path} — "${hit.title}" (modified ${hit.last_modified})`,
        );
        if (hit.snippet) lines.push(`  ${hit.snippet}`);
        if (hit.matched_tags.length) {
          lines.push(
            `  tags: ${hit.matched_tags.join(", ")}${
              hit.omitted_tags ? ` (+${hit.omitted_tags} more not shown)` : ""
            }`,
          );
        }
        if (hit.truncated) {
          lines.push(
            `  shortened to fit the response limit: ${
              hit.truncated.join(", ")
            }; read the whole note with globnotes_get_note`,
          );
        }
      }
      if (hasMore) lines.push(`More results: call again with offset=${end}.`);
      return { structured, text: lines.join("\n") };
    };
    const size = (r: ReturnType<typeof render>) =>
      r.text.length + JSON.stringify(r.structured).length;
    let result = render(hits);
    while (hits.length > 1 && size(result) > CHARACTER_LIMIT) {
      hits = hits.slice(0, Math.ceil(hits.length / 2));
      result = render(hits);
    }
    // One hit can still exceed the budget: the index's snippet window counts
    // tokens, not characters (one long word makes a long snippet), and
    // titles and tags have no length limit. Shorten that hit's fields
    // (marked) rather than drop it.
    if (hits.length === 1 && size(result) > CHARACTER_LIMIT) {
      hits = [fitHit(hits[0], (h) => size(render([h])) - CHARACTER_LIMIT)];
      result = render(hits);
    }
    return Promise.resolve(result);
  },
});

// ---- globnotes_get_note ----

export const getNote = defineTool({
  name: "globnotes_get_note",
  title: "Read a note",
  description:
    "Read one note in full: its Markdown content, display title and last_modified (pass that to the write tools' expected_last_modified to avoid overwriting newer edits). Find paths with globnotes_search_notes or globnotes_list_folder.",
  write: false,
  inputSchema: z.strictObject({ path: notePath }),
  outputSchema: NoteOutput,
  annotations: READ,
  run(args, ctx) {
    const note = noteOutput(readNote(ctx, args.path));
    return Promise.resolve({
      structured: note,
      text:
        `# ${note.title}\npath: ${note.path}\nlast_modified: ${note.last_modified}\n\n${note.content}`,
    });
  },
});

// ---- globnotes_list_folder ----

const FolderOutput = z.object({
  path: z.string().describe("The folder listed ('' = the vault root)"),
  folders: z.array(z.object({ name: z.string(), path: z.string() })),
  notes: z.array(z.object({ path: z.string(), title: z.string() })),
});

export const listFolder = defineTool({
  name: "globnotes_list_folder",
  title: "List a folder",
  description:
    "List one folder of the vault: its subfolders and the notes directly inside it (not recursive). Omit path for the vault root, then pass a folder's path to go deeper. To find notes by content use globnotes_search_notes instead.",
  write: false,
  inputSchema: z.strictObject({
    path: pathText().default("").describe(
      "Folder path, e.g. 'Projects/2024'; '' or omitted = the vault root",
    ),
  }),
  outputSchema: FolderOutput,
  annotations: READ,
  run(args, ctx) {
    const path = args.path.trim().replace(/^\/+|\/+$/g, "");
    let level;
    try {
      level = ctx.vault.listFolder(path);
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
    const structured = { path, ...level };
    const lines = [
      `Folder '${
        path || "/"
      }': ${level.folders.length} folder(s), ${level.notes.length} note(s).`,
      ...level.folders.map((f) => `- ${f.path}/`),
      ...level.notes.map((n) => `- ${n.path} — "${n.title}"`),
    ];
    return Promise.resolve({ structured, text: lines.join("\n") });
  },
});

// ---- globnotes_list_tags ----

const TagsOutput = z.object({
  tags: z.array(z.string()).describe("Every tag used in the vault"),
});

export const listTags = defineTool({
  name: "globnotes_list_tags",
  title: "List tags",
  description:
    "List every tag used in the vault (lowercase, without '#'). Search a tag's notes with globnotes_search_notes and query='#tag'.",
  write: false,
  inputSchema: z.strictObject({}),
  outputSchema: TagsOutput,
  annotations: READ,
  run(_args, ctx) {
    const tags = ctx.vault.tags();
    return Promise.resolve({
      structured: { tags },
      text: tags.length
        ? `${tags.length} tag(s): ${tags.map((t) => `#${t}`).join(", ")}`
        : "The vault has no tags.",
    });
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
      text:
        `Created note '${note.path}' ("${note.title}", last_modified ${note.last_modified}).`,
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
    `Replace a note's content, rename/move it, or both. The new content replaces the whole note, so read it first with globnotes_get_note and pass its last_modified as expected_last_modified.

Like the web app, changing the first '# Heading' of a note without a front-matter title renames the note to match; the result's path is the final path.
Examples: fix a typo -> path + content + expected_last_modified; move to another folder -> path + new_path="Archive/Old plan".`,
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
    assertUnchanged(ctx, args.path, args.expected_last_modified);
    let note;
    try {
      note = await ctx.vault.updateNote(
        args.path,
        { newContent: args.content, newPath },
        args.file_refs,
        lease,
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
    const lines = [
      note.path === args.path
        ? `Updated note '${note.path}'`
        : `Updated note '${args.path}', now at '${note.path}'`,
    ];
    lines[0] +=
      ` ("${structured.title}", last_modified ${structured.last_modified}).`;
    for (const f of structured.moved_files) {
      lines.push(`Moved ${f.old_path} -> ${f.new_path}`);
    }
    return { structured, text: lines.join("\n") };
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
    "Delete a note permanently. Pass the last_modified you read as expected_last_modified so a note edited since is not deleted.",
  write: true,
  inputSchema: z.strictObject({
    path: notePath,
    expected_last_modified: expectedLastModified,
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
    assertUnchanged(ctx, args.path, args.expected_last_modified);
    await ctx.vault.deleteNote(args.path, lease);
    return {
      structured: { deleted: args.path },
      text: `Deleted note '${args.path}'.`,
    };
  },
});
