// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mergeText } from "../server/hub/merge.ts";

Deno.test("hub merge: mixed current line endings survive replacements and insertions", () => {
  assertEquals(
    mergeText(
      "a\nmiddle\nlast\n",
      "mine\nmiddle\nlast\n",
      "a\r\nmiddle\noutside\r\n",
    ),
    "mine\r\nmiddle\noutside\r\n",
  );
  assertEquals(
    mergeText("a\nb\nc\nd\n", "a\nb\nadded\nc\nd\n", "a\r\nb\nc\r\ntheirs\n"),
    "a\r\nb\nadded\r\nc\r\ntheirs\n",
  );
});

Deno.test("hub merge: prototype-named logical lines are ordinary content", () => {
  for (const line of ["__proto__", "constructor", "toString"]) {
    assertEquals(
      mergeText(
        `a\n${line}\nz\n`,
        `mine\n${line}\nz\n`,
        `a\n${line}\ntheirs\n`,
      ),
      `mine\n${line}\ntheirs\n`,
    );
  }
});
