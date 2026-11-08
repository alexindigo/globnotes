// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { GlobalConfig } from "../server/config.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { initState, state } from "../server/state.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { awaitIndexReady, restoreState } from "./helpers/state.ts";
import { subscribeIndex } from "../server/hub/subscribers.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { command, DENO } from "./helpers/process.ts";

function fixture() {
  const previous = { ...state },
    root = Deno.makeTempDirSync({ prefix: "index-erasure-" });
  const vault = `${root}/vault`, storage = `${root}/state`;
  Deno.mkdirSync(vault);
  Deno.mkdirSync(storage);
  const env = testEnvironment({
    GLOBNOTES_PATH: vault,
    GLOBNOTES_INDEX_PATH: storage,
    GLOBNOTES_AUTH_TYPE: "none",
    GLOBNOTES_INDEX_BATCH_DELAY: "0",
    GLOBNOTES_INDEX_BATCH_SIZE: "2",
  });
  const opened: DatabaseSync[] = [];
  const make = (failRead?: string, beforeOpen?: (filename: string) => void) => {
    const index = new Fts5Indexer(storage, env, {
      openDatabase(filename) {
        beforeOpen?.(filename);
        const db = new DatabaseSync(filename);
        opened.push(db);
        return db;
      },
      readText(filename) {
        if (filename.endsWith(`/${failRead}`)) {
          throw new Deno.errors.PermissionDenied(
            "injected rebuild acquisition failure",
          );
        }
        return Deno.readTextFileSync(filename);
      },
    });
    initState(
      new GlobalConfig(env),
      null,
      new FileSystemNotes(vault, {}, env),
      index,
      new FileServing(vault),
      null,
    );
    return index;
  };
  const closeDatabases = () => {
    for (const db of opened.splice(0)) {
      try {
        db.close();
      } catch { /* owner may have closed during publication */ }
    }
  };
  return {
    root,
    vault,
    storage,
    make,
    closeDatabases,
    close() {
      closeDatabases();
      restoreState(previous);
      Deno.removeSync(root, { recursive: true });
    },
  };
}

function absentFromIndexFiles(storage: string, markers: string[]) {
  for (const entry of Deno.readDirSync(storage)) {
    if (!entry.name.includes("sqlite")) continue;
    const text = new TextDecoder().decode(
      Deno.readFileSync(`${storage}/${entry.name}`),
    );
    for (const marker of markers) {
      assert(!text.includes(marker), `${marker} retained in ${entry.name}`);
    }
  }
}

function legacyIndex(storage: string) {
  const db = new DatabaseSync(`${storage}/index.sqlite`);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=OFF;
    CREATE VIRTUAL TABLE notes_fts USING fts5(title,content,tags,filename UNINDEXED,last_modified UNINDEXED,tokenize='porter unicode61 remove_diacritics 2');
    CREATE TABLE notes_tags(filename TEXT NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(filename,tag));
    CREATE TABLE notes_meta(filename TEXT PRIMARY KEY,display_title TEXT NOT NULL,h1 TEXT,aliases TEXT NOT NULL DEFAULT '[]');
    PRAGMA user_version=10;`);
  db.prepare(
    "INSERT INTO notes_fts(title,content,tags,filename,last_modified) VALUES(?,?,?,?,?)",
  ).run(
    "legacydeletednamecanary",
    "legacydeletedbodycanary",
    "",
    "legacydeletednamecanary.md",
    1,
  );
  db.exec("DELETE FROM notes_fts");
  db.prepare(
    "INSERT INTO notes_fts(title,content,tags,filename,last_modified) VALUES(?,?,?,?,?)",
  ).run("live", "stale index content", "", "live.md", 1);
  db.close();
}

Deno.test("index erasure: replaced and deleted names/content leave no SQLite or WAL traces before and after reopen", () => {
  const f = fixture();
  try {
    const index = f.make();
    const filename = "deleteduniquenamecanary",
      old = "olduniquebodycanary",
      current = "currentuniquebodycanary";
    Deno.writeTextFileSync(`${f.vault}/${filename}.md`, old);
    index.reindexNote(filename);
    assertEquals(index.search(old).length, 1);
    Deno.writeTextFileSync(`${f.vault}/${filename}.md`, current);
    index.reindexNote(filename);
    assertEquals(index.search(old), []);
    absentFromIndexFiles(f.storage, [old]);
    Deno.removeSync(`${f.vault}/${filename}.md`);
    index.deleteFromIndex(filename);
    assertEquals(index.search(current), []);
    absentFromIndexFiles(f.storage, [filename, old, current]);
    f.closeDatabases();
    f.make();
    absentFromIndexFiles(f.storage, [filename, old, current]);
  } finally {
    f.close();
  }
});

Deno.test("index erasure: old-format upgrade preserves old usable index until complete new index replaces it, removing legacy traces", async () => {
  const f = fixture();
  try {
    legacyIndex(f.storage);
    Deno.writeTextFileSync(`${f.vault}/live.md`, "current vault content");
    Deno.writeTextFileSync(`${f.vault}/second.md`, "second current document");
    const index = f.make();
    const before = new DatabaseSync(`${f.storage}/index.sqlite`, {
      readOnly: true,
    });
    assertEquals(before.prepare("PRAGMA user_version").get()!.user_version, 10);
    assertEquals(
      before.prepare("SELECT content FROM notes_fts").get()!.content,
      "stale index content",
    );
    before.close();
    index.startBackgroundSync();
    await awaitIndexReady(index);
    const after = new DatabaseSync(`${f.storage}/index.sqlite`, {
      readOnly: true,
    });
    assertEquals(after.prepare("PRAGMA user_version").get()!.user_version, 11);
    assertEquals(
      after.prepare("SELECT count(*) AS n FROM notes_fts").get()!.n,
      2,
    );
    after.close();
    assertEquals(index.search("current").length, 2);
    absentFromIndexFiles(f.storage, [
      "legacydeletednamecanary",
      "legacydeletedbodycanary",
      "stale index content",
    ]);
    assertEquals(
      [...Deno.readDirSync(f.storage)].filter((entry) =>
        entry.name.includes("rebuild")
      ),
      [],
    );
    f.closeDatabases();
    const reopened = f.make();
    assertEquals(reopened.search("current").length, 2);
    absentFromIndexFiles(f.storage, [
      "legacydeletednamecanary",
      "legacydeletedbodycanary",
    ]);
  } finally {
    f.close();
  }
});

Deno.test("index erasure: failed rebuild never publishes a partial new index and retry rebuilds from the vault", async () => {
  const f = fixture();
  try {
    legacyIndex(f.storage);
    Deno.writeTextFileSync(`${f.vault}/live.md`, "current vault content");
    Deno.writeTextFileSync(
      `${f.vault}/unreadable.md`,
      "must not omit this document",
    );
    const failed = f.make("unreadable.md");
    failed.startBackgroundSync();
    await awaitIndexReady(failed);
    assertEquals(failed.indexStatus.failed, 1);
    const old = new DatabaseSync(`${f.storage}/index.sqlite`, {
      readOnly: true,
    });
    assertEquals(old.prepare("PRAGMA user_version").get()!.user_version, 10);
    assertEquals(
      old.prepare("SELECT content FROM notes_fts").get()!.content,
      "stale index content",
    );
    old.close();
    f.closeDatabases();
    const retry = f.make();
    retry.startBackgroundSync();
    await awaitIndexReady(retry);
    assertEquals(retry.indexStatus.failed, 0);
    assertEquals(retry.search("*").length, 2);
    absentFromIndexFiles(f.storage, [
      "legacydeletednamecanary",
      "legacydeletedbodycanary",
    ]);
  } finally {
    f.close();
  }
});

Deno.test("index erasure: the actual hub projection batches rename-away and deleted-note erasure into one checkpoint", () => {
  const f = hubOperationsFixture();
  let db!: DatabaseSync, checkpoints = 0;
  const index = new Fts5Indexer(f.config.statePath, testEnvironment({}), {
    openDatabase(filename) {
      db = new DatabaseSync(filename);
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (sql === "PRAGMA wal_checkpoint(TRUNCATE)") checkpoints++;
        return prepare(sql);
      }) as typeof db.prepare;
      return db;
    },
  });
  subscribeIndex(f.hub, index);
  try {
    Deno.writeTextFileSync(
      `${f.vault}/renameduniquenamecanary.md`,
      "live survivor body",
    );
    Deno.writeTextFileSync(
      `${f.vault}/firstdeletedcanary.md`,
      "firstdeletedbodycanary",
    );
    Deno.writeTextFileSync(
      `${f.vault}/seconddeletedcanary.md`,
      "seconddeletedbodycanary",
    );
    f.hub.scanNow();
    assertEquals(index.search("*").length, 3);
    Deno.renameSync(
      `${f.vault}/renameduniquenamecanary.md`,
      `${f.vault}/survivor.md`,
    );
    Deno.removeSync(`${f.vault}/firstdeletedcanary.md`);
    Deno.removeSync(`${f.vault}/seconddeletedcanary.md`);
    const before = checkpoints;
    f.hub.scanNow();
    assertEquals(checkpoints - before, 1);
    assertEquals(index.search("*").map((row) => row.path), ["survivor"]);
    for (const entry of Deno.readDirSync(f.config.statePath)) {
      if (!entry.name.startsWith("index.sqlite")) continue;
      const bytes = new TextDecoder().decode(
        Deno.readFileSync(`${f.config.statePath}/${entry.name}`),
      );
      for (
        const marker of [
          "renameduniquenamecanary",
          "firstdeletedcanary",
          "seconddeletedcanary",
          "firstdeletedbodycanary",
          "seconddeletedbodycanary",
        ]
      ) assert(!bytes.includes(marker), `${marker} in ${entry.name}`);
    }
  } finally {
    db.close();
    f.close();
  }
});

for (const boundary of ["before-swap", "after-swap"]) {
  Deno.test(`index erasure: publication failure ${boundary} leaves a complete readable old or new canonical file`, async () => {
    const f = fixture();
    try {
      legacyIndex(f.storage);
      Deno.writeTextFileSync(`${f.vault}/live.md`, "current vault content");
      Deno.writeTextFileSync(`${f.vault}/second.md`, "second current document");
      let canonicalOpens = 0;
      const injected = boundary === "before-swap" ? 2 : 3;
      const index = f.make(undefined, (filename) => {
        if (
          filename === `${f.storage}/index.sqlite` &&
          ++canonicalOpens === injected
        ) throw new Error(`injected ${boundary} open failure`);
      });
      index.startBackgroundSync();
      await awaitIndexReady(index);
      const db = new DatabaseSync(`${f.storage}/index.sqlite`, {
        readOnly: true,
      });
      assertEquals(
        db.prepare("PRAGMA user_version").get()!.user_version,
        boundary === "before-swap" ? 10 : 11,
      );
      assertEquals(
        db.prepare("SELECT count(*) AS n FROM notes_fts").get()!.n,
        boundary === "before-swap" ? 1 : 2,
      );
      db.close();
      assertEquals(index.search("current").length, 2);
      f.closeDatabases();
      const retry = f.make();
      retry.startBackgroundSync();
      await awaitIndexReady(retry);
      assertEquals(retry.search("current").length, 2);
      absentFromIndexFiles(f.storage, [
        "legacydeletednamecanary",
        "legacydeletedbodycanary",
      ]);
    } finally {
      f.close();
    }
  });
}

Deno.test("index erasure: fresh installs and current-format restarts never create a rebuild file", async () => {
  const f = fixture(), paths: string[] = [];
  try {
    const fresh = f.make(undefined, (filename) => paths.push(filename));
    Deno.writeTextFileSync(`${f.vault}/fresh.md`, "fresh searchable document");
    fresh.startBackgroundSync();
    await awaitIndexReady(fresh);
    f.closeDatabases();
    const restarted = f.make(undefined, (filename) => paths.push(filename));
    assertEquals(restarted.search("searchable").length, 1);
    assertEquals(paths, [
      `${f.storage}/index.sqlite`,
      `${f.storage}/index.sqlite`,
    ]);
  } finally {
    f.close();
  }
});

Deno.test("index erasure: a lost index deletion transaction is recovered from the folder and physically erased after restart", async () => {
  const f = fixture();
  try {
    const name = "lostdeletenamecanary", body = "lostdeletebodycanary";
    Deno.writeTextFileSync(`${f.vault}/${name}.md`, body);
    const index = f.make();
    index.reindexNote(name);
    assertEquals(index.search(body).map((row) => row.path), [name]);
    // Restore an exact pre-delete file set after closing the old connection:
    // the folder delete survives while the derived index transaction is lost.
    const snapshot = new Map(
      [...Deno.readDirSync(f.storage)].filter((entry) =>
        entry.name.startsWith("index.sqlite")
      ).map((
        entry,
      ) => [entry.name, Deno.readFileSync(`${f.storage}/${entry.name}`)]),
    );
    Deno.removeSync(`${f.vault}/${name}.md`);
    index.deleteFromIndex(name);
    absentFromIndexFiles(f.storage, [name, body]);
    f.closeDatabases();
    for (const entry of Deno.readDirSync(f.storage)) {
      if (entry.name.startsWith("index.sqlite")) {
        Deno.removeSync(`${f.storage}/${entry.name}`);
      }
    }
    for (const [filename, bytes] of snapshot) {
      Deno.writeFileSync(`${f.storage}/${filename}`, bytes);
    }
    const restarted = f.make();
    assertEquals(
      restarted.search(body).map((row) => row.path),
      [name],
      "the fixture must actually restore the stale index transaction",
    );
    restarted.startBackgroundSync();
    await awaitIndexReady(restarted);
    assertEquals(restarted.search(body), []);
    absentFromIndexFiles(f.storage, [name, body]);
    f.closeDatabases();
    const again = f.make();
    assertEquals(again.search(body), []);
    absentFromIndexFiles(f.storage, [name, body]);
  } finally {
    f.close();
  }
});

Deno.test("index erasure: a pinned WAL reader makes erasure fail explicitly after the delete commits, then recovery scrubs the files", () => {
  const f = fixture();
  let reader: DatabaseSync | undefined;
  try {
    const index = f.make(),
      name = "pinnedreadernamecanary",
      body = "pinnedreaderbodycanary";
    Deno.writeTextFileSync(`${f.vault}/${name}.md`, body);
    index.reindexNote(name);
    reader = new DatabaseSync(`${f.storage}/index.sqlite`, { readOnly: true });
    reader.exec("BEGIN");
    assertEquals(
      reader.prepare("SELECT filename FROM notes_fts").get()!.filename,
      name + ".md",
    );
    Deno.removeSync(`${f.vault}/${name}.md`);
    assertThrows(
      () => index.deleteFromIndex(name),
      Error,
      "Search index erasure checkpoint did not complete",
    );
    assertEquals(
      index.search(body),
      [],
      "the error must not pretend the committed deletion rolled back",
    );
    reader.exec("ROLLBACK");
    reader.close();
    reader = undefined;
    index.batch(() => {});
    absentFromIndexFiles(f.storage, [name, body]);
  } finally {
    reader?.close();
    f.close();
  }
});

for (const boundary of ["during-stage", "before-swap", "after-swap"]) {
  Deno.test(`index erasure: actual child interruption ${boundary} preserves a complete canonical index and restart converges`, async () => {
    const f = fixture();
    try {
      legacyIndex(f.storage);
      Deno.writeTextFileSync(`${f.vault}/live.md`, "current vault content");
      Deno.writeTextFileSync(`${f.vault}/second.md`, "second current document");
      const result = await command(DENO, {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          new URL("helpers/index_rebuild_child.ts", import.meta.url).pathname,
          f.vault,
          f.storage,
          boundary,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 79, new TextDecoder().decode(result.stderr));
      const db = new DatabaseSync(`${f.storage}/index.sqlite`, {
        readOnly: true,
      });
      assertEquals(
        db.prepare("PRAGMA user_version").get()!.user_version,
        boundary === "after-swap" ? 11 : 10,
      );
      assertEquals(
        db.prepare("SELECT count(*) AS n FROM notes_fts").get()!.n,
        boundary === "after-swap" ? 2 : 1,
      );
      db.close();
      const restarted = f.make();
      restarted.startBackgroundSync();
      await awaitIndexReady(restarted);
      assertEquals(restarted.search("current").length, 2);
      absentFromIndexFiles(f.storage, [
        "legacydeletednamecanary",
        "legacydeletedbodycanary",
      ]);
    } finally {
      f.close();
    }
  });
}
