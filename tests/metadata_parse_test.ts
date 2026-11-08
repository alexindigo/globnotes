// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { parseMetadata } from "../server/metadata/parse.ts";

Deno.test("metadata parser: ordered string properties, Markdown/reference/wiki links, nested tasks and source lines across BOM/CRLF", () => {
  const result = parseMetadata(
    '\uFEFF---\r\ncount: 12\r\ntags: [a, "b"]\r\nnested:\r\n  x: y\r\n---\r\n# Hello *world*\r\n[ref][r] ![image](pic.png) [[Note|Alias]] ![[Embed]]\r\n- [ ] outer\r\n  - [X] inner\r\nkey:: value\r\nkey:: again\r\n\r\n[r]: folder/note.md\r\n',
  );
  assertEquals(result.properties, [
    { key: "count", value: { kind: "scalar", text: "12" } },
    { key: "tags", value: { kind: "list", items: ["a", "b"] } },
    { key: "nested", value: { kind: "raw", text: "\n  x: y" } },
  ]);
  assertEquals(result.headings, [{ level: 1, text: "Hello world", line: 7 }]);
  assertEquals(result.links, [
    { target: "folder/note.md", label: "ref", embed: false, line: 8 },
    { target: "pic.png", label: "image", embed: true, line: 8 },
    { target: "Note", label: "Alias", embed: false, line: 8 },
    { target: "Embed", label: "Embed", embed: true, line: 8 },
  ]);
  assertEquals(result.tasks, [{ text: "outer", checked: false, line: 9 }, {
    text: "inner key:: value key:: again",
    checked: true,
    line: 10,
  }]);
  assertEquals(result.fields, [{ key: "key", value: "value", line: 11 }, {
    key: "key",
    value: "again",
    line: 12,
  }]);
});
Deno.test("metadata parser: code, raw HTML, escaped wiki and unfinished frontmatter create no invented facts", () => {
  const result = parseMetadata(
    "```md\n- [ ] nope\nkey:: nope\n[[nope]]\n```\n\n    [[indented]]\n\n`[[inline]] key:: hidden`\n\\[[escaped]]\n<span>[[html]] key:: hidden</span>\n\n<div>\n- [ ] hidden\n[[block]]\n</div>\n\n- [ ] real `code`\n",
  );
  assertEquals(result.links, []);
  assertEquals(result.fields, []);
  assertEquals(result.tasks, [{ text: "real code", checked: false, line: 18 }]);
  assertEquals(parseMetadata("---\nkey: value\n# hidden\n[[hidden]]"), {
    properties: [],
    headings: [],
    links: [],
    tasks: [],
    fields: [],
  });
});

Deno.test("metadata parser: source lines survive multiline inline code, images and raw Markdown destinations", () => {
  const parsed = parseMetadata(
    "`multi\nline` [[After]]\n![multi\nlabel](pic) [raw](javascript:alert(1))\n[dest](\nfolder/note.md\n) [[Last]]",
  );
  assertEquals(parsed.links, [
    { target: "After", label: "After", embed: false, line: 2 },
    { target: "pic", label: "multi\nlabel", embed: true, line: 3 },
    { target: "javascript:alert(1)", label: "raw", embed: false, line: 4 },
    { target: "folder/note.md", label: "dest", embed: false, line: 5 },
    { target: "Last", label: "Last", embed: false, line: 7 },
  ]);
});

Deno.test("metadata parser: inline field values retain source strings while Markdown values still contribute links", () => {
  const parsed = parseMetadata(
    "key:: [label](target) `code` &amp;\nkey:: [[Other]]\n`key:: hidden`\n<span>key:: hidden</span>",
  );
  assertEquals(parsed.fields, [{
    key: "key",
    value: "[label](target) `code` &amp;",
    line: 1,
  }, { key: "key", value: "[[Other]]", line: 2 }]);
  assertEquals(parsed.links.map((l) => l.target), ["target", "Other"]);
  assertEquals(parseMetadata("- [ ] owner:: [[Alice]]").fields, [{
    key: "owner",
    value: "[[Alice]]",
    line: 1,
  }]);
});
