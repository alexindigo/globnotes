// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { VaultHub } from "../server/hub/hub.ts";
import type { ChangeEntry } from "../server/hub/types.ts";

function fixture() {
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(`${root}/vault`);
  const hub = new VaultHub(`${root}/vault`, `${root}/vault/.globnotes`);
  const batches: ChangeEntry[][] = [];
  hub.subscribe((entries) => batches.push(entries));
  return {
    root,
    vault: `${root}/vault`,
    hub,
    batches,
    close() {
      hub.stop();
      Deno.removeSync(root, { recursive: true });
    },
  };
}

/** Real chmod denial for ordinary users; privileged readers exercise the same
 * error boundary with a scoped fault, without skipping the contract assertions
 * or requiring the extra allow-sys permission that Deno.uid() needs. */
function lockDirectory(directory: string): () => void {
  Deno.chmodSync(directory, 0);
  const read = Deno.readDirSync;
  let privileged = false;
  try {
    [...read(directory)];
    privileged = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.PermissionDenied)) {
      Deno.chmodSync(directory, 0o700);
      throw error;
    }
  }
  if (privileged) {
    Deno.readDirSync = (name) => {
      if (name === directory) {
        throw new Deno.errors.PermissionDenied(
          "scoped directory-read fault for privileged reader",
        );
      }
      return read(name);
    };
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (privileged) Deno.readDirSync = read;
    Deno.chmodSync(directory, 0o700);
  };
}

Deno.test("hub scanner: external create/modify/delete/rename, stat-only skip, hidden files and state exclusion", () => {
  const f = fixture();
  try {
    Deno.mkdirSync(`${f.vault}/.hidden`);
    Deno.writeTextFileSync(`${f.vault}/.hidden/note.md`, "secret content");
    Deno.writeTextFileSync(`${f.vault}/.globnotes/private.md`, "host state");
    assertEquals(f.hub.scanNow().hashed, 1);
    assertEquals(f.batches[0][0].kind, "created");
    assertEquals(f.hub.fileState(".globnotes/private.md"), null);
    assertEquals(f.hub.scanNow().hashed, 0);
    Deno.utimeSync(`${f.vault}/.hidden/note.md`, 1000, 1000);
    assertEquals(f.hub.scanNow().hashed, 1);
    assertEquals(
      f.batches.length,
      1,
      "mtime change without content is not a change",
    );
    assertEquals(
      f.hub.scanNow().hashed,
      0,
      "stat hints refreshed after identical hash",
    );
    Deno.writeTextFileSync(`${f.vault}/.hidden/note.md`, "modified content");
    f.hub.scanNow();
    assertEquals(f.batches.at(-1)![0].kind, "modified");
    Deno.renameSync(`${f.vault}/.hidden/note.md`, `${f.vault}/renamed.md`);
    f.hub.scanNow();
    assertEquals(f.batches.at(-1)![0].kind, "renamed");
    assertEquals(f.batches.at(-1)![0].oldPath, ".hidden/note.md");
    assertEquals(f.hub.fileState("renamed.md")?.vector, { local: 3 });
    Deno.removeSync(`${f.vault}/renamed.md`);
    f.hub.scanNow();
    assertEquals(f.batches.at(-1)![0].kind, "deleted");
    assert(f.batches.flat().every((e) => e.peer === "local"));
  } finally {
    f.close();
  }
});
Deno.test("hub scanner: unreadable subtree is unknown, readable sibling still changes", () => {
  const f = fixture();
  let unlock = () => {};
  try {
    Deno.mkdirSync(`${f.vault}/locked`);
    Deno.writeTextFileSync(`${f.vault}/locked/keep.md`, "keep");
    Deno.writeTextFileSync(`${f.vault}/sibling.md`, "remove");
    f.hub.scanNow();
    unlock = lockDirectory(`${f.vault}/locked`);
    Deno.removeSync(`${f.vault}/sibling.md`);
    const stats = f.hub.scanNow();
    assertEquals(stats.unknown, ["locked"]);
    assert(f.hub.fileState("locked/keep.md"));
    assertEquals(f.hub.fileState("sibling.md"), null);
    unlock();
    Deno.removeSync(`${f.vault}/locked/keep.md`);
    f.hub.scanNow();
    assertEquals(f.hub.fileState("locked/keep.md"), null);
  } finally {
    unlock();
    f.close();
  }
});
Deno.test("hub scanner: NFC collisions reported without merging, case counts, symlinks skipped", () => {
  const f = fixture();
  try {
    const nfc = "café.md", nfd = "cafe\u0301.md";
    Deno.writeTextFileSync(`${f.vault}/${nfd}`, "first");
    f.hub.scanNow();
    Deno.writeTextFileSync(`${f.vault}/${nfc}`, "other");
    Deno.writeTextFileSync(`${f.vault}/Case.md`, "upper");
    Deno.writeTextFileSync(`${f.vault}/case.md`, "lower");
    Deno.symlinkSync(`${f.vault}/Case.md`, `${f.vault}/link.md`);
    Deno.symlinkSync(f.vault, `${f.vault}/loop`);
    const stats = f.hub.scanNow();
    assertEquals(stats.symlinks, 2);
    assertEquals(f.hub.fileState(nfc)?.diskPath, nfd);
    assertEquals(f.hub.collisions(), [{ key: nfc, paths: [nfd, nfc] }]);
    assertEquals(Deno.readTextFileSync(`${f.vault}/${nfd}`), "first");
    assertEquals(Deno.readTextFileSync(`${f.vault}/${nfc}`), "other");
    assertEquals(f.hub.fileState("link.md"), null);
    assert(f.hub.fileState("Case.md"));
    assert(f.hub.fileState("case.md"));
  } finally {
    f.close();
  }
});
Deno.test("hub scanner: ambiguous same-hash moves stay delete/create", () => {
  const f = fixture();
  try {
    for (const name of ["a", "b"]) {
      Deno.writeTextFileSync(`${f.vault}/${name}`, "same");
    }
    f.hub.scanNow();
    Deno.renameSync(`${f.vault}/a`, `${f.vault}/c`);
    Deno.renameSync(`${f.vault}/b`, `${f.vault}/d`);
    f.hub.scanNow();
    assertEquals(f.batches.at(-1)!.map((e) => e.kind).sort(), [
      "created",
      "created",
      "deleted",
      "deleted",
    ]);
  } finally {
    f.close();
  }
});

Deno.test("hub scanner: NFC directory aliases cannot replace the first file owner", () => {
  const f = fixture();
  try {
    const first = "café/note.md", second = "cafe\u0301/note.md";
    Deno.mkdirSync(`${f.vault}/café`);
    Deno.writeTextFileSync(`${f.vault}/${first}`, "first owner");
    f.hub.scanNow();
    Deno.mkdirSync(`${f.vault}/cafe\u0301`);
    Deno.writeTextFileSync(`${f.vault}/${second}`, "colliding other bytes");
    f.hub.scanNow();
    assertEquals(f.hub.fileState(first)?.diskPath, first);
    assertEquals(f.batches.length, 1);
    f.hub.scanNow(["cafe\u0301"]);
    assertEquals(f.hub.fileState(first)?.diskPath, first);
    assertEquals(f.batches.length, 1);
    assertEquals(f.hub.collisions()[0].key, first);
    assertEquals(
      new Set(f.hub.collisions()[0].paths),
      new Set([first, second]),
    );
  } finally {
    f.close();
  }
});

Deno.test("hub scanner: periodic fallback survives unavailable watcher and reads interval once", async () => {
  const previous = Deno.env.get("GLOBNOTES_HUB_SCAN_INTERVAL"),
    watch = Deno.watchFs;
  Deno.env.set("GLOBNOTES_HUB_SCAN_INTERVAL", "0.05");
  const f = fixture();
  try {
    Deno.watchFs = () => {
      throw new Error("watcher unavailable fixture");
    };
    f.hub.start();
    Deno.watchFs = watch;
    Deno.env.set("GLOBNOTES_HUB_SCAN_INTERVAL", "60");
    Deno.writeTextFileSync(`${f.vault}/periodic.md`, "periodic");
    const deadline = Date.now() + 1500;
    while (!f.hub.fileState("periodic.md") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(f.hub.fileState("periodic.md"));
  } finally {
    Deno.watchFs = watch;
    if (previous === undefined) Deno.env.delete("GLOBNOTES_HUB_SCAN_INTERVAL");
    else Deno.env.set("GLOBNOTES_HUB_SCAN_INTERVAL", previous);
    f.close();
  }
});
Deno.test("hub scanner: expectations shield in-progress paths; subscribers run after commit and are isolated", () => {
  const f = fixture();
  try {
    Deno.writeTextFileSync(`${f.vault}/own.md`, "initial");
    f.hub.scanNow();
    const token = f.hub.expect([`${f.vault}/own.md`]);
    Deno.removeSync(`${f.vault}/own.md`);
    f.hub.scanNow();
    assert(f.hub.fileState("own.md"));
    f.hub.subscribe(() => {
      throw new Error("subscriber failure fixture");
    });
    let committed = false;
    const dispose = f.hub.subscribe((entries) => {
      committed = entries[0].peer === "globnotes" &&
        f.hub.fileState("own.md") === null;
    });
    f.hub.record(token, [{ kind: "remove", path: `${f.vault}/own.md` }], "api");
    assert(committed);
    dispose();
    const count = f.batches.length;
    f.hub.scanNow();
    assertEquals(f.batches.length, count);
  } finally {
    f.close();
  }
});
Deno.test("hub scanner: watcher notices nested writes without explicit scan", async () => {
  const f = fixture();
  try {
    f.hub.start();
    Deno.mkdirSync(`${f.vault}/nested`);
    Deno.writeTextFileSync(`${f.vault}/nested/live.md`, "watch");
    const deadline = Date.now() + 2500;
    while (!f.hub.fileState("nested/live.md") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert(f.hub.fileState("nested/live.md"));
  } finally {
    f.close();
  }
});

Deno.test("hub scanner: expect targets raw file spellings and directories, then reserves their descendants", () => {
  const f = fixture();
  try {
    const nfd = "cafe\u0301.md";
    Deno.writeTextFileSync(`${f.vault}/${nfd}`, "outside unicode");
    Deno.mkdirSync(`${f.vault}/directory`);
    Deno.writeTextFileSync(`${f.vault}/directory/child.md`, "outside child");
    Deno.writeTextFileSync(`${f.vault}/unrelated.md`, "not an affected path");
    const token = f.hub.expect([`${f.vault}/${nfd}`, `${f.vault}/directory`]);
    assertEquals(f.hub.fileState("café.md")?.diskPath, nfd);
    assertEquals(f.hub.fileState("directory/child.md")?.vector, { local: 1 });
    assertEquals(f.hub.fileState("unrelated.md"), null);
    const before = f.batches.length;
    Deno.writeTextFileSync(
      `${f.vault}/directory/child.md`,
      "outside while reserved",
    );
    f.hub.scanNow(["directory"]);
    assertEquals(f.batches.length, before);
    f.hub.record(token, [], "api");
    f.hub.scanNow(["directory"]);
    assertEquals(f.hub.fileState("directory/child.md")?.vector, { local: 2 });
  } finally {
    f.close();
  }
});

Deno.test("hub scanner: expect preserves unknown subtrees and excludes state and symlink ancestors", () => {
  const f = fixture();
  let unlock = () => {};
  try {
    Deno.mkdirSync(`${f.vault}/locked`);
    Deno.writeTextFileSync(`${f.vault}/locked/keep.md`, "known");
    f.hub.scanNow();
    Deno.removeSync(`${f.vault}/locked/keep.md`);
    unlock = lockDirectory(`${f.vault}/locked`);
    Deno.writeTextFileSync(`${f.vault}/.globnotes/private.md`, "host state");
    Deno.mkdirSync(`${f.root}/outside/nested`, { recursive: true });
    Deno.writeTextFileSync(
      `${f.root}/outside/nested/hidden.md`,
      "outside vault",
    );
    Deno.symlinkSync(`${f.root}/outside`, `${f.vault}/link`);
    const token = f.hub.expect([
      `${f.vault}/locked`,
      `${f.vault}/.globnotes`,
      `${f.vault}/link/nested`,
    ]);
    assert(f.hub.fileState("locked/keep.md"), "unreadable is not absent");
    assertEquals(f.hub.fileState(".globnotes/private.md"), null);
    assertEquals(f.hub.fileState("link/nested/hidden.md"), null);
    f.hub.record(token, [], "api");
    unlock();
    f.hub.scanNow(["locked"]);
    assertEquals(f.hub.fileState("locked/keep.md"), null);
  } finally {
    unlock();
    f.close();
  }
});
