// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertThrows } from "@std/assert";
import { readAppVersion } from "../server/version.ts";
import { formatVersion } from "../shared/version.ts";
import { bootServer } from "./helpers/boot.ts";

const RELEASE = Deno.readTextFileSync(new URL("../VERSION", import.meta.url))
  .trim();
const REVISION = "0123456789abcdef0123456789abcdef01234567";

function envOf(values: Record<string, string>) {
  return { get: (name: string) => values[name] };
}

async function withVersionFile(
  content: string,
  fn: (file: string) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "globnotes-version-" });
  try {
    await Deno.writeTextFile(`${dir}/VERSION`, content);
    await fn(`${dir}/VERSION`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("reads MAJOR.MINOR.PATCH from VERSION, trimmed, without a revision", async () => {
  await withVersionFile(" 2.3.2\n", (file) => {
    assertEquals(readAppVersion({ file, env: envOf({}) }), {
      version: "2.3.2",
      revision: null,
    });
  });
});

Deno.test("accepts MAJOR.MINOR", async () => {
  await withVersionFile("2.4\n", (file) => {
    assertEquals(readAppVersion({ file, env: envOf({}) }).version, "2.4");
  });
});

Deno.test("defaults to the repository VERSION file", () => {
  assertEquals(readAppVersion({ env: envOf({}) }).version, RELEASE);
});

Deno.test("a missing VERSION file is a startup error", async () => {
  const dir = await Deno.makeTempDir({ prefix: "globnotes-version-" });
  try {
    assertThrows(
      () => readAppVersion({ file: `${dir}/VERSION`, env: envOf({}) }),
      Error,
      "VERSION",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an invalid VERSION file is a startup error", async () => {
  for (const content of ["", "v2.3.2", "2", "2.3.2.1", "2.3.x", "2.3.2-beta"]) {
    await withVersionFile(`${content}\n`, (file) => {
      assertThrows(
        () => readAppVersion({ file, env: envOf({}) }),
        Error,
        "MAJOR.MINOR",
      );
    });
  }
});

Deno.test("accepts a 7-40 character lowercase hex revision", async () => {
  await withVersionFile("2.3.2\n", (file) => {
    for (const revision of ["85dbf7a", REVISION]) {
      assertEquals(
        readAppVersion({ file, env: envOf({ GLOBNOTES_REVISION: revision }) }),
        { version: "2.3.2", revision },
      );
    }
  });
});

Deno.test("an empty revision means no revision", async () => {
  await withVersionFile("2.3.2\n", (file) => {
    assertEquals(
      readAppVersion({ file, env: envOf({ GLOBNOTES_REVISION: "" }) })
        .revision,
      null,
    );
  });
});

Deno.test("an invalid revision is a startup error", async () => {
  await withVersionFile("2.3.2\n", (file) => {
    for (
      const revision of [
        "0123ab",
        REVISION + "0",
        REVISION.toUpperCase(),
        "g123456",
        " 0123456",
      ]
    ) {
      assertThrows(
        () =>
          readAppVersion({
            file,
            env: envOf({ GLOBNOTES_REVISION: revision }),
          }),
        Error,
        "GLOBNOTES_REVISION",
      );
    }
  });
});

Deno.test("formats the display version", () => {
  assertEquals(
    formatVersion({ version: "2.3.2", revision: REVISION }),
    "v2.3.2 (0123456)",
  );
  assertEquals(
    formatVersion({ version: "2.3.2", revision: null }),
    "v2.3.2-dev",
  );
  assertEquals(formatVersion({ version: null, revision: REVISION }), "");
});

Deno.test("/_/api/config returns the version and full revision", async () => {
  const server = await bootServer({
    fixtureAuth: { auth_type: "none" },
    GLOBNOTES_REVISION: REVISION,
  });
  try {
    const config = await (await fetch(`${server.baseUrl}/_/api/config`))
      .json();
    assertEquals(config.version, RELEASE);
    assertEquals(config.revision, REVISION);
  } finally {
    await server.close();
  }
});

Deno.test("/_/api/config returns a null revision when none is supplied", async () => {
  const server = await bootServer({
    fixtureAuth: { auth_type: "none" },
    GLOBNOTES_REVISION: "",
  });
  try {
    const config = await (await fetch(`${server.baseUrl}/_/api/config`))
      .json();
    assertEquals(config.version, RELEASE);
    assertEquals(config.revision, null);
  } finally {
    await server.close();
  }
});

Deno.test("startup logs the version before the listening line", async () => {
  const vault = await Deno.makeTempDir({ prefix: "globnotes-version-vault-" });
  // bootServer returns once the server reported its listening line (and is
  // healthy); the version line must already precede it on stdout.
  const server = await bootServer({
    GLOBNOTES_GLOBNOTES_PATH: vault,
    fixtureAuth: { auth_type: "none" },
    GLOBNOTES_REVISION: "",
  });
  const output = server.logs().stdout;
  await server.close();
  await Deno.remove(vault, { recursive: true });
  const lines = output.split("\n");
  const versionAt = lines.findIndex((line) =>
    line.endsWith(`]: globnotes v${RELEASE}-dev`)
  );
  const listeningAt = lines.findIndex((line) =>
    line.includes("globnotes listening on")
  );
  assert(
    versionAt >= 0 && listeningAt > versionAt,
    `version line must precede the listening line:\n${output}`,
  );
});
