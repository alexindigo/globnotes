import { testMetadata, testServices } from "./environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only
// A deliberate process exit leaves SQLite's actual crash/recovery files intact.
import { DatabaseSync } from "node:sqlite";
import { GlobalConfig } from "./config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import { Fts5Indexer } from "../../server/search/fts5.ts";
import { initState } from "../../server/state.ts";
import { testEnvironment } from "./environment.ts";

const [vault, storage, boundary] = Deno.args;
const env = testEnvironment({
  GLOBNOTES_GLOBNOTES_PATH: vault,
  fixtureStatePath: storage,
  fixtureAuth: { auth_type: "none" },
  GLOBNOTES__INDEX_BATCHDELAY: "0",
});
let canonicalOpens = 0;
const index = new Fts5Indexer(testMetadata(storage), testServices(env).index, {
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
  new FileSystemNotes(vault, {}, testServices(env).notes),
  index,
  new FileServing(vault),
  null,
);
if (boundary === "pending-erasure") {
  const name = "pendingerasurenamecanary", body = "pendingerasurebodycanary";
  index.reindexNote(name);
  const reader = new DatabaseSync(`${storage}/index.sqlite`, {
    readOnly: true,
  });
  reader.exec("BEGIN");
  if (
    reader.prepare("SELECT filename FROM notes_fts").get()?.filename !==
      `${name}.md`
  ) Deno.exit(78);
  Deno.removeSync(`${vault}/${name}.md`);
  let rejected = false;
  try {
    index.deleteFromIndex(name);
  } catch (error) {
    rejected = error instanceof Error &&
      error.message === "Search index erasure checkpoint did not complete";
  }
  if (!rejected || index.search(body).length !== 0) Deno.exit(78);
  // Exit with BOTH connections open: a committed delete is not an erased WAL.
  Deno.exit(79);
}
index.startBackgroundSync();
Deno.exit(78); // A missed crash boundary must fail the parent's expectation.
