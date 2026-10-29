// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import changes from "../server/api/endpoints/_/api/changes/get.ts";
import { state } from "../server/state.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";

function request(
  query = "",
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  const raw = new Request(`http://fixture/_/api/changes${query}`, {
    headers,
    signal,
  });
  return {
    _raw: raw,
    query: new URL(raw.url).searchParams,
  } as unknown as PathfinderRequest;
}
async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Missing change frame")),
          3000,
        );
      }),
    ]);
    return result.done ? "" : new TextDecoder().decode(result.value);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("hub changes: polling filters hidden/state paths and returns a resumable cursor", async () => {
  const f = hubOperationsFixture();
  try {
    Deno.mkdirSync(`${f.vault}/.hidden`);
    Deno.writeTextFileSync(`${f.vault}/.hidden/secret.md`, "secret");
    Deno.writeTextFileSync(`${f.vault}/public.md`, "visible");
    Deno.writeTextFileSync(`${f.vault}/image.png`, "image");
    Deno.writeTextFileSync(`${f.vault}/odd?.md`, "readable note");
    Deno.symlinkSync(f.config.statePath, `${f.vault}/state-alias`);
    f.hub.scanNow();
    const packet = await (await changes(request("?since=0&poll=1"))).json();
    assertEquals(
      new Set(packet.entries.map((e: { path: string }) => e.path)),
      new Set(["public.md", "image.png", "odd?.md"]),
    );
    assert(!JSON.stringify(packet).includes("secret"));
    assert(!JSON.stringify(packet).includes("pathKey"));
    assertEquals(
      await (await changes(request(`?since=${packet.next}&poll=1`))).json(),
      { entries: [], next: packet.next },
    );
    await assertRejects(() => changes(request("?since=-1&poll=1")));
  } finally {
    f.close();
  }
});

Deno.test("hub changes: SSE emits live deletion, resumes by Last-Event-ID and releases one subscription", async () => {
  const f = hubOperationsFixture();
  let subscriptions = 0;
  const subscribe = f.hub.subscribe.bind(f.hub);
  f.hub.subscribe = (fn) => {
    subscriptions++;
    const dispose = subscribe(fn);
    return () => {
      subscriptions--;
      dispose();
    };
  };
  try {
    const response = await changes(
      request("", { accept: "text/event-stream" }),
    );
    const reader = response.body!.getReader();
    assertEquals(subscriptions, 1);
    await f.operations.createNote({ path: "note", content: "first" }, f.api());
    const first = await readFrame(reader);
    assert(first.includes("event: change\n"));
    assert(first.includes('"path":"note.md"'));
    const seq = JSON.parse(/data: (.+)/.exec(first)![1]).seq;
    await f.operations.deleteNote("note", f.api());
    const deletion = await readFrame(reader);
    assert(deletion.includes('"kind":"deleted"'));
    assert(deletion.includes('"path":"note.md"'));
    await reader.cancel();
    assertEquals(subscriptions, 0);
    const resumed = await changes(
      request("", {
        accept: "text/event-stream",
        "Last-Event-ID": String(seq),
      }),
    );
    const replay = resumed.body!.getReader();
    assert((await readFrame(replay)).includes("event: reset"));
    await replay.cancel();
    assertEquals(subscriptions, 0);
    const poll = await (await changes(request(`?since=${seq}&poll=1`))).json();
    assertEquals(poll, { gap: true, next: f.hub.sequence() });
  } finally {
    f.close();
  }
});

Deno.test("hub changes: retained-log gaps reset SSE and polling; normal resume replays only later entries", async () => {
  const f = hubOperationsFixture();
  try {
    for (const path of ["one", "two", "three"]) {
      await f.operations.createNote({ path, content: path }, f.api());
    }
    const response = await changes(
      request("", { accept: "text/event-stream", "Last-Event-ID": "2" }),
    );
    const reader = response.body!.getReader();
    const frame = await readFrame(reader);
    assert(frame.startsWith("id: 3\n"));
    assert(frame.includes('"path":"three.md"'));
    await reader.cancel();
    f.hub.store.db.exec("DELETE FROM changes WHERE seq<3");
    assertEquals(await (await changes(request("?since=0&poll=1"))).json(), {
      gap: true,
      next: 3,
    });
    const reset = await changes(
      request("?since=0", { accept: "text/event-stream" }),
    );
    const resetReader = reset.body!.getReader();
    assertEquals(
      await readFrame(resetReader),
      'id: 3\nevent: reset\ndata: {"next":3}\n\n',
    );
    await resetReader.cancel();
  } finally {
    f.close();
  }
});

Deno.test("hub changes: read authorization is required and revoked streams disclose no later entries", async () => {
  const f = hubOperationsFixture();
  try {
    state.auth = {
      validateTokenMetadata: () => Promise.reject(new Error("denied")),
    } as unknown as typeof state.auth;
    await assertRejects(() => changes(request("?poll=1")));
    state.auth = null;
    const abort = new AbortController();
    const response = await changes(
      request("", { accept: "text/event-stream" }, abort.signal),
    );
    const reader = response.body!.getReader();
    state.auth = {
      validateTokenMetadata: () => Promise.reject(new Error("revoked")),
    } as unknown as typeof state.auth;
    Deno.writeTextFileSync(`${f.vault}/later.md`, "never disclosed");
    f.hub.scanNow();
    assertEquals(await reader.read(), { value: undefined, done: true });
    abort.abort();
  } finally {
    f.close();
  }
});
