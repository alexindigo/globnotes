// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { withRequestBodyLifetime } from "../server/http_request.ts";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { fixtureGate } from "./helpers/fixture_coordination.ts";
import { bounded } from "./helpers/worker_liveness.ts";

for (const status of [400, 404, 413, 421]) {
  Deno.test(`HTTP body lifetime: early ${status} refusal reads zero bytes and preserves the exact response`, async () => {
    const events: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      pull() {
        events.push("read");
      },
      cancel() {
        events.push("cancel");
      },
    }, { highWaterMark: 0 });
    const expected = Response.json({ detail: "refused" }, { status });
    const response = await withRequestBodyLifetime((_request, info: string) => {
      assertEquals(info, "peer");
      return expected;
    })(
      new Request("http://globnotes.test/prefix", { method: "POST", body }),
      "peer",
    );
    assertStrictEquals(response, expected);
    assertEquals([events, body.locked, await response.json()], [
      ["cancel"],
      false,
      { detail: "refused" },
    ]);
  });
}

Deno.test("HTTP body lifetime: abandoned SDK clones cannot retain cancellation of the original upload", async () => {
  const events: string[] = [];
  const body = new ReadableStream<Uint8Array>({
    pull() {
      events.push("read");
    },
    cancel() {
      events.push("cancel");
    },
  }, { highWaterMark: 0 });
  const expected = new Response(null, { status: 413 });
  const response = await bounded(
    withRequestBodyLifetime((request) => {
      request.clone();
      request.clone();
      return expected;
    })(
      new Request("http://globnotes.test/", { method: "POST", body }),
      undefined,
    ),
    "original upload cancellation",
  );
  assertStrictEquals(response, expected);
  assertEquals([events, body.locked], [["read", "cancel"], false]);
});

Deno.test("HTTP body lifetime: full consumption and prefix forwarding retain bytes, headers, signal and peer", async () => {
  const events: string[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("payload"));
      controller.close();
    },
    cancel() {
      events.push("cancel");
    },
  });
  const abort = new AbortController();
  const original = new Request(
    "http://globnotes.test/prefix/target?query=kept",
    {
      method: "POST",
      headers: { "x-input": "kept" },
      signal: abort.signal,
      body,
    },
  );
  const response = await withRequestBodyLifetime(
    async (request, peer: object) => {
      assertStrictEquals(peer, abort);
      const target = new Request(
        "http://globnotes.test/target?query=kept",
        request,
      );
      const text = await target.text();
      abort.abort("after read");
      assertEquals([
        target.url,
        target.method,
        target.headers.get("x-input"),
        target.signal.aborted,
        target.signal.reason,
        text,
      ], [
        "http://globnotes.test/target?query=kept",
        "POST",
        "kept",
        true,
        "after read",
        "payload",
      ]);
      return new Response(text);
    },
  )(original, abort);
  assertEquals([await response.text(), events, body.locked], [
    "payload",
    [],
    false,
  ]);
});

Deno.test("HTTP body lifetime: bodyless requests pass through by identity", async () => {
  const request = new Request("http://globnotes.test/");
  const expected = new Response(null, { status: 204 });
  const response = await withRequestBodyLifetime((actual) => {
    assertStrictEquals(actual, request);
    return expected;
  })(request, undefined);
  assertStrictEquals(response, expected);
});

Deno.test("HTTP body lifetime: a partial consumer is cancelled once and its lock is released", async () => {
  const events: string[] = [];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      events.push("read");
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      events.push("cancel");
    },
  }, { highWaterMark: 0 });
  const response = await withRequestBodyLifetime(async (request) => {
    const reader = request.body!.getReader();
    assertEquals(await reader.read(), {
      done: false,
      value: new Uint8Array([1]),
    });
    await reader.cancel("consumer finished");
    reader.releaseLock();
    return new Response(null, { status: 204 });
  })(
    new Request("http://globnotes.test/", { method: "POST", body }),
    undefined,
  );
  assertEquals([response.status, events, body.locked], [
    204,
    ["read", "cancel"],
    false,
  ]);
});

Deno.test("HTTP body lifetime: rejected best-effort cancellation cannot replace the route failure", async () => {
  const failure = new Error("route failed"),
    cleanup = new Error("cancel failed");
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      throw cleanup;
    },
  }, { highWaterMark: 0 });
  const error = await assertRejects(
    () =>
      withRequestBodyLifetime(() => {
        throw failure;
      })(
        new Request("http://globnotes.test/", { method: "POST", body }),
        undefined,
      ),
    Error,
    "route failed",
  );
  assertStrictEquals(error, failure);
  assertEquals(body.locked, false);
});

Deno.test("HTTP body lifetime: rejected cancellation cannot replace a successful route response", async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
      return Promise.reject(new Error("cancel failed"));
    },
  }, { highWaterMark: 0 });
  const expected = Response.json({ error: "too large" }, { status: 413 });
  const response = await withRequestBodyLifetime(() => expected)(
    new Request("http://globnotes.test/", { method: "POST", body }),
    undefined,
  );
  assertStrictEquals(response, expected);
  assertEquals([cancelled, body.locked, await response.json()], [
    1,
    false,
    { error: "too large" },
  ]);
});

Deno.test("HTTP body lifetime: a handler rejection without cleanup failure stays the same error", async () => {
  const failure = new Error("route failed");
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  }, { highWaterMark: 0 });
  assertStrictEquals(
    await assertRejects(
      () =>
        withRequestBodyLifetime(() => {
          throw failure;
        })(
          new Request("http://globnotes.test/", { method: "POST", body }),
          undefined,
        ),
      Error,
      "route failed",
    ),
    failure,
  );
  assertEquals([cancelled, body.locked], [1, false]);
});

Deno.test("HTTP body lifetime: uncooperative cancellation cannot retain the routing result or source lock", () =>
  fixtureScope(async (scope) => {
    const release = fixtureGate(scope);
    const events: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        events.push("cancel");
        return release.promise;
      },
    }, { highWaterMark: 0 });
    try {
      const response = await bounded(
        withRequestBodyLifetime(() => new Response("denied", { status: 403 }))(
          new Request("http://globnotes.test/", { method: "POST", body }),
          undefined,
        ),
        "uncooperative upload cancellation",
      );
      assertEquals([
        response.status,
        await response.text(),
        events,
        body.locked,
      ], [403, "denied", ["cancel"], false]);
    } finally {
      release.resolve();
    }
  }));

Deno.test("HTTP body lifetime: held oversized HTTP upload receives the complete rejection without client suppression", () =>
  fixtureScope(async (scope) => {
    const entered = fixtureGate(scope);
    const server = (await scope.acquire(() =>
      Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        withRequestBodyLifetime((request) => {
          request.clone();
          request.clone();
          entered.resolve();
          return Response.json({ error: "too large" }, { status: 413 });
        }),
      ), (server) => server.shutdown())).value;
    const peer = (await scope.acquire(
      () => Deno.connect({ hostname: "127.0.0.1", port: server.addr.port }),
      (conn) => conn.close(),
    )).value;
    // Use a real half-open HTTP upload, independent of fetch implementations
    // that wait for their upload pump before exposing a response.
    const writer = peer.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(
        "POST / HTTP/1.1\r\nHost: globnotes.test\r\nContent-Length: 4194305\r\n\r\nx",
      ));
    } finally {
      writer.releaseLock();
    }
    await bounded(entered.promise, "upload handler entry");
    const response = await bounded(
      (async () => {
        const reader = peer.readable.getReader(), decoder = new TextDecoder();
        try {
          let wire = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) throw new Error("Incomplete HTTP response");
            wire += decoder.decode(value, { stream: true });
            const split = wire.indexOf("\r\n\r\n");
            if (split === -1) continue;
            const head = wire.slice(0, split), body = wire.slice(split + 4);
            const length = /^content-length: (\d+)$/im.exec(head)?.[1];
            if (length && body.length >= Number(length)) {
              return [
                Number(/^HTTP\/1.1 (\d{3})/.exec(head)?.[1]),
                JSON.parse(body),
              ];
            }
          }
        } finally {
          reader.releaseLock();
        }
      })(),
      "complete refusal while upload is still open",
    );
    // No request EOF or remaining bytes have been sent; closing the owned
    // socket in cleanup releases both halves after observing the full 413.
    assertEquals(response, [413, { error: "too large" }]);
  }));
