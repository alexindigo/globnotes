// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { readCredential, readCredentialCookie } from "../shared/credentials.ts";

Deno.test("credential parser: RFC Bearer separators and b64token grammar", () => {
  for (const separator of [" ", "  ", "     "]) {
    assertEquals(
      readCredential(
        `bEaReR${separator}AZaz09-._~+/==`,
        "token=other",
        "token",
      ),
      "AZaz09-._~+/==",
    );
  }
  for (
    const header of [
      "",
      "Basic abc",
      "Bearer",
      "Bearer ",
      "Bearer\tabc",
      "Bearer a b",
      "Bearer a,b",
      "Bearer =abc",
      "Bearer ab=c",
      "Bearer abc\n",
    ]
  ) {
    assertThrows(
      () => readCredential(header, "token=good", "token"),
      TypeError,
    );
  }
});

Deno.test("credential parser: named malformed or duplicate cookies never become absence", () => {
  for (
    const header of [
      "token",
      "other; token",
      "token=",
      "token=%ZZ",
      "token=%20",
      "token =good",
      "token=good; token",
      "token; token=good",
      "token=good; token=good",
    ]
  ) {
    assertThrows(() => readCredentialCookie(header, "token"), TypeError);
  }
  assertEquals(
    readCredentialCookie("other; token-extra; unrelated=%ZZ", "token"),
    null,
  );
  assertEquals(
    readCredentialCookie("other; token=abc%2B%2F%3D", "token"),
    "abc+/=",
  );
  assertEquals(readCredential("Bearer abc", "token", "token"), "abc");
});
