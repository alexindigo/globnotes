// SPDX-License-Identifier: LGPL-3.0-only

/** The hub write gate (docs/hub.md "Write gate"): vault effects need a gate
 * pass, the gate records them with their origin, staging stays out of the
 * log, and bases resolve per content type. */

import { assert, assertEquals, assertThrows } from "@std/assert";
import * as path from "@std/path";
import {
  isStagingName,
  STAGING_PREFIX,
  UngatedVaultWrite,
  VaultEffects,
} from "../server/hub/effects.ts";
import {
  checkBase,
  conflictCopyPath,
  HubGate,
  occupied,
  parseBase,
} from "../server/hub/gate.ts";
import { VaultHub } from "../server/hub/hub.ts";
import { versionOf } from "../server/hub/merge.ts";
import { decodeNote, FileSystemNotes } from "../server/notes/file_system.ts";
import { auxiliaryFixture } from "./helpers/auxiliary_fixture.ts";
import { testEnvironment } from "./helpers/environment.ts";

function vaultWithHub() {
  const root = Deno.makeTempDirSync();
  const vault = `${root}/vault`, statePath = `${root}/state`;
  Deno.mkdirSync(vault);
  const hub = new VaultHub(vault, statePath, testEnvironment({}));
  hub.scanNow();
  return {
    root,
    vault,
    hub,
    gate: new HubGate({ hub }),
    effects: new VaultEffects(vault),
    close() {
      hub.stop();
      Deno.removeSync(root, { recursive: true });
    },
  };
}

Deno.test("hub gate: a vault effect without a pass is refused before it happens", () => {
  const v = vaultWithHub();
  try {
    assertThrows(
      () => v.effects.writeNew(`${v.vault}/a.md`, "x"),
      UngatedVaultWrite,
    );
    assertThrows(() => v.effects.mkdir(`${v.vault}/dir`), UngatedVaultWrite);
    assertEquals(occupied(`${v.vault}/a.md`), false);
    assertEquals(occupied(`${v.vault}/dir`), false);
    // A pass covers only its paths (and directories on their route).
    assertThrows(
      () =>
        v.gate.apply(
          [`${v.vault}/a.md`],
          "test",
          [],
          () => v.effects.writeNew(`${v.vault}/b.md`, "x"),
        ),
      UngatedVaultWrite,
    );
    assertEquals(occupied(`${v.vault}/b.md`), false);
    v.gate.apply([`${v.vault}/deep/a.md`], "test", [], () => {
      v.effects.mkdirParents(`${v.vault}/deep/a.md`);
      v.effects.writeNew(`${v.vault}/deep/a.md`, "x");
    });
    assertEquals(Deno.readTextFileSync(`${v.vault}/deep/a.md`), "x");
    // The pass ends with the synchronous effect.
    assertThrows(
      () => v.effects.replace(`${v.vault}/deep/a.md`, "y"),
      UngatedVaultWrite,
    );
    assertThrows(
      () =>
        v.gate.apply(
          [`${v.vault}/deep/a.md`],
          "test",
          [],
          () => Promise.resolve(),
        ),
      Error,
      "synchronous",
    );
    // Targets outside the vault (granted external roots) need no pass.
    v.effects.writeNew(`${v.root}/outside.bin`, new Uint8Array([1]));
    assertEquals(Deno.readFileSync(`${v.root}/outside.bin`).length, 1);
  } finally {
    v.close();
  }
});

Deno.test("hub gate: effects are recorded with their origin; staging never enters the log", async () => {
  const v = vaultWithHub();
  try {
    const before = v.hub.sequence();
    const staged = await v.effects.stage(v.vault);
    assert(isStagingName(staged.path));
    assert(path.basename(staged.path).startsWith(STAGING_PREFIX));
    await staged.file.write(new TextEncoder().encode("bytes"));
    staged.file.close();
    v.hub.scanNow();
    assertEquals(v.hub.sequence(), before, "staging is not vault content");
    v.gate.apply(
      [`${v.vault}/file.bin`],
      "plugin:x",
      [],
      () => v.effects.publish(staged.path, `${v.vault}/file.bin`),
    );
    const entries = v.hub.changesSince(before).entries!;
    assertEquals(
      entries.map((e) => [e.path, e.kind, e.peer, e.origin]),
      [["file.bin", "created", "globnotes", "plugin:x"]],
    );
    assertEquals(
      v.hub.fileState("file.bin")!.hash,
      versionOf(Deno.readFileSync(`${v.vault}/file.bin`)),
    );
  } finally {
    v.close();
  }
});

Deno.test("hub gate: bases resolve per content type", () => {
  const text = (content: string) => ({
    version: versionOf(new TextEncoder().encode(content)),
    text: content,
  });
  const v1 = versionOf(new TextEncoder().encode("a\nb\nc\n"));
  assertEquals(checkBase({ kind: "absent" }, null), { status: "current" });
  assertEquals(checkBase({ kind: "absent" }, text("x")), {
    status: "stale",
    currentVersion: text("x").version,
  });
  assertEquals(
    checkBase({ kind: "version", version: v1 }, text("a\nb\nc\n")),
    { status: "current" },
  );
  assertEquals(checkBase({ kind: "version", version: v1 }, null), {
    status: "stale",
    currentVersion: null,
  });
  // Text bases merge for notes.
  assertEquals(
    checkBase(
      { kind: "text", content: "a\nb\nc\n" },
      text("a\nb\nC\n"),
      "A\nb\nc\n",
    ),
    { status: "merged", content: "A\nb\nC\n" },
  );
  assertEquals(
    checkBase({ kind: "text", content: "a\n" }, text("theirs\n"), "mine\n")
      .status,
    "stale",
  );
  // A binary file has no text: a text base compares as bytes, never merges.
  const binary = { version: versionOf(new Uint8Array([1, 2])) };
  assertEquals(
    checkBase({ kind: "text", content: "x" }, binary, "y").status,
    "stale",
  );
  assertEquals(parseBase({ kind: "version", version: v1.toUpperCase() }), {
    kind: "version",
    version: v1,
  });
  for (
    const bad of [null, {}, { kind: "version", version: "abc" }, {
      kind: "absent",
      extra: 1,
    }, { kind: "text" }]
  ) assertThrows(() => parseBase(bad), TypeError);
});

Deno.test("hub gate: conflict copies keep any extension and never reuse a name", () => {
  const taken = new Set<string>();
  const now = new Date("2026-11-05T07:15:00Z");
  const name = (file: string) =>
    conflictCopyPath(file, "globnotes", now, (c) => taken.has(c));
  assertEquals(
    name("dir/photo.png"),
    "dir/photo.conflict-20261105-071500-globnotes.png",
  );
  assertEquals(name("Makefile"), "Makefile.conflict-20261105-071500-globnotes");
  assertEquals(
    name("a.tar.gz"),
    "a.tar.conflict-20261105-071500-globnotes.gz",
  );
  taken.add("note.conflict-20261105-071500-globnotes.md");
  assertEquals(name("note.md"), "note.conflict-20261105-071500-globnotes-2.md");
});

Deno.test("hub gate: a note's version is its raw-byte hash, equal to the hub's", () => {
  const v = vaultWithHub();
  try {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]);
    const invalid = new Uint8Array([0x61, 0xff, 0xfe, 0x62, 0xc3]);
    Deno.writeFileSync(`${v.vault}/bom.md`, bom);
    Deno.writeFileSync(`${v.vault}/bad.md`, invalid);
    v.hub.scanNow();
    const notes = new FileSystemNotes(v.vault, {}, testEnvironment({}));
    for (const [name, bytes] of [["bom", bom], ["bad", invalid]] as const) {
      const note = notes.get(name);
      assertEquals(
        note.content,
        Deno.readTextFileSync(`${v.vault}/${name}.md`),
        "decoded as before",
      );
      assertEquals(decodeNote(bytes), note.content);
      assertEquals(note.version, versionOf(bytes));
      assertEquals(note.version, v.hub.fileState(`${name}.md`)!.hash);
    }
  } finally {
    v.close();
  }
});

Deno.test("hub gate: plugin filesystem effects in the vault are recorded as the plugin's", async () => {
  const b = await auxiliaryFixture({ hub: true });
  try {
    b.hub!.scanNow();
    const before = b.hub!.sequence();
    const written = await b.call(
      "writeFile",
      "data.bin",
      new Uint8Array([1, 2, 3]),
      { expect: { kind: "absent" } },
    );
    assertEquals(written.error, undefined);
    await b.call("mkdir", "folder", { expect: { kind: "absent" } });
    const entries = b.hub!.changesSince(before).entries!;
    assertEquals(
      entries.map((e) => [e.path, e.kind, e.peer, e.origin]),
      [["data.bin", "created", "globnotes", "plugin:auxiliary"]],
    );
    assertEquals(
      [...Deno.readDirSync(b.vault)].filter((e) => isStagingName(e.name)),
      [],
    );
  } finally {
    await b.close();
  }
});
