// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The MCP evaluation's answers, verified with the real tools
 * (plans/v2-mcp/design.md §5 row 3, mcp-builder Phase 4). Each question in
 * tests/fixtures/mcp/evaluation.xml has a scripted solution here that uses
 * only the MCP tools of a read_only server holding the fixture vault, the
 * way an agent would: search, list, read, then derive the answer from what
 * the tools returned. The derived answer must equal the file's answer.
 * Running the evaluation with an LLM is not part of the gates.
 */

import { assertEquals } from "@std/assert";
import {
  bootOnTestDomain,
  connectMcp,
  FIXTURE_NOTES,
  fixtureVaultCopy,
} from "./helpers/mcp.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

const FIXTURES = new URL("./fixtures/mcp/", import.meta.url);

interface Page {
  count: number;
  results: { path: string; title: string }[];
}
interface Note {
  path: string;
  title: string;
  content: string;
}
interface Folder {
  folders: { name: string; path: string }[];
  notes: { path: string; title: string }[];
}

type Tools = {
  search(args: Record<string, unknown>): Promise<Page>;
  get(path: string): Promise<Note>;
  list(path?: string): Promise<Folder>;
  tags(): Promise<string[]>;
};

const oneLine = (text: string) => text.replace(/\s+/g, " ");

function match(text: string, pattern: RegExp): string {
  const found = oneLine(text).match(pattern);
  if (!found) throw new Error(`no ${pattern} in ${text}`);
  return found[1];
}

/** Minutes in "1 hour 45 minutes", "3 hours 30 minutes", "40 minutes". */
function minutes(text: string): number {
  const hours = Number(text.match(/(\d+) hours?/)?.[1] ?? 0);
  const mins = Number(text.match(/(\d+) minutes?/)?.[1] ?? 0);
  return hours * 60 + mins;
}

const SOLUTIONS: ((tools: Tools) => Promise<string>)[] = [
  // 1. Japan trip cooking class -> the recipe -> its oven temperature.
  async ({ search, get }) => {
    const trip = await search({ query: '"cooking class"', folder: "Travel" });
    const day = await get(trip.results[0].path);
    const dish = match(day.content, /made a (\w+)/); // "matcha"
    const recipes = await search({ query: dish, folder: "Recipes" });
    const recipe = await get(recipes.results[0].path);
    return match(recipe.content, /Bake at (\d+) °C/);
  },
  // 2. The garlic bed -> what went into it next.
  async ({ search, get }) => {
    const hits = await search({ query: "garlic", folder: "Garden" });
    for (const hit of hits.results) {
      const note = oneLine((await get(hit.path)).content);
      const bed = note.match(/(Bed \d+): garlic/)?.[1];
      if (!bed) continue;
      return match(note, new RegExp(`(\\w+ \\w+) went into ${bed}`))
        .toLowerCase();
    }
    throw new Error("no bed note names the garlic");
  },
  // 3. The book-review tag -> its notes -> the 5/5 ratings.
  async ({ tags, search, get }) => {
    const tag = (await tags()).find((t) => t.includes("review"))!;
    const reviews = await search({ query: `#${tag}`, limit: 100 });
    let top = 0;
    for (const hit of reviews.results) {
      if ((await get(hit.path)).content.includes("Rating: 5/5")) top++;
    }
    return String(top);
  },
  // 4. Every work project -> its deadline -> the earliest.
  async ({ list, get }) => {
    const work = await list("Work");
    const projects = await list(
      work.folders.find((f) => f.name === "Projects")!.path,
    );
    const deadlines = await Promise.all(projects.notes.map(async (n) => {
      const note = await get(n.path);
      return {
        title: note.title,
        at: Date.parse(match(note.content, /Deadline: (\d+ \w+ \d{4})/)),
      };
    }));
    deadlines.sort((a, b) => a.at - b.at);
    return deadlines[0].title;
  },
  // 5. The borrowed novel in the journal -> its book note -> the author.
  async ({ search, get }) => {
    const entries = await search({ query: "lent", folder: "Journal" });
    const entry = await get(entries.results[0].path);
    const book = match(entry.content, /copy of (.+?);/);
    const notes = await search({ query: `"${book}"`, folder: "Books" });
    const review = await get(
      notes.results.find((r) => r.title === book)!.path,
    );
    return match(review.content, /By [A-Z]\w+ ([A-Z]\w+)/);
  },
  // 6. The Japan itinerary -> its last night's hotel.
  async ({ search, get }) => {
    const trip = await search({ query: "#japan itinerary" });
    const plan = await get(trip.results[0].path);
    const rows = plan.content.split("\n")
      .filter((line) => /^\|\s*\d+\s*\|/.test(line))
      .map((line) => line.split("|").map((cell) => cell.trim()));
    rows.sort((a, b) => Number(a[1]) - Number(b[1]));
    return rows.at(-1)![3];
  },
  // 7. The note titled "Seed starting calendar" -> its folder.
  async ({ search }) => {
    const hits = await search({ query: '"seed starting calendar"' });
    const note = hits.results.find((r) =>
      r.title === "Seed starting calendar"
    )!;
    return note.path.slice(0, note.path.lastIndexOf("/"));
  },
  // 8. Vegetarian recipes -> their total times -> the longest.
  async ({ search, get }) => {
    const recipes = await search({ query: "#vegetarian", limit: 100 });
    const times = await Promise.all(recipes.results.map(async (r) => {
      const note = await get(r.path);
      return {
        title: note.title,
        minutes: minutes(match(note.content, /Total time: ([^.,]+)/)),
      };
    }));
    times.sort((a, b) => b.minutes - a.minutes);
    return times[0].title;
  },
  // 9. The Japan trip folder -> its notes.
  async ({ list }) => {
    const travel = await list("Travel");
    const japan = travel.folders.find((f) => f.name.includes("Japan"))!;
    return String((await list(japan.path)).notes.length);
  },
  // 10. The dashboard project -> its kickoff meeting -> the database.
  async ({ search, get }) => {
    const projects = await search({
      query: "analytics dashboard",
      folder: "Work",
    });
    const project = projects.results[0].title; // "Lighthouse"
    const meetings = await search({ query: `${project} kickoff` });
    const kickoff = await get(
      meetings.results.find((r) => r.path.includes("Meetings"))!.path,
    );
    return match(kickoff.content, /we chose (\w+)/);
  },
];

Deno.test("mcp evaluation: every answer is derived with the real tools", async () => {
  const xml = await Deno.readTextFile(new URL("evaluation.xml", FIXTURES));
  const pairs = [
    ...xml.matchAll(
      /<qa_pair>\s*<question>([\s\S]*?)<\/question>\s*<answer>([\s\S]*?)<\/answer>\s*<\/qa_pair>/g,
    ),
  ].map((m) => ({ question: m[1].trim(), answer: m[2].trim() }));
  assertEquals(pairs.length, 10);
  assertEquals(SOLUTIONS.length, pairs.length);

  const vault = await fixtureVaultCopy();
  // read_only: the evaluation is answerable without any write tool.
  const server = await bootOnTestDomain({
    GLOBNOTES_PATH: vault,
    GLOBNOTES_AUTH_TYPE: "read_only",
  });
  try {
    const client = await connectMcp(server);
    try {
      const callTool = async <T>(name: string, args = {}): Promise<T> => {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) {
          throw new Error(`${name}: ${JSON.stringify(result.content)}`);
        }
        return result.structuredContent as T;
      };
      const tools: Tools = {
        search: (args) => callTool<Page>("globnotes_search_notes", args),
        get: (p) => callTool<Note>("globnotes_get_note", { path: p }),
        list: (p = "") =>
          callTool<Folder>("globnotes_list_folder", { path: p }),
        tags: async () =>
          (await callTool<{ tags: string[] }>("globnotes_list_tags")).tags,
      };
      await waitUntil(async () => {
        const page = await tools.search({ query: "*", limit: 100 });
        return page.count === FIXTURE_NOTES ? done() : pending(page.count);
      }, {
        label: "fixture vault indexed",
        intervalMs: 100,
        children: [server],
      });

      const derived = [];
      for (const solve of SOLUTIONS) derived.push(await solve(tools));
      assertEquals(derived, pairs.map((pair) => pair.answer));
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
    await Deno.remove(vault, { recursive: true });
  }
});
