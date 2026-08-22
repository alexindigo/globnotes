// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals } from "@std/assert";
import { HttpError } from "../server/http_error.ts";
import { Router } from "../server/router.ts";

function req(path: string, method = "GET"): Request {
  return new Request(`http://localhost${path}`, { method });
}

Deno.test("router: literal route match", async () => {
  const r = new Router();
  r.add("GET", "/_/api/health", () => "OK");
  const res = await r.handle(req("/_/api/health"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), '"OK"');
  assertEquals(res.headers.get("content-type"), "application/json");
});

Deno.test("router: 404 for unknown path, FastAPI shape", async () => {
  const r = new Router();
  r.add("GET", "/known", () => "yes");
  const res = await r.handle(req("/unknown"));
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { detail: "Not Found" });
});

Deno.test("router: 405 when path matches another method", async () => {
  const r = new Router();
  r.add("POST", "/thing", () => "made");
  const res = await r.handle(req("/thing", "GET"));
  assertEquals(res.status, 405);
  assertEquals(await res.json(), { detail: "Method Not Allowed" });
});

Deno.test("router: single-segment param, decoded", async () => {
  const r = new Router();
  r.add("GET", "/notes/:title", (ctx) => ({ got: ctx.params.title }));
  const res = await r.handle(req("/notes/my%20note"));
  assertEquals(await res.json(), { got: "my note" });
});

Deno.test("router: greedy rest param captures remaining path", async () => {
  const r = new Router();
  r.add("GET", "/notes/:title*", (ctx) => ({ got: ctx.params.title }));
  const res = await r.handle(req("/notes/a/b/c"));
  assertEquals(await res.json(), { got: "a/b/c" });
});

Deno.test("router: literal beats param, param beats rest", async () => {
  const r = new Router();
  r.add("GET", "/x/:rest*", () => "rest");
  r.add("GET", "/x/:id", () => "param");
  r.add("GET", "/x/lit", () => "literal");
  assertEquals(await (await r.handle(req("/x/lit"))).text(), '"literal"');
  assertEquals(await (await r.handle(req("/x/other"))).text(), '"param"');
  assertEquals(await (await r.handle(req("/x/a/b"))).text(), '"rest"');
});

Deno.test("router: null result → JSON null (FastAPI parity)", async () => {
  const r = new Router();
  r.add("DELETE", "/thing", () => null);
  const res = await r.handle(req("/thing", "DELETE"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "null");
});

Deno.test("router: Response passes through untouched", async () => {
  const r = new Router();
  r.add(
    "GET",
    "/raw",
    () => new Response("plain", { headers: { "content-type": "text/plain" } }),
  );
  const res = await r.handle(req("/raw"));
  assertEquals(res.headers.get("content-type"), "text/plain");
  assertEquals(await res.text(), "plain");
});

Deno.test("router: HttpError maps to {detail} with status", async () => {
  const r = new Router();
  r.add("GET", "/boom", () => {
    throw new HttpError(400, "invalid note title");
  });
  const res = await r.handle(req("/boom"));
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { detail: "invalid note title" });
});

Deno.test("router: unexpected error → 500, no internals leaked", async () => {
  const r = new Router();
  r.add("GET", "/boom", () => {
    throw new Error("secret internals");
  });
  const res = await r.handle(req("/boom"));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { detail: "Internal Server Error" });
});

Deno.test("router: middleware runs in order, wraps handler", async () => {
  const order: string[] = [];
  const r = new Router();
  r.use((_ctx, next) => {
    order.push("a-in");
    return next();
  });
  r.use((_ctx, next) => {
    order.push("b-in");
    return next();
  });
  r.add("GET", "/x", () => {
    order.push("handler");
    return "done";
  });
  await r.handle(req("/x"));
  assertEquals(order, ["a-in", "b-in", "handler"]);
});

Deno.test("router: middleware can short-circuit", async () => {
  const r = new Router();
  r.use(() => new Response("denied", { status: 403 }));
  r.add("GET", "/x", () => "never");
  const res = await r.handle(req("/x"));
  assertEquals(res.status, 403);
  assertEquals(await res.text(), "denied");
});

Deno.test("router: path prefix strips and 404s outside it", async () => {
  const r = new Router({ prefix: "/notes" });
  r.add("GET", "/_/api/health", () => "OK");
  assertEquals((await r.handle(req("/notes/_/api/health"))).status, 200);
  assertEquals((await r.handle(req("/_/api/health"))).status, 404);
});

Deno.test("router: query string available to handler", async () => {
  const r = new Router();
  r.add("GET", "/s", (ctx) => ({ term: ctx.query.get("term") }));
  const res = await r.handle(req("/s?term=hello%20world"));
  assertEquals(await res.json(), { term: "hello world" });
});

Deno.test("router: HttpError thrown by middleware is mapped", async () => {
  const r = new Router();
  r.use(() => {
    throw new HttpError(401, "Invalid authentication credentials");
  });
  r.add("GET", "/x", () => "never");
  const res = await r.handle(req("/x"));
  assertEquals(res.status, 401);
  assertEquals(await res.json(), {
    detail: "Invalid authentication credentials",
  });
  assert(typeof res.headers.get("content-type") === "string");
});
