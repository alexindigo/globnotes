// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  exportAcknowledged,
  exportVersion,
  readExportOwner,
  waitForDriverExport,
} from "../client/tests/e2e/driver-export-owner.mjs";
import { anonymousPath } from "../server/hub/paths.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { remotelySaveRemote } from "./helpers/remotely_save_remote.ts";

Deno.test("native export owner: matching remote bytes/sent version are not a host acknowledgement", async () => {
  const f = hubOperationsFixture();
  const content = "# current\n", version = exportVersion(content);
  Deno.writeTextFileSync(`${f.vault}/Live.md`, content);
  f.hub.scanNow();
  const key = anonymousPath(f.hub.store.secret, "Live.md"), db = f.hub.store.db;
  db.prepare(
    "INSERT INTO peer_files(peer,path_key,version,revision,state) VALUES(?,?,?,?,?)",
  ).run("home", key, version, "old-revision", "uncertain");
  db.prepare(
    "INSERT INTO peer_files(peer,path_key,version,revision,state) VALUES(?,?,?,?,?)",
  ).run("other", key, version, "other-revision", "synced");
  const entered = Promise.withResolvers<void>();
  let settled = false;
  try {
    const before = readExportOwner(f.config.statePath, "Live.md");
    assertEquals(before.version, version);
    assert(!exportAcknowledged(before, version));
    const waiting = waitForDriverExport(
      f.config.statePath,
      "Live.md",
      content,
      { onPending: () => entered.resolve() },
    ).then((result) => {
      settled = true;
      return result;
    });
    await entered.promise;
    assertEquals(settled, false);
    assert(!JSON.stringify(before).includes(f.hub.store.secret));
    db.prepare(
      "UPDATE peer_files SET state='synced',revision='acknowledged-revision' WHERE peer='home' AND path_key=?",
    ).run(key);
    const after = await waiting;
    assert(exportAcknowledged(after, version));
    assertEquals(after.revision, "acknowledged-revision");
    assert(!exportAcknowledged(after, exportVersion("different")));
    Deno.removeSync(`${f.vault}/Live.md`);
    f.hub.scanNow();
    assert(
      !exportAcknowledged(
        readExportOwner(f.config.statePath, "Live.md"),
        version,
      ),
    );
  } finally {
    f.close();
  }
});

Deno.test("Remotely Save peer: asynchronous request gate precedes the current object read", async () => {
  const peer = remotelySaveRemote("webdav"),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<undefined>();
  try {
    peer.set("Live.md", "before");
    peer.fault((request, key) => {
      if (request.method === "GET" && key === "Live.md") {
        entered.resolve();
        return release.promise;
      }
    });
    const request = fetch(`${peer.url}/dav/base/Live.md`);
    await entered.promise;
    peer.set("Live.md", "after");
    release.resolve(undefined);
    const response = await request;
    assertEquals(response.status, 200);
    assertEquals(await response.text(), "after");
    assertEquals(
      response.headers.get("etag"),
      peer.objects.get("Live.md")!.etag,
    );
  } finally {
    release.resolve(undefined);
    await peer.close();
  }
});
