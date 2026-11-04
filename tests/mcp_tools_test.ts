// SPDX-License-Identifier: LGPL-3.0-only

/**
 * MCP tools as plain modules over a fake vault (plans/v2-mcp/design.md §5
 * row 1). The SDK client drives the real endpoint module in process
 * (handler.fetch), so schema validation, the read-only filter, the Origin
 * rule and both protocol eras are covered without a server.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HttpError } from "@pathfinder/pathfinder";
import {
  type Note,
  type NoteCreate,
  NoteExistsError,
  NoteNotFoundError,
  type NoteUpdate,
  type SearchResult,
} from "../server/notes/models.ts";
import { logger } from "../server/logger.ts";
import { OperationError } from "../server/plugins/errors.ts";
import type { NoteMutationLease } from "../server/plugins/lifecycle.ts";
import { MARK_CLOSE, MARK_OPEN } from "../server/search/fts5.ts";
import { createMcpEndpoint, foreignOrigin } from "../server/mcp/endpoint.ts";
import { READ_ONLY_MESSAGE } from "../server/mcp/errors.ts";
import { INSTRUCTIONS } from "../server/mcp/server.ts";
import { codePointLength, codePointSlice } from "../server/mcp/note_parts.ts";
import { highlightsToText } from "../server/mcp/snippets.ts";
import {
  CHARACTER_LIMIT,
  isoTime,
  MIN_FIELD_CHARS,
  TRUNCATED,
} from "../server/mcp/tools.ts";
import type { McpVault, SearchSort } from "../server/mcp/vault.ts";

const URL_BASE = "http://notes.test/_/mcp";
const LEASE: NoteMutationLease = Object.freeze({
  epoch: 1,
  assertCurrent: () => {},
});

interface SearchCall {
  term: string;
  sort?: SearchSort;
  order?: string;
  nested?: boolean;
  folder?: string | undefined;
  offset?: number;
  limit?: number;
}

/** An in-memory vault recording every call the tools make. */
function fakeVault(seed: Record<string, string> = {}) {
  const notes = new Map<string, Note>();
  let clock = 1_700_000_000;
  const put = (path: string, content: string) => {
    const note: Note = {
      path,
      content,
      title: content.match(/^# (.+)$/m)?.[1] ?? path.split("/").pop()!,
      lastModified: (clock += 10) + 0.25,
      movedFiles: [],
    };
    notes.set(path, note);
    return note;
  };
  for (const [path, content] of Object.entries(seed)) put(path, content);
  const calls = {
    search: [] as SearchCall[],
    folder: [] as { path: string; offset: number; limit: number }[],
    tags: [] as { offset: number; limit: number }[],
    writes: [] as { op: string; lease: NoteMutationLease; args: unknown[] }[],
  };
  let searchResults: SearchResult[] = [];
  let writeError: Error | null = null;
  let readError: Error | null = null;
  let tags = ["garden", "recipe"];
  const get = (path: string) => {
    if (readError) throw readError;
    const note = notes.get(path);
    if (!note) throw new NoteNotFoundError("missing");
    return { ...note };
  };
  const vault: McpVault = {
    getNote: get,
    listFolder: (path, offset, limit) => {
      calls.folder.push({ path, offset, limit });
      if (readError) throw readError;
      if (path === "missing") throw new NoteNotFoundError("missing");
      const folders = [{ name: "Sub", path: path ? `${path}/Sub` : "Sub" }];
      const all = [...notes.values()].map((n) => ({
        path: n.path,
        title: n.title,
      }));
      const end = offset + limit;
      return {
        total: folders.length + all.length,
        folderCount: folders.length,
        noteCount: all.length,
        folders: folders.slice(offset, end),
        notes: all.slice(
          Math.max(0, offset - folders.length),
          Math.max(0, end - folders.length),
        ),
      };
    },
    search: (term, query) => {
      calls.search.push({ term, ...query });
      if (readError) throw readError;
      const offset = query.offset ?? 0;
      return {
        total: searchResults.length,
        results: searchResults.slice(offset, offset + (query.limit ?? 0)),
      };
    },
    tags: (offset, limit) => {
      calls.tags.push({ offset, limit });
      return { total: tags.length, tags: tags.slice(offset, offset + limit) };
    },
    createNote: (data: NoteCreate, lease) => {
      calls.writes.push({ op: "create", lease, args: [data] });
      if (writeError) return Promise.reject(writeError);
      if (notes.has(data.path)) {
        return Promise.reject(new NoteExistsError("exists"));
      }
      return Promise.resolve(put(data.path, data.content ?? ""));
    },
    updateNote: (path, data: NoteUpdate, fileRefs, lease) => {
      calls.writes.push({ op: "update", lease, args: [path, data, fileRefs] });
      if (writeError) return Promise.reject(writeError);
      const before = get(path);
      const target = data.newPath ?? path;
      notes.delete(path);
      const note = put(target, data.newContent ?? before.content ?? "");
      if (target !== path) {
        note.movedFiles = [{
          oldPath: `${path}.png`,
          newPath: `${target}.png`,
        }];
      }
      return Promise.resolve(note);
    },
    deleteNote: (path, lease) => {
      calls.writes.push({ op: "delete", lease, args: [path] });
      if (writeError) return Promise.reject(writeError);
      get(path);
      notes.delete(path);
      return Promise.resolve();
    },
  };
  return {
    vault,
    notes,
    calls,
    setSearchResults: (results: SearchResult[]) => searchResults = results,
    failWrites: (error: Error | null) => writeError = error,
    failReads: (error: Error | null) => readError = error,
    setTags: (next: string[]) => tags = next,
  };
}

type Fake = ReturnType<typeof fakeVault>;

async function connect(
  fake: Fake,
  options: {
    writable?: boolean;
    modern?: boolean;
    headers?: Record<string, string>;
  } = {},
) {
  const endpoint = createMcpEndpoint({
    vault: fake.vault,
    writable: () => options.writable ?? true,
    authenticateRead: () => Promise.resolve(null),
    lease: () => Promise.resolve(LEASE),
    version: () => "test",
  });
  const transport = new StreamableHTTPClientTransport(new URL(URL_BASE), {
    fetch: (url, init) => {
      const request = new Request(url, init);
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        request.headers.set(key, value);
      }
      return request.method === "POST"
        ? endpoint.post(request)
        : Promise.resolve(endpoint.notAllowed(request));
    },
  });
  const client = new Client(
    { name: "mcp-tools-test", version: "1.0.0" },
    options.modern ? { versionNegotiation: { mode: "auto" } } : {},
  );
  await client.connect(transport);
  return {
    client,
    endpoint,
    /** A tool call; every successful result is checked for the text
     * fallback (resultText) on the way. */
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      if (!result.isError) assertTextFallback(result);
      return result;
    },
    close: async () => {
      await client.close();
      await endpoint.close();
    },
  };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[])
    .map((block) => block.text).join("\n");
}

/** A successful result's one text block: its summary line. */
function summaryOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return textOf(result).split("\n")[0];
}

/** The MCP text fallback: one text block holding a one-line summary, then
 * the whole structured result as JSON, equal to structuredContent. */
function assertTextFallback(
  result: Awaited<ReturnType<Client["callTool"]>>,
): void {
  const blocks = result.content as { type: string; text: string }[];
  assertEquals(blocks.map((block) => block.type), ["text"]);
  const text = blocks[0].text;
  const lines = text.split("\n");
  assertEquals(lines.length, 2, `summary line + JSON line: ${text}`);
  assert(lines[0].length > 0, "a summary line");
  assertEquals(JSON.parse(lines[1]), result.structuredContent);
}

const ALL_TOOLS = [
  "globnotes_create_note",
  "globnotes_delete_note",
  "globnotes_get_note",
  "globnotes_list_folder",
  "globnotes_list_tags",
  "globnotes_search_notes",
  "globnotes_update_note",
];
const READ_TOOLS = [
  "globnotes_get_note",
  "globnotes_list_folder",
  "globnotes_list_tags",
  "globnotes_search_notes",
];

const hit1 = (extra: Partial<SearchResult>) => hit(1, extra);

function hit(i: number, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    path: `Notes/n${i}`,
    title: `Note ${i}`,
    lastModified: 1_700_000_000 + i,
    score: 10 - i,
    pathHighlights: null,
    contentHighlights: `before ${MARK_OPEN}match${MARK_CLOSE} after ${i}`,
    tagMatches: null,
    ...extra,
  };
}

Deno.test("mcp tools: highlightsToText marks matches as plain text", () => {
  assertEquals(highlightsToText(null), "");
  assertEquals(highlightsToText(""), "");
  assertEquals(highlightsToText("plain"), "plain");
  assertEquals(
    highlightsToText(
      `a ${MARK_OPEN}b${MARK_CLOSE} c ${MARK_OPEN}d${MARK_CLOSE}`,
    ),
    "a «b» c «d»",
  );
  // A literal </b> in the note outside a mark is the note's own text.
  assertEquals(
    highlightsToText(`x </b> ${MARK_OPEN}y${MARK_CLOSE} <i>z</i>`),
    "x </b> «y» <i>z</i>",
  );
  // Line breaks of the note collapse, also inside a match.
  assertEquals(
    highlightsToText(`a\n\n ${MARK_OPEN}b\nc${MARK_CLOSE}  d `),
    "a «b c» d",
  );
  // An unclosed mark (a truncated snippet) loses only its marker.
  assertEquals(highlightsToText(`p ${MARK_OPEN}q…`), "p q…");
});

Deno.test("mcp tools: Origin rule", () => {
  const req = (origin?: string, host = "notes.home:8080") =>
    new Request("http://notes.home:8080/_/mcp", {
      method: "POST",
      headers: { host, ...(origin === undefined ? {} : { origin }) },
    });
  assertEquals(foreignOrigin(req()), false);
  assertEquals(foreignOrigin(req("http://notes.home:8080")), false);
  assertEquals(foreignOrigin(req("http://NOTES.home:8080")), false);
  assertEquals(foreignOrigin(req("http://evil.example")), true);
  assertEquals(foreignOrigin(req("http://notes.home:9090")), true);
  assertEquals(foreignOrigin(req("null")), true);
});

Deno.test("mcp tools: tools/list and annotations, writable and read-only", async (t) => {
  for (const modern of [false, true]) {
    await t.step(modern ? "modern era" : "2025 era", async () => {
      const writable = await connect(fakeVault(), { modern });
      try {
        const { tools } = await writable.client.listTools();
        assertEquals(tools.map((tool) => tool.name).sort(), ALL_TOOLS);
        for (const tool of tools) {
          assert(tool.title && tool.description, tool.name);
          assert(tool.outputSchema, `${tool.name} has an output schema`);
          const a = tool.annotations!;
          const write = !READ_TOOLS.includes(tool.name);
          assertEquals(a.readOnlyHint, !write, tool.name);
          assertEquals(a.openWorldHint, false, tool.name);
          assertEquals(a.idempotentHint, !write, tool.name);
          assertEquals(
            a.destructiveHint,
            tool.name === "globnotes_update_note" ||
              tool.name === "globnotes_delete_note",
            tool.name,
          );
        }
        const query = tools.find((tool) =>
          tool.name === "globnotes_search_notes"
        )!.inputSchema.properties!.query as { description: string };
        assert(query.description.includes("globnotes syntax"));
      } finally {
        await writable.close();
      }
      const readOnly = await connect(fakeVault(), { writable: false, modern });
      try {
        const { tools } = await readOnly.client.listTools();
        assertEquals(tools.map((tool) => tool.name).sort(), READ_TOOLS);
      } finally {
        await readOnly.close();
      }
    });
  }
});

Deno.test("mcp tools: server instructions at initialize, both eras", async (t) => {
  for (const modern of [false, true]) {
    await t.step(modern ? "modern era" : "2025 era", async () => {
      for (const writable of [true, false]) {
        const mcp = await connect(fakeVault(), { modern, writable });
        try {
          const instructions = mcp.client.getInstructions();
          assertEquals(instructions, INSTRUCTIONS);
        } finally {
          await mcp.close();
        }
      }
    });
  }
  assert(INSTRUCTIONS.length < 1_000, `${INSTRUCTIONS.length} characters`);
  for (
    const part of [
      "globnotes_search_notes",
      "globnotes_list_folder",
      "globnotes_get_note",
      "globnotes_update_note",
      "expected_last_modified",
      "offset=next_offset",
      "Heading",
      "read-only",
    ]
  ) assert(INSTRUCTIONS.includes(part), part);
});

Deno.test("mcp tools: read-only instance answers write tools with a tool error", async (t) => {
  for (const modern of [false, true]) {
    await t.step(modern ? "modern era" : "2025 era", async () => {
      const fake = fakeVault({ a: "# A\n" });
      const mcp = await connect(fake, { writable: false, modern });
      try {
        for (
          const [name, args] of [
            ["globnotes_create_note", { path: "b", content: "x" }],
            ["globnotes_update_note", { path: "a", content: "x" }],
            ["globnotes_delete_note", { path: "a" }],
          ] as const
        ) {
          const result = await mcp.call(name, args);
          assertEquals(result.isError, true, name);
          assertEquals(textOf(result), READ_ONLY_MESSAGE, name);
        }
        assertEquals(fake.calls.writes, []);
        const read = await mcp.call("globnotes_get_note", { path: "a" });
        assertEquals(read.isError, undefined);
      } finally {
        await mcp.close();
      }
    });
  }
});

Deno.test("mcp tools: schema validation rejects bad arguments before the vault", async () => {
  const fake = fakeVault();
  const mcp = await connect(fake);
  try {
    for (
      const args of [
        { query: "x", limit: 0 },
        { query: "x", limit: 101 },
        { query: "x", offset: -1 },
        { query: "" },
        { query: "x", sort: "title" },
        { query: "x", unknown: true },
      ]
    ) {
      const result = await mcp.call("globnotes_search_notes", args);
      assertEquals(result.isError, true, JSON.stringify(args));
      assert(textOf(result).includes("Input validation error"));
    }
    const noPath = await mcp.call("globnotes_get_note", {});
    assertEquals(noPath.isError, true);
    const badStamp = await mcp.call("globnotes_delete_note", {
      path: "a",
      expected_last_modified: "yesterday",
    });
    assertEquals(badStamp.isError, true);
    assertEquals(fake.calls.search, []);
    assertEquals(fake.calls.writes, []);
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: search results, sort mapping and snippets", async () => {
  const fake = fakeVault();
  fake.setSearchResults([
    hit(1, { tagMatches: ["garden"] }),
    hit(2, {
      score: null,
      contentHighlights: null,
      pathHighlights: `Notes/${MARK_OPEN}n2${MARK_CLOSE}`,
    }),
    hit(3, { contentHighlights: null }),
  ]);
  const mcp = await connect(fake);
  try {
    const result = await mcp.call("globnotes_search_notes", {
      query: "#garden match",
      folder: "/Notes/",
      include_subfolders: false,
      sort: "lastModified",
      order: "asc",
    });
    assertEquals(result.isError, undefined, textOf(result));
    assertEquals(fake.calls.search, [{
      term: "#garden match",
      sort: "last_modified",
      order: "asc",
      nested: false,
      folder: "Notes",
      offset: 0,
      limit: 20,
    }]);
    assertEquals(result.structuredContent, {
      total: 3,
      count: 3,
      offset: 0,
      has_more: false,
      results: [
        {
          path: "Notes/n1",
          title: "Note 1",
          last_modified: isoTime(1_700_000_001),
          score: 9,
          snippet: "before «match» after 1",
          matched_tags: ["garden"],
        },
        {
          path: "Notes/n2",
          title: "Note 2",
          last_modified: isoTime(1_700_000_002),
          snippet: "Notes/«n2»",
          matched_tags: [],
        },
        {
          path: "Notes/n3",
          title: "Note 3",
          last_modified: isoTime(1_700_000_003),
          score: 7,
          snippet: "",
          matched_tags: [],
        },
      ],
    });
    assertEquals(isoTime(1_700_000_001), "2023-11-14T22:13:21.000Z");
    // One summary line; every field is in the JSON line (checked by call).
    assertEquals(
      summaryOf(result),
      'Results 1-3 of 3 for "#garden match" in folder "Notes".',
    );
    const text = textOf(result);
    assert(text.includes('"snippet":"before «match» after 1"'), text);
    assert(text.includes('"score":9'), text);
    assert(!text.includes("<b"), text);
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: the text block is one summary line plus the whole result as JSON", async () => {
  const fake = fakeVault({
    'Odd "quoted"\nname': '# Line one\n\n"two"\n\tthree \u2028',
  });
  fake.setSearchResults(Array.from({ length: 100 }, (_, i) => hit(i)));
  const mcp = await connect(fake);
  try {
    // User text with line breaks stays inside the one summary line (call
    // asserts the shape of every successful result).
    const search = await mcp.call("globnotes_search_notes", {
      query: "a\nb\r\nc",
      limit: 100,
    });
    assert(summaryOf(search).includes('"a\\nb\\r\\nc"'), summaryOf(search));
    const note = await mcp.call("globnotes_get_note", {
      path: 'Odd "quoted"\nname',
    });
    assertEquals(
      (note.structuredContent as { content: string }).content,
      '# Line one\n\n"two"\n\tthree \u2028',
    );
    // The budget counts what is sent: the text (JSON included) and the
    // structured content.
    const page = search.structuredContent as { count: number };
    const sent = textOf(search).length +
      JSON.stringify(search.structuredContent).length;
    assert(sent <= CHARACTER_LIMIT, `sent ${sent}`);
    assert(page.count < 100, "fewer results to fit both copies");
    assert(
      sent > CHARACTER_LIMIT / 2,
      `the page is not cut far below the budget: ${sent}`,
    );
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: search pagination edges", async () => {
  const fake = fakeVault();
  fake.setSearchResults([1, 2, 3, 4, 5].map((i) => hit(i)));
  const mcp = await connect(fake);
  const page = async (offset: number, limit: number) => {
    const result = await mcp.call("globnotes_search_notes", {
      query: "match",
      offset,
      limit,
    });
    assertEquals(result.isError, undefined, textOf(result));
    const structured = result.structuredContent as {
      total: number;
      count: number;
      has_more: boolean;
      next_offset?: number;
      results: { path: string }[];
    };
    return {
      ...structured,
      paths: structured.results.map((r) => r.path),
      text: textOf(result),
    };
  };
  try {
    const first = await page(0, 2);
    assertEquals(
      [first.total, first.count, first.has_more, first.next_offset],
      [5, 2, true, 2],
    );
    assertEquals(first.paths, ["Notes/n1", "Notes/n2"]);
    assertEquals(
      first.text.split("\n")[0],
      'Results 1-2 of 5 for "match". More results: call again with offset=2.',
    );
    // The page is cut by the index: the tool asks for the window only.
    assertEquals(
      [fake.calls.search.at(-1)!.offset, fake.calls.search.at(-1)!.limit],
      [0, 2],
    );

    const middle = await page(2, 2);
    assertEquals(
      [middle.total, middle.count, middle.has_more, middle.next_offset],
      [5, 2, true, 4],
    );
    assertEquals(middle.paths, ["Notes/n3", "Notes/n4"]);

    const last = await page(4, 2);
    assertEquals([last.count, last.has_more], [1, false]);
    assertEquals("next_offset" in last, false);
    assertEquals(last.paths, ["Notes/n5"]);

    const exact = await page(3, 2);
    assertEquals([exact.count, exact.has_more], [2, false]);

    const beyond = await page(9, 2);
    assertEquals([beyond.count, beyond.has_more], [0, false]);
    assert(
      beyond.text.startsWith('No results for "match" at offset 9 (5 in all).'),
      beyond.text,
    );
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: search stays under the character limit with fewer results", async () => {
  const fake = fakeVault();
  const long = "w".repeat(3_000);
  fake.setSearchResults(
    Array.from({ length: 30 }, (_, i) => hit(i, { contentHighlights: long })),
  );
  const mcp = await connect(fake);
  try {
    const result = await mcp.call("globnotes_search_notes", {
      query: "w",
      limit: 30,
    });
    const page = result.structuredContent as {
      count: number;
      has_more: boolean;
      next_offset: number;
    };
    assert(page.count < 30 && page.count >= 1, `count ${page.count}`);
    assertEquals(page.has_more, true);
    assertEquals(page.next_offset, page.count);
    assert(
      textOf(result).length + JSON.stringify(page).length <= 25_000,
      "under the limit",
    );
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: one hit over the character limit keeps the hit with a shortened snippet", async (t) => {
  // FTS5's snippet window counts tokens, not characters: one long token
  // (here 40,000 characters) makes a snippet over the whole budget.
  const token = "x".repeat(40_000);
  const long = (i: number) =>
    hit(i, { contentHighlights: `a ${MARK_OPEN}${token}${MARK_CLOSE} b` });
  for (
    const [label, results, limit, more] of [
      ["the only hit", [long(1)], 20, false],
      ["after halving", [long(1), long(2), long(3)], 3, true],
    ] as const
  ) {
    await t.step(label, async () => {
      const fake = fakeVault();
      fake.setSearchResults([...results]);
      const mcp = await connect(fake);
      try {
        const result = await mcp.call("globnotes_search_notes", {
          query: "x*",
          limit,
        });
        assertEquals(result.isError, undefined, textOf(result));
        const page = result.structuredContent as {
          count: number;
          has_more: boolean;
          next_offset?: number;
          results: { path: string; snippet: string }[];
        };
        assertEquals(page.count, 1);
        assertEquals(page.results[0].path, "Notes/n1");
        assertEquals(page.has_more, more);
        assertEquals(page.next_offset, more ? 1 : undefined);
        const snippet = page.results[0].snippet;
        assert(snippet.startsWith("a «xxx"), snippet.slice(0, 20));
        assert(snippet.endsWith(TRUNCATED), snippet.slice(-40));
        assertEquals(
          (page.results[0] as { truncated?: string[] }).truncated,
          ["snippet"],
        );
        const size = textOf(result).length + JSON.stringify(page).length;
        assert(size <= CHARACTER_LIMIT, `size ${size}`);
        // Shortened only as far as needed, not emptied.
        assert(size > CHARACTER_LIMIT - 1_000, `size ${size}`);
        assert(textOf(result).includes(snippet));
      } finally {
        await mcp.close();
      }
    });
  }
});

interface FittedHit {
  path: string;
  title: string;
  snippet: string;
  matched_tags: string[];
  truncated?: string[];
  omitted_tags?: number;
}

/** One search call over a single fake hit; the page and its size. */
async function searchOne(result: SearchResult) {
  const fake = fakeVault();
  fake.setSearchResults([result]);
  const mcp = await connect(fake);
  try {
    const found = await mcp.call("globnotes_search_notes", { query: "x*" });
    assertEquals(found.isError, undefined, textOf(found));
    const page = found.structuredContent as {
      count: number;
      results: FittedHit[];
    };
    assertEquals(page.count, 1);
    return {
      hit: page.results[0],
      text: textOf(found),
      size: textOf(found).length + JSON.stringify(page).length,
    };
  } finally {
    await mcp.close();
  }
}

Deno.test("mcp tools: a single over-long result is shortened to one common cap, path intact", async (t) => {
  const huge = (c: string) => c.repeat(40_000);
  const within = (size: number) => {
    assert(size <= CHARACTER_LIMIT, `size ${size}`);
    // Shortened only as far as needed, not emptied.
    assert(size > CHARACTER_LIMIT - 1_000, `size ${size}`);
  };

  const length = (text: string) => [...text].length;

  await t.step("a long tag is cut, the short fields stay whole", async () => {
    const { hit, text, size } = await searchOne(
      hit1({ tagMatches: [huge("t"), "short"] }),
    );
    assertEquals(hit.path, "Notes/n1");
    assertEquals(hit.title, "Note 1");
    assertEquals(hit.snippet, "before «match» after 1");
    assertEquals(hit.truncated, ["matched_tags"]);
    assertEquals(hit.omitted_tags, undefined);
    assertEquals(hit.matched_tags.length, 2);
    assert(hit.matched_tags[0].startsWith("ttt"));
    assert(hit.matched_tags[0].endsWith(TRUNCATED));
    assertEquals(hit.matched_tags[1], "short");
    assert(text.includes("shortened to fit the response limit"), text);
    within(size);
  });

  await t.step(
    "many tags: trailing ones are left out and counted",
    async () => {
      const tags = Array.from({ length: 3_000 }, (_, i) => `tag-${i}-xxxxxx`);
      const { hit, text, size } = await searchOne(hit1({ tagMatches: tags }));
      assertEquals(hit.truncated, ["matched_tags"]);
      assert(hit.omitted_tags! > 0);
      assertEquals(hit.matched_tags.length + hit.omitted_tags!, tags.length);
      // Short tags are kept whole; only trailing ones are left out.
      assertEquals(hit.matched_tags, tags.slice(0, hit.matched_tags.length));
      assertEquals(hit.snippet, "before «match» after 1");
      assert(text.includes(`"omitted_tags":${hit.omitted_tags}`), text);
      within(size);
    },
  );

  await t.step("a long title is shortened", async () => {
    const { hit, text, size } = await searchOne(hit1({ title: huge("T") }));
    assertEquals(hit.path, "Notes/n1");
    assertEquals(hit.truncated, ["title"]);
    assert(hit.title.startsWith("TTT") && hit.title.endsWith(TRUNCATED));
    assertEquals(hit.snippet, "before «match» after 1");
    assert(text.includes('"truncated":["title"]'), text);
    within(size);
  });

  await t.step(
    "long title, tag and snippet together share one cap",
    async () => {
      const { hit, size } = await searchOne(hit1({
        title: huge("T"),
        tagMatches: [huge("t"), "short"],
        contentHighlights: `${MARK_OPEN}${huge("x")}${MARK_CLOSE}`,
      }));
      assertEquals(hit.path, "Notes/n1");
      assertEquals(hit.truncated, ["snippet", "matched_tags", "title"]);
      for (const text of [hit.snippet, hit.title, hit.matched_tags[0]]) {
        assert(text.endsWith(TRUNCATED));
      }
      // One common maximum length for every shortened text.
      assertEquals(length(hit.title), length(hit.matched_tags[0]));
      assertEquals(length(hit.title), length(hit.snippet));
      assert(length(hit.title) >= MIN_FIELD_CHARS);
      assertEquals(hit.matched_tags[1], "short");
      within(size);
    },
  );

  await t.step("a long path is never shortened", async () => {
    // A deep but valid path (each segment under 255 bytes, ~4,000 chars).
    const path = Array.from({ length: 16 }, (_, i) => `${i}`.padEnd(250, "p"))
      .join("/");
    const { hit, size } = await searchOne(
      hit1({ path, title: huge("T"), tagMatches: [huge("t")] }),
    );
    assertEquals(hit.path, path);
    assertEquals(hit.truncated, ["matched_tags", "title"]);
    within(size);
  });
});

Deno.test("mcp tools: reads and their actionable errors", async () => {
  const fake = fakeVault({ "Garden/Beds": "# Beds\n\nBed 1: tomatoes" });
  const mcp = await connect(fake);
  try {
    const note = await mcp.call("globnotes_get_note", { path: "Garden/Beds" });
    assertEquals(note.structuredContent, {
      path: "Garden/Beds",
      title: "Beds",
      content: "# Beds\n\nBed 1: tomatoes",
      last_modified: isoTime(fake.notes.get("Garden/Beds")!.lastModified),
      offset: 0,
      total_length: 23,
      has_more: false,
    });
    assert(
      textOf(note).includes('"content":"# Beds\\n\\nBed 1: tomatoes"'),
      textOf(note),
    );
    assert(!summaryOf(note).includes("PARTIAL"), summaryOf(note));

    const missing = await mcp.call("globnotes_get_note", { path: "Nope" });
    assertEquals(missing.isError, true);
    assertEquals(
      textOf(missing),
      "Note 'Nope' not found. Use globnotes_search_notes or " +
        "globnotes_list_folder to find the right path (paths have no .md " +
        "extension).",
    );

    const root = await mcp.call("globnotes_list_folder", {});
    assertEquals(root.structuredContent, {
      path: "",
      total: 2,
      count: 2,
      offset: 0,
      has_more: false,
      folders: [{ name: "Sub", path: "Sub" }],
      notes: [{ path: "Garden/Beds", title: "Beds" }],
    });
    const nested = await mcp.call("globnotes_list_folder", { path: "Garden/" });
    assertEquals((nested.structuredContent as { path: string }).path, "Garden");
    const gone = await mcp.call("globnotes_list_folder", { path: "missing" });
    assertEquals(gone.isError, true);
    assert(textOf(gone).startsWith("Folder 'missing' not found."));

    const badFolder = await mcp.call("globnotes_search_notes", {
      query: "x",
      folder: "a/../b",
    });
    assertEquals(badFolder.isError, true);
    assert(textOf(badFolder).startsWith("Invalid folder 'a/../b'"));

    const tags = await mcp.call("globnotes_list_tags");
    assertEquals(tags.structuredContent, {
      total: 2,
      count: 2,
      offset: 0,
      has_more: false,
      tags: ["garden", "recipe"],
    });
    assertEquals(
      textOf(tags),
      "Tags 1-2 of 2.\n" + JSON.stringify(tags.structuredContent),
    );
  } finally {
    await mcp.close();
  }
});

interface NotePart {
  title: string;
  content: string;
  offset: number;
  total_length: number;
  has_more: boolean;
  next_offset?: number;
  truncated?: string[];
}

/** A lone surrogate: a part that split a pair would hold one. */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

Deno.test("mcp tools: note parts count code points", () => {
  const text = "x\u{1F600}y\ud800z"; // a pair, and a lone high surrogate
  assertEquals(codePointLength(text), 5);
  assertEquals(codePointLength(""), 0);
  assertEquals(codePointSlice(text, 1, 1), "\u{1F600}");
  assertEquals(codePointSlice(text, 1, 2), "\u{1F600}y");
  assertEquals(codePointSlice(text, 3, Infinity), "\ud800z");
  assertEquals(codePointSlice(text, 9, 2), "");
  assertEquals(codePointSlice(text, 0, 0), "");
});

Deno.test("mcp tools: get_note reads large notes in parts", async (t) => {
  // Multi-byte text: astral emoji (surrogate pairs), a combining accent,
  // CJK; every character a code point.
  const unit = "a\u00e9\u0301\u4e2d\u{1F600}\u{1F3FD}z";
  const small = `# Small\n\n${unit.repeat(3)}`;
  const huge = `# Huge\n\n${unit.repeat(30_000)}`; // 210,008 code points
  const fake = fakeVault({ Small: small, Huge: huge });
  const mcp = await connect(fake);
  const read = async (args: Record<string, unknown>) => {
    const result = await mcp.call("globnotes_get_note", args);
    assertEquals(result.isError, undefined, textOf(result));
    const sent = textOf(result).length +
      JSON.stringify(result.structuredContent).length;
    assert(sent <= CHARACTER_LIMIT, `sent ${sent}`);
    return {
      part: result.structuredContent as unknown as NotePart,
      summary: summaryOf(result),
    };
  };
  const length = (text: string) => [...text].length;
  try {
    await t.step("a note that fits comes whole", async () => {
      const { part, summary } = await read({ path: "Small" });
      assertEquals(part.content, small);
      assertEquals(
        [part.offset, part.total_length, part.has_more],
        [0, length(small), false],
      );
      assertEquals("next_offset" in part, false);
      assert(!summary.includes("PARTIAL"), summary);
    });
    await t.step("ranges count code points, never split a pair", async () => {
      // "# Small\n\n" is 9 characters; then a, e, U+0301, U+4E2D, U+1F600...
      const { part } = await read({ path: "Small", offset: 12, length: 2 });
      assertEquals(part.content, "\u4e2d\u{1F600}");
      assertEquals([part.offset, part.has_more, part.next_offset], [
        12,
        true,
        14,
      ]);
      for (let offset = 0; offset < length(small); offset += 3) {
        const { part } = await read({ path: "Small", offset, length: 3 });
        assert(!LONE_SURROGATE.test(part.content), `at ${offset}`);
      }
    });
    await t.step("boundaries: the end and past it", async () => {
      const total = length(small);
      const last = await read({ path: "Small", offset: total - 1 });
      assertEquals([last.part.content, last.part.has_more], ["z", false]);
      for (const offset of [total, total + 1_000]) {
        const { part, summary } = await read({ path: "Small", offset });
        assertEquals(
          [part.content, part.offset, part.has_more],
          ["", total, false],
        );
        assert(summary.includes("PARTIAL"), summary);
      }
    });
    await t.step(
      "a huge note: the first part, marked, then the rest",
      async () => {
        const first = await read({ path: "Huge" });
        assertEquals(first.part.has_more, true);
        assertEquals(first.part.offset, 0);
        assertEquals(first.part.total_length, length(huge));
        assertEquals(first.part.next_offset, length(first.part.content));
        assert(first.summary.includes("PARTIAL: characters 0-"), first.summary);
        assert(first.summary.includes("read the whole note before replacing"));
        // As much as fits: content is sent twice (text and structured), and
        // the budget counts UTF-16 units (9 per 7 characters here).
        const units = first.part.content.length;
        assert(2 * units > CHARACTER_LIMIT - 1_000, `${units} units`);
        const parts = [first.part.content];
        let next = first.part.next_offset;
        while (next !== undefined) {
          const { part } = await read({ path: "Huge", offset: next });
          assertEquals(part.offset, next);
          assert(!LONE_SURROGATE.test(part.content));
          parts.push(part.content);
          next = part.next_offset;
        }
        assertEquals(parts.join(""), huge);
      },
    );
    await t.step("a length over the budget returns what fits", async () => {
      const { part } = await read({ path: "Huge", length: 100_000 });
      assertEquals(part.has_more, true);
      assert(length(part.content) < 100_000);
    });
    await t.step("a title over half the budget is shortened", async () => {
      fake.notes.get("Huge")!.title = "T".repeat(40_000);
      const { part, summary } = await read({ path: "Huge" });
      assertEquals(part.truncated, ["title"]);
      assert(part.title.endsWith(TRUNCATED));
      // About half the budget stays for content.
      assert(2 * part.content.length > CHARACTER_LIMIT / 2 - 1_000);
      assert(summary.includes("title was shortened"), summary);
    });
    await t.step("offset and length are validated", async () => {
      for (const args of [{ offset: -1 }, { length: 0 }, { offset: 1.5 }]) {
        const result = await mcp.call("globnotes_get_note", {
          path: "Small",
          ...args,
        });
        assertEquals(result.isError, true, JSON.stringify(args));
      }
    });
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: writes carry the lease and map domain errors", async () => {
  const fake = fakeVault({ a: "# A\n" });
  const mcp = await connect(fake);
  try {
    const created = await mcp.call("globnotes_create_note", {
      path: "  Folder/New  ",
      content: "# New\n",
    });
    assertEquals(created.isError, undefined, textOf(created));
    assertEquals(
      (created.structuredContent as { path: string }).path,
      "Folder/New",
    );
    assertEquals(fake.calls.writes[0].op, "create");
    assertEquals(fake.calls.writes[0].lease, LEASE);
    assertEquals(fake.calls.writes[0].args, [{
      path: "Folder/New",
      content: "# New\n",
    }]);

    const exists = await mcp.call("globnotes_create_note", {
      path: "a",
      content: "x",
    });
    assertEquals(exists.isError, true);
    assert(textOf(exists).startsWith("A note already exists at 'a'."));

    const invalid = await mcp.call("globnotes_create_note", {
      path: "_/x",
      content: "x",
    });
    assertEquals(invalid.isError, true);
    assert(textOf(invalid).startsWith("Invalid path '_/x'"));

    const nothing = await mcp.call("globnotes_update_note", { path: "a" });
    assertEquals(nothing.isError, true);
    assertEquals(
      textOf(nothing),
      "Nothing to change: pass content, new_path or both.",
    );

    fake.failWrites(
      new OperationError(409, "plugin_cancelled", "no blocked content", {
        pluginId: "guard",
        action: "save",
      }),
    );
    const cancelled = await mcp.call("globnotes_update_note", {
      path: "a",
      content: "#BLOCK#",
    });
    assertEquals(cancelled.isError, true);
    assertEquals(
      textOf(cancelled),
      "The plugin 'guard' cancelled this save: no blocked content " +
        "Nothing was written.",
    );
    fake.failWrites(new HttpError(401, "Invalid authentication credentials"));
    const expired = await mcp.call("globnotes_delete_note", { path: "a" });
    assert(textOf(expired).startsWith("The globnotes token expired"));
    fake.failWrites(null);
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: update, rename and the stale-write guard", async () => {
  const fake = fakeVault({ "Plans/Old": "# Old\n" });
  const mcp = await connect(fake);
  try {
    const read = await mcp.call("globnotes_get_note", { path: "Plans/Old" });
    const stamp = (read.structuredContent as { last_modified: string })
      .last_modified;

    const stale = await mcp.call("globnotes_update_note", {
      path: "Plans/Old",
      content: "# Old\nmine",
      expected_last_modified: "2020-01-01T00:00:00.000Z",
    });
    assertEquals(stale.isError, true);
    assert(
      textOf(stale).startsWith(
        "Note 'Plans/Old' changed since you read it (expected last_modified " +
          `2020-01-01T00:00:00.000Z, now ${stamp}). Nothing was written.`,
      ),
      textOf(stale),
    );
    assertEquals(fake.calls.writes, []);

    // The same instant in another ISO form is not a conflict.
    const offsetForm = stamp.replace("Z", "+00:00");
    const saved = await mcp.call("globnotes_update_note", {
      path: "Plans/Old",
      content: "# Old\nmine",
      expected_last_modified: offsetForm,
    });
    assertEquals(saved.isError, undefined, textOf(saved));
    assertEquals(fake.notes.get("Plans/Old")!.content, "# Old\nmine");
    assertEquals(fake.calls.writes[0].args, [
      "Plans/Old",
      { newContent: "# Old\nmine", newPath: undefined },
      "none",
    ]);

    const moved = await mcp.call("globnotes_update_note", {
      path: "Plans/Old",
      new_path: " Archive/Old ",
      file_refs: "move",
    });
    assertEquals(moved.isError, undefined, textOf(moved));
    const result = moved.structuredContent as {
      path: string;
      moved_files: unknown[];
    };
    assertEquals(result.path, "Archive/Old");
    assertEquals(result.moved_files, [{
      old_path: "Plans/Old.png",
      new_path: "Archive/Old.png",
    }]);
    assert(
      summaryOf(moved).startsWith(
        'Updated note "Plans/Old", now at "Archive/Old"',
      ),
      summaryOf(moved),
    );
    assert(summaryOf(moved).endsWith("; 1 attachment(s) moved."));
    assertEquals(fake.calls.writes[1].args, [
      "Plans/Old",
      { newContent: undefined, newPath: "Archive/Old" },
      "move",
    ]);

    const staleDelete = await mcp.call("globnotes_delete_note", {
      path: "Archive/Old",
      expected_last_modified: stamp,
    });
    assertEquals(staleDelete.isError, true);
    assert(fake.notes.has("Archive/Old"));
    const current = isoTime(fake.notes.get("Archive/Old")!.lastModified);
    const deleted = await mcp.call("globnotes_delete_note", {
      path: "Archive/Old",
      expected_last_modified: current,
    });
    assertEquals(deleted.structuredContent, { deleted: "Archive/Old" });
    assert(!fake.notes.has("Archive/Old"));

    const missing = await mcp.call("globnotes_delete_note", {
      path: "Archive/Old",
      expected_last_modified: current,
    });
    assertEquals(missing.isError, true);
    assert(textOf(missing).startsWith("Note 'Archive/Old' not found."));
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: endpoint rules before the SDK", async () => {
  const fake = fakeVault();
  let leases = 0, reads = 0;
  const endpoint = (writable: boolean) =>
    createMcpEndpoint({
      vault: fake.vault,
      writable: () => writable,
      authenticateRead: () => {
        reads++;
        return Promise.reject(new HttpError(401, "Invalid"));
      },
      lease: () => {
        leases++;
        return Promise.reject(new HttpError(401, "Invalid"));
      },
      version: () => "test",
    });
  const post = (origin?: string) =>
    new Request(URL_BASE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  const writable = endpoint(true), readOnly = endpoint(false);
  try {
    const foreign = await writable.post(post("http://evil.example"));
    assertEquals(foreign.status, 403);
    assertEquals((await foreign.json()).id, null);
    assertEquals(leases, 0);
    assertEquals(
      (await assertRejects(() => writable.post(post()), HttpError)).status,
      401,
    );
    assertEquals([leases, reads], [1, 0]);
    assertEquals(
      (await assertRejects(() => readOnly.post(post()), HttpError)).status,
      401,
    );
    assertEquals([leases, reads], [1, 1]);
    for (const method of ["GET", "DELETE"]) {
      const res = writable.notAllowed(new Request(URL_BASE, { method }));
      assertEquals(res.status, 405);
      assertEquals(res.headers.get("allow"), "POST");
      await res.body?.cancel();
    }
    const foreignGet = writable.notAllowed(
      new Request(URL_BASE, { headers: { origin: "http://evil.example" } }),
    );
    assertEquals(foreignGet.status, 403);
    await foreignGet.body?.cancel();
  } finally {
    await writable.close();
    await readOnly.close();
  }
});

/** A storage error as Deno raises it: its message names the absolute path. */
function storageError<E extends Error>(
  Kind: new (message: string) => E,
  message: string,
): E {
  return new Kind(`${message}: readfile '/srv/globnotes/vault/a.md'`);
}

Deno.test("mcp tools: storage and library errors never reach the agent verbatim", async () => {
  const fake = fakeVault({ a: "# A\n" });
  const mcp = await connect(fake);
  const sqlite = Object.assign(new Error("database disk image is malformed"), {
    code: "ERR_SQLITE_ERROR",
  });
  try {
    for (
      const [error, expected] of [
        [
          storageError(
            Deno.errors.IsADirectory,
            "Is a directory (os error 21)",
          ),
          "globnotes can't read 'a' as a note: a folder is in its place",
        ],
        [
          storageError(
            Deno.errors.PermissionDenied,
            "Permission denied (os error 13)",
          ),
          "globnotes has no permission to access 'a' on the server's disk",
        ],
        [
          storageError(Error, "File name too long (os error 36)"),
          "globnotes hit an unexpected server error working on 'a'.",
        ],
      ] as const
    ) {
      fake.failReads(error);
      for (
        const [name, args] of [
          ["globnotes_get_note", { path: "a" }],
          ["globnotes_update_note", { path: "a", content: "x" }],
          ["globnotes_delete_note", { path: "a" }],
        ] as const
      ) {
        const result = await mcp.call(name, args);
        assertEquals(result.isError, true, name);
        assert(textOf(result).startsWith(expected), textOf(result));
        assert(!textOf(result).includes("/srv"), textOf(result));
      }
      fake.failReads(null);
      fake.failWrites(error);
      const created = await mcp.call("globnotes_create_note", {
        path: "b",
        content: "x",
      });
      assert(!textOf(created).includes("/srv"), textOf(created));
      fake.failWrites(null);
    }
    fake.failReads(sqlite);
    const broken = await mcp.call("globnotes_search_notes", { query: "x" });
    assertEquals(broken.isError, true);
    assertEquals(
      textOf(broken),
      "globnotes hit an unexpected server error. The details are in the " +
        "server log. Check the path, or try again.",
    );
    fake.failReads(null);
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: a query the index can't parse is a query error", async () => {
  const fake = fakeVault();
  const mcp = await connect(fake);
  try {
    fake.failReads(
      Object.assign(new Error("unterminated string"), {
        code: "ERR_SQLITE_ERROR",
      }),
    );
    const result = await mcp.call("globnotes_search_notes", { query: '"a' });
    assertEquals(result.isError, true);
    assertEquals(
      textOf(result),
      "The search index can't parse the query '\"a'. Check that double " +
        'quotes come in pairs ("exact phrase"), or search for plain words.',
    );
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: paths with NUL are rejected by the schema", async () => {
  const fake = fakeVault({ a: "# A\n" });
  const mcp = await connect(fake);
  try {
    for (
      const [name, args] of [
        ["globnotes_get_note", { path: "a\0b" }],
        ["globnotes_list_folder", { path: "a\0b" }],
        ["globnotes_search_notes", { query: "x", folder: "a\0b" }],
        ["globnotes_create_note", { path: "a\0b", content: "x" }],
        ["globnotes_update_note", { path: "a", new_path: "a\0b" }],
        ["globnotes_delete_note", { path: "a\0b" }],
      ] as const
    ) {
      const result = await mcp.call(name, args);
      assertEquals(result.isError, true, name);
      assert(
        textOf(result).includes("must not contain NUL characters"),
        textOf(result),
      );
    }
    assertEquals(fake.calls.search, []);
    assertEquals(fake.calls.writes, []);
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: a rename collision names the target, not the note", async () => {
  const fake = fakeVault({ a: "# A\n" });
  const mcp = await connect(fake);
  try {
    fake.failWrites(
      new NoteExistsError("Failed to rename. 'b' already exists."),
    );
    const moved = await mcp.call("globnotes_update_note", {
      path: "a",
      new_path: "b",
    });
    assertEquals(
      textOf(moved),
      "Note 'a' can't be moved to 'b': a note already exists there. " +
        "Re-read the note, then choose another new_path.",
    );
    const heading = await mcp.call("globnotes_update_note", {
      path: "a",
      content: "# B\n",
    });
    assertEquals(
      textOf(heading),
      "Note 'a' can't be renamed to match its new first heading: a note " +
        "with that name already exists in its folder. Re-read the note, " +
        "then change the heading or pass new_path.",
    );
  } finally {
    await mcp.close();
  }
});

/** A raw JSON-RPC POST to an in-process endpoint. */
function rawPost(
  endpoint: ReturnType<typeof createMcpEndpoint>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return endpoint.post(
    new Request(URL_BASE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

Deno.test("mcp tools: stateless JSON in both eras, no change notifications", async () => {
  const fake = fakeVault({ a: "# A\n" });
  const endpoint = createMcpEndpoint({
    vault: fake.vault,
    writable: () => true,
    authenticateRead: () => Promise.resolve(null),
    lease: () => Promise.resolve(LEASE),
    version: () => "test",
  });
  try {
    const legacy = await rawPost(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "raw", version: "1" },
      },
    });
    assertEquals(legacy.status, 200);
    assertEquals(legacy.headers.get("content-type"), "application/json");
    const init = await legacy.json();
    assertEquals(init.result.capabilities.tools, { listChanged: false });

    const call = await rawPost(endpoint, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "globnotes_get_note", arguments: { path: "a" } },
    }, { "mcp-protocol-version": "2025-11-25" });
    assertEquals(call.headers.get("content-type"), "application/json");
    assertEquals((await call.json()).result.structuredContent.path, "a");

    const discover = await rawPost(endpoint, {
      jsonrpc: "2.0",
      id: 3,
      method: "server/discover",
      params: { _meta: MODERN_META },
    }, {
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "server/discover",
    });
    assertEquals(discover.headers.get("content-type"), "application/json");
    assertEquals((await discover.json()).result.capabilities.tools, {
      listChanged: false,
    });

    const listen = await rawPost(endpoint, {
      jsonrpc: "2.0",
      id: 4,
      method: "subscriptions/listen",
      params: { notifications: { toolsListChanged: true }, _meta: MODERN_META },
    }, {
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "subscriptions/listen",
    });
    assertEquals(listen.status, 404);
    assertEquals(listen.headers.get("content-type"), "application/json");
    assertEquals((await listen.json()).error.code, -32601);
  } finally {
    await endpoint.close();
  }
});

Deno.test("mcp tools: a read-only 2025 batch gets the read-only tool error", async () => {
  const fake = fakeVault({ a: "# A\n" });
  const endpoint = createMcpEndpoint({
    vault: fake.vault,
    writable: () => false,
    authenticateRead: () => Promise.resolve(null),
    lease: () => Promise.reject(new Error("no lease on a read-only instance")),
    version: () => "test",
  });
  try {
    const res = await rawPost(endpoint, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "globnotes_get_note", arguments: { path: "a" } },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "globnotes_delete_note", arguments: { path: "a" } },
      },
    ], { "mcp-protocol-version": "2025-03-26" });
    assertEquals(res.status, 200);
    const replies = await res.json() as {
      id: number;
      result: { isError?: boolean; content: { text: string }[] };
    }[];
    const byId = new Map(replies.map((reply) => [reply.id, reply.result]));
    assertEquals(byId.get(1)?.isError, undefined);
    assertEquals(byId.get(2)?.isError, true);
    assertEquals(byId.get(2)?.content[0].text, READ_ONLY_MESSAGE);
    assertEquals(fake.calls.writes, []);
  } finally {
    await endpoint.close();
  }
});

interface Listing {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
}

/** Every page of a listing tool, from offset 0 to the end; each page is
 * checked against the response budget and the pagination contract. */
async function walkPages<P extends Listing>(
  mcp: Awaited<ReturnType<typeof connect>>,
  name: string,
  args: Record<string, unknown>,
): Promise<P[]> {
  const pages: P[] = [];
  for (let offset = 0;;) {
    const result = await mcp.call(name, { ...args, offset });
    assertEquals(result.isError, undefined, textOf(result));
    const page = result.structuredContent as unknown as P;
    const size = textOf(result).length + JSON.stringify(page).length;
    assert(size <= CHARACTER_LIMIT, `${name} page at ${offset}: ${size}`);
    assertEquals(page.offset, offset);
    pages.push(page);
    if (!page.has_more) {
      assertEquals(offset + page.count, page.total);
      return pages;
    }
    assert(page.count > 0);
    assertEquals(page.next_offset, offset + page.count);
    offset = page.next_offset!;
  }
}

type FolderPage = Listing & {
  folders: { path: string }[];
  notes: { path: string; title: string; truncated?: string[] }[];
};

Deno.test("mcp tools: list_folder pages a 1,000-note folder within the budget", async (t) => {
  const seed: Record<string, string> = {};
  for (let i = 0; i < 1_000; i++) {
    const n = String(i).padStart(4, "0");
    seed[`Flat/Note ${n}`] = `# Note ${n} about the garden\n`;
  }
  const fake = fakeVault(seed);
  const mcp = await connect(fake);
  try {
    for (const limit of [undefined, 500]) {
      await t.step(`limit ${limit ?? "default"}`, async () => {
        fake.calls.folder.length = 0;
        const pages = await walkPages<FolderPage>(
          mcp,
          "globnotes_list_folder",
          { path: "Flat", ...(limit ? { limit } : {}) },
        );
        // Storage is asked for each page's window, never the whole level.
        assertEquals(
          fake.calls.folder,
          pages.map((p) => ({
            path: "Flat",
            offset: p.offset,
            limit: limit ?? 100,
          })),
        );
        assertEquals(pages[0].total, 1_001);
        assertEquals(pages[0].folders.map((f) => f.path), ["Flat/Sub"]);
        const notes = pages.flatMap((p) => p.notes.map((n) => n.path));
        assertEquals(notes, [...fake.notes.keys()]);
        assert(pages.every((p) => p.notes.every((n) => !n.truncated)));
        if (limit === undefined) assertEquals(pages[0].count, 100);
        // 500 such entries are over the budget: fewer per page.
        else assert(pages[0].count < 500, String(pages[0].count));
      });
    }
    await t.step("an offset past the end is an empty last page", async () => {
      const past = await mcp.call("globnotes_list_folder", {
        path: "Flat",
        offset: 5_000,
      });
      assertEquals(
        (past.structuredContent as unknown as FolderPage).count,
        0,
      );
      assert(summaryOf(past).endsWith("none at offset 5000."));
    });
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: a note whose title alone is over the budget is listed shortened", async () => {
  const title = "Heading ".repeat(5_000).trim();
  const fake = fakeVault({ "Huge/one": `# ${title}\n`, "Huge/two": "# Two\n" });
  const mcp = await connect(fake);
  try {
    const pages = await walkPages<FolderPage>(mcp, "globnotes_list_folder", {
      path: "Huge",
    });
    const notes = pages.flatMap((p) => p.notes);
    assertEquals(notes.map((n) => n.path), ["Huge/one", "Huge/two"]);
    assertEquals(notes[0].truncated, ["title"]);
    assert(notes[0].title.startsWith("Heading Heading"));
    assert(notes[0].title.endsWith(TRUNCATED));
    assertEquals(notes[1], { path: "Huge/two", title: "Two" });
  } finally {
    await mcp.close();
  }
});

type TagsPage = Listing & { tags: string[]; truncated?: boolean };

Deno.test("mcp tools: list_tags pages many tags within the budget", async (t) => {
  const fake = fakeVault();
  const tags = Array.from(
    { length: 5_000 },
    (_, i) => `tag-${String(i).padStart(5, "0")}`,
  );
  fake.setTags(tags);
  const mcp = await connect(fake);
  try {
    for (const limit of [undefined, 2_000]) {
      await t.step(`limit ${limit ?? "default"}`, async () => {
        const pages = await walkPages<TagsPage>(
          mcp,
          "globnotes_list_tags",
          limit ? { limit } : {},
        );
        assertEquals(pages[0].total, 5_000);
        assertEquals(pages.flatMap((p) => p.tags), tags);
        if (limit === undefined) assertEquals(pages[0].count, 500);
        else assert(pages[0].count < 2_000, String(pages[0].count));
      });
    }
    await t.step("one tag over the budget is shortened, marked", async () => {
      const long = "a".repeat(40_000);
      fake.setTags(["short", long, "tail"]);
      const pages = await walkPages<TagsPage>(mcp, "globnotes_list_tags", {});
      const shortened = pages.find((p) => p.truncated);
      assertEquals(shortened?.count, 1);
      assert(shortened!.tags[0].startsWith("aaaa"));
      assert(shortened!.tags[0].endsWith(TRUNCATED));
      assertEquals(
        pages.flatMap((p) => p.tags).filter((tag) => !tag.endsWith(TRUNCATED)),
        ["short", "tail"],
      );
    });
    await t.step("limits outside the schema are refused", async () => {
      for (
        const [name, limit] of [
          ["globnotes_list_tags", 2_001],
          ["globnotes_list_tags", 0],
          ["globnotes_list_folder", 501],
        ] as const
      ) {
        const result = await mcp.call(name, { limit });
        assertEquals(result.isError, true, `${name} ${limit}`);
        assert(textOf(result).includes("Input validation error"));
      }
    });
  } finally {
    await mcp.close();
  }
});

Deno.test("mcp tools: unexpected server faults reach the error log, client rejections stay at debug", async () => {
  const logged: { level: string; text: string }[] = [];
  const original = { ...logger };
  const capture =
    (level: "debug" | "warning" | "error") => (...args: unknown[]) => {
      logged.push({
        level,
        text: args.map((a) =>
          a instanceof Error ? `${a.name}: ${a.message}` : String(a)
        ).join(" "),
      });
    };
  Object.assign(logger, {
    debug: capture("debug"),
    warning: capture("warning"),
    error: capture("error"),
  });
  const fault = () => {
    throw new Error("version store broke");
  };
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const post = (
    endpoint: ReturnType<typeof createMcpEndpoint>,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    endpoint.post(
      new Request(URL_BASE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  const legacyInit = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "raw", version: "1" },
    },
  };
  const modernList = (version: string) =>
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            ...meta,
            "io.modelcontextprotocol/protocolVersion": version,
          },
        },
      },
      { "mcp-protocol-version": version, "mcp-method": "tools/list" },
    ] as const;
  const adapters = {
    vault: fakeVault().vault,
    writable: () => true,
    authenticateRead: () => Promise.resolve(null),
    lease: () => Promise.resolve(LEASE),
  };
  const broken = createMcpEndpoint({ ...adapters, version: fault });
  const healthy = createMcpEndpoint({ ...adapters, version: () => "test" });
  const take = () => logged.splice(0);
  try {
    // A server fault while building the server, in each era: 500, logged as
    // an error with its cause.
    for (
      const [era, response] of [
        ["2025", () => post(broken, legacyInit)],
        ["2026-07-28", () => post(broken, ...modernList("2026-07-28"))],
      ] as const
    ) {
      const res = await response();
      assertEquals(res.status, 500, era);
      await res.body?.cancel();
      const entries = take();
      assert(
        entries.some((e) =>
          e.level === "error" && e.text.includes("HTTP 500") &&
          e.text.includes("version store broke")
        ),
        `${era}: ${JSON.stringify(entries)}`,
      );
    }

    // Client rejections, in each era: 4xx, at debug only.
    for (
      const [what, status, response] of [
        ["2025 malformed JSON", 400, () =>
          post(healthy, "{", {
            "mcp-protocol-version": "2025-11-25",
          })],
        [
          "2026 unsupported version",
          400,
          () => post(healthy, ...modernList("2099-01-01")),
        ],
        [
          "2026 wrong content type",
          415,
          () =>
            post(healthy, modernList("2026-07-28")[0], {
              ...modernList("2026-07-28")[1],
              "content-type": "text/plain",
            }),
        ],
      ] as const
    ) {
      const res = await response();
      assertEquals(res.status, status, what);
      await res.body?.cancel();
      const entries = take();
      assert(entries.length > 0, `${what}: the rejection is logged`);
      assert(
        entries.every((e) => e.level === "debug"),
        `${what}: ${JSON.stringify(entries)}`,
      );
    }

    // A successful exchange logs nothing above debug.
    const ok = await post(healthy, legacyInit);
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
    assertEquals(take().filter((e) => e.level !== "debug"), []);
  } finally {
    Object.assign(logger, original);
    await broken.close();
    await healthy.close();
  }
});
