// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Frontmatter YAML-subset parser: scalars, string lists (flow + block),
 * unknown keys verbatim, order preserved. These pins back the shared
 * parser used by the server renderer and the client Properties panel.
 */

import { assertEquals } from "@std/assert";

import {
  parseFrontmatter,
  serializeFrontmatter,
} from "../shared/frontmatter.ts";

Deno.test("frontmatter: parses plain and quoted scalars", () => {
  const entries = parseFrontmatter(
    'title: My note\nsubtitle: "Quoted: title"\nempty:\n',
  );
  assertEquals(entries.length, 3);
  assertEquals(entries[0], {
    key: "title",
    value: { kind: "scalar", text: "My note" },
  });
  assertEquals(entries[1], {
    key: "subtitle",
    value: { kind: "scalar", text: "Quoted: title" },
  });
  assertEquals(entries[2], {
    key: "empty",
    value: { kind: "scalar", text: "" },
  });
});

Deno.test("frontmatter: parses flow lists", () => {
  const entries = parseFrontmatter("tags: [a, b, c]\n");
  assertEquals(entries[0].value, { kind: "list", items: ["a", "b", "c"] });
});

Deno.test("frontmatter: parses block lists", () => {
  const entries = parseFrontmatter("aliases:\n- one\n- two words\n");
  assertEquals(entries[0].value, {
    kind: "list",
    items: ["one", "two words"],
  });
});

Deno.test("frontmatter: parses indented block lists (Obsidian style)", () => {
  const entries = parseFrontmatter("tags:\n  - test\n  - meta\ndraft: false\n");
  assertEquals(entries[0].value, { kind: "list", items: ["test", "meta"] });
  assertEquals(entries[1].value, { kind: "scalar", text: "false" });
  // Re-serializing dedents the items (semantically identical YAML).
  const out = serializeFrontmatter(entries);
  assertEquals(parseFrontmatter(out), entries);
});

Deno.test("frontmatter: parses flow lists containing quoted commas", () => {
  const entries = parseFrontmatter('tags: ["a, b", c]\n');
  assertEquals(entries[0].value, { kind: "list", items: ["a, b", "c"] });
});

Deno.test("frontmatter: preserves key order and unknown keys", () => {
  const entries = parseFrontmatter(
    "zeta: last\nalpha: first\nmiddle: [1, 2]\n",
  );
  assertEquals(entries.map((e) => e.key), ["zeta", "alpha", "middle"]);
});

Deno.test("frontmatter: preserves complex values verbatim as raw", () => {
  const yaml = "meta:\n  nested: true\n  deep:\n    - x\n";
  const entries = parseFrontmatter(yaml);
  assertEquals(entries[0].value, {
    kind: "raw",
    text: "\n  nested: true\n  deep:\n    - x",
  });
});

Deno.test("frontmatter: keeps number-ish and boolean-ish scalars textual", () => {
  const entries = parseFrontmatter("count: 42\npublished: true\nscore: 1.5\n");
  assertEquals(entries[0].value, { kind: "scalar", text: "42" });
  assertEquals(entries[1].value, { kind: "scalar", text: "true" });
  assertEquals(entries[2].value, { kind: "scalar", text: "1.5" });
});

Deno.test("frontmatter: round-trips parse/serialize for the whole subset", () => {
  const yaml =
    'title: My note\ntags: [a, b, "c: d"]\naliases:\n- one\n- two\npublished: true\ncount: 42\n';
  const first = parseFrontmatter(yaml);
  const second = parseFrontmatter(serializeFrontmatter(first));
  assertEquals(second, first);
});

Deno.test("frontmatter: round-trips raw values byte-for-byte", () => {
  const yaml = "meta:\n  nested: true\n  anchor: &a value\n";
  const first = parseFrontmatter(yaml);
  assertEquals(serializeFrontmatter(first), yaml.replace(/\n$/, ""));
});Deno.test("frontmatter: quotes scalars that would corrupt YAML", () => {
  const out = serializeFrontmatter([
    { key: "title", value: { kind: "scalar", text: "Note: [bracketed]" } },
  ]);
  assertEquals(out, 'title: "Note: [bracketed]"');
  // The quoted form re-parses to the same scalar — no corruption.
  assertEquals(parseFrontmatter(out)[0].value, {
    kind: "scalar",
    text: "Note: [bracketed]",
  });
});

Deno.test("frontmatter: serializes empty lists as flow empty", () => {
  const out = serializeFrontmatter([
    { key: "tags", value: { kind: "list", items: [] } },
  ]);
  assertEquals(out, "tags: []");
  assertEquals(parseFrontmatter(out)[0].value, { kind: "list", items: [] });
});
