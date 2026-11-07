// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { testEnvironment } from "./helpers/environment.ts";

Deno.test("index initialization: an existing WAL index opens while another connection holds a write lock", () => {
  const dir = Deno.makeTempDirSync({ prefix: "globnotes-index-lock-" });
  const opened: DatabaseSync[] = [];
  const adapters = {
    openDatabase(filename: string) {
      const db = new DatabaseSync(filename);
      opened.push(db);
      return db;
    },
  };
  try {
    new Fts5Indexer(dir, testEnvironment({}), adapters);
    const writer = new DatabaseSync(`${dir}/index.sqlite`);
    opened.push(writer);
    writer.exec("BEGIN IMMEDIATE");
    try {
      // No schema migration is needed. A capability probe must not introduce
      // an unrelated main-database write (or mislabel its SQLITE_BUSY error).
      const reader = new Fts5Indexer(dir, testEnvironment({}), adapters);
      assertEquals(reader.search("needle"), []);
    } finally {
      writer.exec("ROLLBACK");
    }
  } finally {
    for (const db of opened) {
      try {
        db.close();
      } catch { /* failed constructor may already close */ }
    }
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("index initialization: only a missing fts5 module is diagnosed as unavailable", async (t) => {
  for (
    const message of [
      "no such module: fts5",
      "database is locked",
      "disk I/O error",
    ]
  ) {
    await t.step(message, () => {
      const dir = Deno.makeTempDirSync({ prefix: "globnotes-index-error-" });
      let db: DatabaseSync | undefined;
      const cause = new Error(message);
      try {
        const error = assertThrows(() =>
          new Fts5Indexer(dir, testEnvironment({}), {
            openDatabase(filename: string) {
              db = new DatabaseSync(filename);
              const exec = db.exec.bind(db);
              db.exec = (sql: string) => {
                if (
                  sql.includes("CREATE VIRTUAL TABLE") &&
                  sql.includes("notes_fts")
                ) throw cause;
                return exec(sql);
              };
              return db;
            },
          })
        );
        assert(error instanceof Error);
        if (message.startsWith("no such module")) {
          assert(error.message.includes("FTS5 is unavailable"), error.message);
          assertEquals(error.cause, cause);
        } else {
          assertEquals(
            error,
            cause,
            "operational SQLite errors preserve their identity and diagnosis",
          );
          assert(!error.message.includes("unavailable"));
        }
      } finally {
        try {
          db?.close();
        } catch { /* failed constructor may already close */ }
        Deno.removeSync(dir, { recursive: true });
      }
    });
  }
});
