// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  acquireIdentityOwnership,
  IdentityOwnershipError,
} from "../server/auth/ownership.ts";
import {
  BoundFileStore,
  StoredConfigConflict,
} from "../server/config/file_store.ts";
import { identityFixture } from "./helpers/identity.ts";
import { command, DENO } from "./helpers/process.ts";
import { done, pending, waitUntil, watchChild } from "./helpers/wait.ts";

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

Deno.test("identity ownership: initial contenders cannot replace the winner's locked inode", () =>
  identityFixture((root) => {
    const unchanged = BoundFileStore.prototype.assertUnchanged;
    let winner: ReturnType<typeof acquireIdentityOwnership> | undefined;
    let entered = false;
    // Hold A at its final absent-file boundary, run B through acquisition, then
    // resume A. Both contenders retain live handles until the assertion below.
    BoundFileStore.prototype.assertUnchanged = function (snapshot) {
      unchanged.call(this, snapshot);
      if (
        !entered && snapshot.raw === null &&
        [...Deno.readDirSync(root)].some((e) => e.name.startsWith(".config-"))
      ) {
        entered = true;
        winner = acquireIdentityOwnership(root);
      }
    };
    let loser: ReturnType<typeof acquireIdentityOwnership> | undefined;
    try {
      assertThrows(() => {
        loser = acquireIdentityOwnership(root);
      }, IdentityOwnershipError);
      assertEquals(entered, true);
      winner!.assertCurrent();
    } finally {
      BoundFileStore.prototype.assertUnchanged = unchanged;
      loser?.close();
      winner?.close();
    }
  }));

Deno.test("identity ownership: initial publication contends with a held real child", () =>
  identityFixture(async (root) => {
    const module = new URL("../server/auth/ownership.ts", import.meta.url).href;
    const storage =
      new URL("../server/config/file_store.ts", import.meta.url).href;
    const child = command(DENO, {
      args: [
        "eval",
        `import { acquireIdentityOwnership } from ${JSON.stringify(module)};
        import { BoundFileStore } from ${JSON.stringify(storage)};
        const root = ${
          JSON.stringify(root)
        }, unchanged = BoundFileStore.prototype.assertUnchanged;
        let entered = false;
        BoundFileStore.prototype.assertUnchanged = function(snapshot) {
          unchanged.call(this, snapshot);
          if (entered || snapshot.raw !== null || ![...Deno.readDirSync(root)].some(e => e.name.startsWith('.config-'))) return;
          entered = true;
          Deno.writeTextFileSync(root + '/ready', '');
          if (Deno.stdin.readSync(new Uint8Array(1)) !== 1) throw new Error('missing release');
        };
        try { const owner = acquireIdentityOwnership(root); owner.close(); }
        catch (e) { if (e.message.includes('another live owner')) Deno.exit(23); throw e; }`,
      ],
      env: { TMPDIR: Deno.env.get("TMPDIR")! },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    let winner: ReturnType<typeof acquireIdentityOwnership> | undefined;
    try {
      await waitUntil(() => {
        try {
          Deno.statSync(`${root}/ready`);
          return done();
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
          return pending("initial absence boundary");
        }
      }, {
        label: "child reaches initial lock publication",
        children: [watchChild(child)],
      });
      winner = acquireIdentityOwnership(root);
      const inode = Deno.statSync(`${root}/identity.lock`).ino;
      await writer.write(new Uint8Array([1]));
      await writer.close();
      const result = await child.output();
      assertEquals(result.code, 23, new TextDecoder().decode(result.stderr));
      assertEquals(Deno.statSync(`${root}/identity.lock`).ino, inode);
      winner.assertCurrent();
    } finally {
      winner?.close();
      try {
        await writer.close();
      } catch { /* already released */ }
      await child.status;
    }
  }));
