// SPDX-License-Identifier: LGPL-3.0-only
// A deliberate process exit leaves SQLite's actual crash/recovery files intact.
import { DatabaseSync } from "node:sqlite";
import { GlobalConfig } from "../../server/config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import { Fts5Indexer } from "../../server/search/fts5.ts";
import { initState } from "../../server/state.ts";
import { testEnvironment } from "./environment.ts";

const [vault, storage, boundary] = Deno.args;
const env = testEnvironment({
  GLOBNOTES_PATH: vault,
  GLOBNOTES_INDEX_PATH: storage,
  GLOBNOTES_AUTH_TYPE: "none",
  GLOBNOTES_INDEX_BATCH_DELAY: "0",
});
let canonicalOpens = 0;
const index = new Fts5Indexer(storage, env, {
  openDatabase(filename) {
    if (filename === `${storage}/index.sqlite`) {
      canonicalOpens++;
      if (
        boundary === "before-swap" && canonicalOpens === 2 ||
        boundary === "after-swap" && canonicalOpens === 3
      ) Deno.exit(79);
    }
    return new DatabaseSync(filename);
  },
  readText(filename) {
    if (boundary === "during-stage" && filename.endsWith("/second.md")) {
      Deno.exit(79);
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
index.startBackgroundSync();
Deno.exit(78); // A missed crash boundary must fail the parent's expectation.
