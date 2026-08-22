// SPDX-License-Identifier: LGPL-3.0-only

import { assertEquals } from "@std/assert";
import { loadEndpoints } from "../server/api/loader.ts";
import { Router } from "../server/router.ts";

const FIXTURES = new URL("./fixtures/endpoints/", import.meta.url);

Deno.test("loader: registers <route>/<METHOD>.ts as a route", async () => {
  const r = new Router();
  await loadEndpoints(r, FIXTURES);
  const res = await r.handle(new Request("http://localhost/ping"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), '"pong"');
});

Deno.test("loader: [param] dir becomes a single-segment param", async () => {
  const r = new Router();
  await loadEndpoints(r, FIXTURES);
  const res = await r.handle(new Request("http://localhost/item/42"));
  assertEquals(await res.json(), { id: "42" });
});

Deno.test("loader: [...param] dir becomes a greedy rest param", async () => {
  const r = new Router();
  await loadEndpoints(r, FIXTURES);
  const res = await r.handle(new Request("http://localhost/deep/a/b/c"));
  assertEquals(await res.json(), { rest: "a/b/c" });
});

Deno.test("loader: mount prefix is applied", async () => {
  const r = new Router();
  await loadEndpoints(r, FIXTURES, { mount: "/_/api" });
  const res = await r.handle(new Request("http://localhost/_/api/ping"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), '"pong"');
});
