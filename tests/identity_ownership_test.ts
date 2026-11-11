// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  acquireIdentityOwnership,
  IdentityOwnershipError,
} from "../server/auth/ownership.ts";
import { StoredConfigConflict } from "../server/config/file_store.ts";
import { identityFixture } from "./helpers/identity.ts";
import { command, DENO } from "./helpers/process.ts";

Deno.test("identity ownership: stable inode, nonblocking contention and release", () =>
  identityFixture((root) => {
    const owner = acquireIdentityOwnership(`${root}/new/state`);
    const file = `${root}/new/state/identity.lock`,
      ino = Deno.statSync(file).ino;
    try {
      owner.assertCurrent();
      assertThrows(
        () => acquireIdentityOwnership(`${root}/new/state`),
        IdentityOwnershipError,
      );
      assertEquals(Deno.statSync(file).mode! & 0o777, 0o600);
    } finally {
      owner.close();
    }
    owner.close();
    assertThrows(() => owner.assertCurrent(), IdentityOwnershipError);
    const next = acquireIdentityOwnership(`${root}/new/state`);
    next.close();
    assertEquals(Deno.statSync(file).ino, ino);
  }));

Deno.test("identity ownership: a real child cannot queue recovery behind the server", () =>
  identityFixture(async (root) => {
    const module = new URL("../server/auth/ownership.ts", import.meta.url).href;
    const run = () =>
      command(DENO, {
        args: [
          "eval",
          `import { acquireIdentityOwnership } from ${JSON.stringify(module)};
        try { const owner = acquireIdentityOwnership(${
            JSON.stringify(root)
          }); owner.close(); }
        catch (e) { if (e.name === 'Error' && e.message.includes('another live owner')) Deno.exit(23); throw e; }`,
        ],
        env: { TMPDIR: Deno.env.get("TMPDIR")! },
        stdout: "piped",
        stderr: "piped",
      }).output();
    const owner = acquireIdentityOwnership(root);
    try {
      assertEquals((await run()).code, 23);
    } finally {
      owner.close();
    }
    assertEquals((await run()).code, 0);
  }));

Deno.test("identity ownership: replacement and retarget retire the owner without deleting evidence", () =>
  identityFixture((root) => {
    const owner = acquireIdentityOwnership(root);
    try {
      Deno.writeTextFileSync(`${root}/replacement`, "");
      Deno.renameSync(`${root}/replacement`, `${root}/identity.lock`);
      assertThrows(() => owner.assertCurrent(), StoredConfigConflict);
    } finally {
      owner.close();
    }
    assertEquals(Deno.readTextFileSync(`${root}/identity.lock`), "");
  }));
