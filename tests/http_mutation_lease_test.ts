// SPDX-License-Identifier: LGPL-3.0-only

/** Real handlers/storage/index consumers with test-local await barriers.
 * These cases import no proposed lease helper, so the preserved product can
 * execute them and demonstrate its existing authority failure. */
import { assert, assertEquals } from "@std/assert";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { SignJWT } from "jose";
import { AuthType, GlobalConfig } from "../server/config.ts";
import { LocalAuth } from "../server/auth/local.ts";
import { enforceAuth } from "../server/auth/middleware.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { initState, state } from "../server/state.ts";
import type { OperationFact } from "../server/plugins/contracts.ts";
// Match the existing filesystem loader's runtime import seam. Encode the #
// directory as a URL path segment, not a fragment. The old core handlers are
// intentionally preserved here; their typed roots are repaired in R01 scope.
async function endpoint(relative: string): Promise<Handler> {
  return (await import(new URL(relative, import.meta.url).href)).default;
}
const create = await endpoint("../server/api/endpoints/_/api/notes/post.ts");
const update = await endpoint(
  "../server/api/endpoints/_/api/notes/%23...path/patch.ts",
);
const remove = await endpoint(
  "../server/api/endpoints/_/api/notes/%23...path/delete.ts",
);
const upload = await endpoint("../server/api/endpoints/_/api/files/post.ts");
const rewrite = await endpoint(
  "../server/api/endpoints/_/api/files/rewrite-refs/post.ts",
);

function barrier() {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    arrive: reached.resolve,
    waiting: release.promise,
    release: release.resolve,
  };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("R01 fixture did not reach its intended barrier")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function outcome(promise: Promise<unknown>) {
  try {
    const result = await promise;
    if (result instanceof Response) {
      return { status: result.status, body: await result.json() };
    }
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof HttpError) {
      return { status: error.status, body: error.message };
    }
    throw error;
  }
}

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: "review-r01-" });
  const vault = `${root}/vault`, storage = `${root}/state`;
  await Deno.mkdir(vault);
  await Deno.mkdir(storage);
  const keys = [
    "GLOBNOTES_PATH",
    "GLOBNOTES_INDEX_PATH",
    "GLOBNOTES_AUTH_TYPE",
    "GLOBNOTES_USERNAME",
    "GLOBNOTES_PASSWORD",
    "GLOBNOTES_SECRET_KEY",
    "GLOBNOTES_TOTP_KEY",
    "GLOBNOTES_READ_ONLY_SETTINGS",
    "GLOBNOTES_SCAN_CACHE_TTL",
  ];
  const previousEnv = keys.map((key) => Deno.env.get(key));
  const previousState = { ...state };
  for (const key of keys) Deno.env.delete(key);
  Deno.env.set("GLOBNOTES_PATH", vault);
  Deno.env.set("GLOBNOTES_INDEX_PATH", storage);
  Deno.env.set("GLOBNOTES_USERNAME", "lease-fixture");
  Deno.env.set("GLOBNOTES_PASSWORD", "fixture-only-password");
  Deno.env.set("GLOBNOTES_SCAN_CACHE_TTL", "0");
  Deno.writeTextFileSync(
    `${storage}/config.json`,
    JSON.stringify({ auth_type: "none", secret_key: "fixture-only-secret-A" }),
  );
  const config = new GlobalConfig();
  const notes = new FileSystemNotes(vault), files = new FileServing(vault);
  const indexer = new Fts5Indexer(storage);
  const manager = new PluginManager(vault, undefined, 1, storage, {
    internalRoot: `${root}/internal`,
  });
  initState(config, null, notes, indexer, files, manager);
  const lifecycle = new PluginLifecycle(config);
  const runtime = manager.configureRuntime({
    operational: () => lifecycle.operational(),
    writable: () => lifecycle.writable(),
    commit: (effect) => lifecycle.gate.run(effect),
  });
  const operations = new NoteOperations({
    notes,
    files,
    indexer,
    runtime: () => runtime,
    lifecycle,
  });
  state.lifecycle = lifecycle;
  state.operations = operations;
  const facts: OperationFact[] = [];
  lifecycle.onFact((fact) => facts.push(fact));
  notes.create({
    path: "victim",
    content: "original victim [attachment](old.png)",
  });
  Deno.writeTextFileSync(`${vault}/old.png`, "original attachment");
  let secret = "fixture-only-secret-A";
  function protect(rotate = false) {
    if (rotate) secret = "fixture-only-secret-B";
    config.saveStoredConfig({
      ...config.storedConfig,
      auth_type: "password",
      secret_key: secret,
    });
    config.authType = AuthType.PASSWORD;
    state.auth = new LocalAuth(config);
    lifecycle.bumpEpoch();
  }
  return {
    root,
    vault,
    config,
    notes,
    indexer,
    lifecycle,
    runtime,
    operations,
    facts,
    protect,
    async token(expires?: number) {
      let jwt = new SignJWT({ sub: "lease-fixture" }).setProtectedHeader({
        alg: "HS256",
      });
      if (expires !== undefined) jwt = jwt.setExpirationTime(expires);
      return await jwt.sign(new TextEncoder().encode(secret));
    },
    untouched() {
      assertEquals(
        notes.get("victim").content,
        "original victim [attachment](old.png)",
      );
      assertEquals(
        Deno.readTextFileSync(`${vault}/old.png`),
        "original attachment",
      );
      assertEquals(
        [...Deno.readDirSync(vault)].map((entry) => entry.name).sort(),
        ["old.png", "victim.md"],
      );
      assertEquals(indexer.search("original").map((result) => result.path), [
        "victim",
      ]);
      assertEquals(facts, []);
    },
    async close() {
      await runtime.close();
      manager.stop();
      for (const key of Object.keys(state)) {
        if (!Object.hasOwn(previousState, key)) {
          Reflect.deleteProperty(state, key);
        }
      }
      Object.assign(state, previousState);
      keys.forEach((key, index) =>
        previousEnv[index] === undefined
          ? Deno.env.delete(key)
          : Deno.env.set(key, previousEnv[index]!)
      );
      // Generated evidence survives both red and green; only owned runtime closes.
      console.log(
        JSON.stringify({ fixture: "R01", root, evidenceRetained: true }),
      );
    },
  };
}

type Handler = (request: PathfinderRequest) => Promise<unknown>;
function request(
  method: string,
  route: string,
  body: unknown,
  hold?: ReturnType<typeof barrier>,
  token?: string,
) {
  const raw = new Request(`http://fixture/_/api/${route}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    _raw: raw,
    params: { path: "victim" },
    query: new URL(raw.url).searchParams,
    body: {
      json: async () => {
        hold?.arrive();
        if (hold) await hold.waiting;
        return structuredClone(body);
      },
      form: async () => {
        hold?.arrive();
        if (hold) await hold.waiting;
        return body;
      },
    },
  } as unknown as PathfinderRequest;
}
async function admitted(handler: Handler, req: PathfinderRequest) {
  await enforceAuth(req._raw);
  return await handler(req);
}

Deno.test("review repairs: R01 old HTTP body authority cannot borrow protection or rotation", async (t) => {
  for (const transition of ["protection", "rotation"] as const) {
    await t.step(transition, async () => {
      const f = await fixture(), hold = barrier();
      try {
        if (transition === "rotation") f.protect();
        const token = transition === "rotation" ? await f.token() : undefined;
        const pending = outcome(
          admitted(
            update,
            request(
              "PATCH",
              "notes/victim",
              { newContent: "unauthorized overwrite" },
              hold,
              token,
            ),
          ),
        );
        await bounded(hold.reached);
        f.protect(transition === "rotation");
        hold.release();
        const observed = await bounded(pending);
        console.log(
          JSON.stringify({
            transition,
            boundary: "body",
            observed,
            victim: f.notes.get("victim").content,
            facts: f.facts.length,
          }),
        );
        assertEquals(observed.status, 401);
        f.untouched();
        const fresh = outcome(
          admitted(
            update,
            request(
              "PATCH",
              "notes/victim",
              { newContent: "authorized fresh writer" },
              undefined,
              await f.token(),
            ),
          ),
        );
        assertEquals((await fresh).status, 200);
        assertEquals(f.notes.get("victim").content, "authorized fresh writer");
      } finally {
        hold.release();
        await f.close();
      }
    });
  }
});

Deno.test("review repairs: R01 multipart and file-byte awaits preserve original HTTP authority", async (t) => {
  for (const boundary of ["multipart", "file-bytes"] as const) {
    await t.step(boundary, async () => {
      const f = await fixture(), hold = barrier();
      try {
        const form = new FormData();
        form.append("file", new File(["blocked attachment"], "blocked.png"));
        form.append("directory", "forbidden-new-directory");
        const raw = new Request("http://fixture/_/api/files", {
          method: "POST",
          body: form,
        });
        const req = {
          _raw: raw,
          body: {
            form: async () => {
              if (boundary === "multipart") {
                hold.arrive();
                await hold.waiting;
              }
              const parsed = await raw.formData();
              if (boundary === "file-bytes") {
                const file = parsed.get("file");
                assert(file instanceof File);
                const read = file.arrayBuffer.bind(file);
                file.arrayBuffer = async () => {
                  hold.arrive();
                  await hold.waiting;
                  return await read();
                };
              }
              return parsed;
            },
          },
        } as unknown as PathfinderRequest;
        const pending = outcome(admitted(upload, req));
        await bounded(hold.reached);
        f.protect();
        hold.release();
        const observed = await bounded(pending);
        console.log(
          JSON.stringify({ boundary, observed, facts: f.facts.length }),
        );
        assertEquals(observed.status, 401);
        f.untouched();
      } finally {
        hold.release();
        await f.close();
      }
    });
  }
});

Deno.test("review repairs: R01 queued A and B retain admission authority for every mutation handler", async (t) => {
  const jobs: [string, Handler, string, string, unknown][] = [
    ["create", create, "POST", "notes", {
      path: "blocked/new",
      content: "blocked create",
    }],
    ["save", update, "PATCH", "notes/victim", { newContent: "blocked save" }],
    ["delete", remove, "DELETE", "notes/victim", null],
    ["upload", upload, "POST", "files", null],
    [
      "rewrite",
      rewrite,
      "POST",
      "files/rewrite-refs?old_path=old.png&new_path=blocked.png",
      null,
    ],
  ];
  for (const [name, handler, method, route, data] of jobs) {
    await t.step(name, async () => {
      const f = await fixture(), hold = barrier(), queued = barrier();
      let first: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
      let second: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
      try {
        const guard = f.runtime.guard.bind(f.runtime);
        let armed = true;
        f.runtime.guard = async (...args) => {
          if (armed) {
            armed = false;
            hold.arrive();
            await hold.waiting;
          }
          return await guard(...args);
        };
        first = outcome(
          admitted(
            create,
            request("POST", "notes", { path: "blocked-A", content: "old A" }),
          ),
        );
        await bounded(hold.reached);
        const form = new FormData();
        form.append("file", new File(["blocked bytes"], "blocked.png"));
        form.append("directory", "blocked");
        const req = request(method, route, name === "upload" ? form : data);
        const key = {
          create: "createNote",
          save: "updateNote",
          delete: "deleteNote",
          upload: "uploadFile",
          rewrite: "rewriteRefs",
        }[name] as "createNote";
        // Observe real facade admission; the original method enqueues B before
        // this wrapper signals. No private-lock mutation or timing sleep.
        const original = f.operations[key].bind(f.operations);
        f.operations[key] = (...args) => {
          const result = original(...args);
          queued.arrive();
          return result;
        };
        second = outcome(admitted(handler, req));
        await bounded(queued.reached);
        f.protect();
        hold.release();
        const [a, b] = await bounded(Promise.all([first, second]));
        console.log(
          JSON.stringify({
            name,
            boundary: "operation-lock",
            a,
            b,
            victimExists: f.operations.noteExists("victim"),
            facts: f.facts.length,
          }),
        );
        assertEquals(b.status, 401);
        assertEquals(a.status, 401);
        f.untouched();
      } finally {
        hold.release();
        if (first) await first;
        if (second) await second;
        await f.close();
      }
    });
  }
});

Deno.test("review repairs: R01 preparation and commit waits reject stale public epochs", async (t) => {
  for (const boundary of ["preparation", "commit", "empty-rewrite"] as const) {
    await t.step(boundary, async () => {
      const f = await fixture(), hold = barrier();
      let locked: Promise<void> | undefined;
      let pending: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
      try {
        if (boundary === "commit") {
          locked = f.lifecycle.gate.run(async () => {
            hold.arrive();
            await hold.waiting;
          });
          await bounded(hold.reached);
        } else {
          const prepare = f.notes.prepareRefsRewrite.bind(f.notes);
          f.notes.prepareRefsRewrite = async (...args) => {
            const changes = await prepare(...args);
            hold.arrive();
            await hold.waiting;
            return changes;
          };
        }
        const route = boundary === "empty-rewrite"
          ? "files/rewrite-refs?old_path=absent.png&new_path=x.png"
          : "files/rewrite-refs?old_path=old.png&new_path=blocked.png";
        const entered = barrier();
        const rewriteRefs = f.operations.rewriteRefs.bind(f.operations);
        f.operations.rewriteRefs = (...args) => {
          const result = rewriteRefs(...args);
          entered.arrive();
          return result;
        };
        pending = outcome(admitted(rewrite, request("POST", route, null)));
        await bounded(boundary === "commit" ? entered.reached : hold.reached);
        // Auth stays public/writable: the epoch, not a replacement credential,
        // must reject this already admitted work, including no-op preparation.
        f.lifecycle.bumpEpoch();
        hold.release();
        if (locked) await locked;
        const observed = await bounded(pending);
        console.log(
          JSON.stringify({ boundary, observed, facts: f.facts.length }),
        );
        assertEquals(observed.status, 409);
        assertEquals(
          (observed.body as { code?: string }).code,
          "operation_conflict",
        );
        f.untouched();
      } finally {
        hold.release();
        if (locked) await locked;
        if (pending) await pending;
        await f.close();
      }
    });
  }
});

Deno.test("review repairs: R01 real signed expiry fences effects and no-expiry/settings-lock controls remain writable", async () => {
  const f = await fixture(), hold = barrier();
  const clock = Date.now;
  try {
    f.protect();
    const now = clock();
    const token = await f.token(Math.floor(now / 1000) + 60);
    const pending = outcome(
      admitted(
        update,
        request(
          "PATCH",
          "notes/victim",
          { newContent: "expired write" },
          hold,
          token,
        ),
      ),
    );
    await bounded(hold.reached);
    Date.now = () => now + 120000;
    hold.release();
    const observed = await bounded(pending);
    Date.now = clock;
    console.log(
      JSON.stringify({
        boundary: "signed-expiry-after-admission",
        observed,
        facts: f.facts.length,
      }),
    );
    assertEquals(observed.status, 401);
    f.untouched();
    const req = request(
      "PATCH",
      "notes/victim",
      { newContent: "authorized no-expiry" },
      undefined,
      await f.token(),
    );
    assertEquals((await outcome(admitted(update, req))).status, 200);
    assertEquals(f.notes.get("victim").content, "authorized no-expiry");
    f.config.saveStoredConfig({
      ...f.config.storedConfig,
      auth_type: "none",
      read_only_settings: true,
    });
    f.config.authType = AuthType.NONE;
    state.auth = null;
    f.lifecycle.bumpEpoch();
    assert(!f.config.settingsWritable);
    assertEquals(
      (await outcome(
        admitted(
          update,
          request("PATCH", "notes/victim", {
            newContent: "public note through settings lock",
          }),
        ),
      )).status,
      200,
    );
    assertEquals(
      f.notes.get("victim").content,
      "public note through settings lock",
    );
  } finally {
    Date.now = clock;
    hold.release();
    await f.close();
  }
});

Deno.test("review repairs: R01 protection rotation and signed expiry are rechecked after preparation and commit waits", async (t) => {
  for (const transition of ["protection", "rotation", "expiry"] as const) {
    for (const boundary of ["preparation", "commit"] as const) {
      await t.step(`${transition}/${boundary}`, async () => {
        const f = await fixture(), hold = barrier(), queued = barrier();
        const clock = Date.now, now = clock();
        let gateOwner: Promise<void> | undefined;
        let pending: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
        try {
          if (transition !== "protection") f.protect();
          const token = transition === "protection" ? undefined : await f.token(
            transition === "expiry" ? Math.floor(now / 1000) + 60 : undefined,
          );
          const retire = () => {
            if (transition === "expiry") Date.now = () => now + 120000;
            else f.protect(transition === "rotation");
          };
          if (boundary === "preparation") {
            const prepare = f.notes.prepareRefsRewrite.bind(f.notes);
            f.notes.prepareRefsRewrite = async (...args) => {
              const changes = await prepare(...args);
              hold.arrive();
              await hold.waiting;
              return changes;
            };
          } else {
            // The policy writer already owns the actual gate; its commit
            // precedes the old note request queued behind it.
            const gate = f.lifecycle.gate.run.bind(f.lifecycle.gate);
            gateOwner = gate(async () => {
              hold.arrive();
              await hold.waiting;
              retire();
            });
            await bounded(hold.reached);
            f.lifecycle.gate.run = (effect) => {
              const result = gate(effect);
              queued.arrive();
              return result;
            };
          }
          pending = outcome(
            admitted(
              rewrite,
              request(
                "POST",
                "files/rewrite-refs?old_path=old.png&new_path=blocked.png",
                null,
                undefined,
                token,
              ),
            ),
          );
          await bounded(
            boundary === "preparation" ? hold.reached : queued.reached,
          );
          if (boundary === "preparation") await f.lifecycle.gate.run(retire);
          hold.release();
          if (gateOwner) await gateOwner;
          const observed = await bounded(pending);
          Date.now = clock;
          console.log(
            JSON.stringify({
              transition,
              boundary,
              observed,
              facts: f.facts.length,
            }),
          );
          assertEquals(observed.status, 401);
          f.untouched();
        } finally {
          hold.release();
          if (gateOwner) await gateOwner;
          if (pending) await pending;
          Date.now = clock;
          await f.close();
        }
      });
    }
  }
});

Deno.test("review repairs: R01 queued requests reject rotation and signed expiry without borrowing a new epoch", async (t) => {
  for (const transition of ["rotation", "expiry"] as const) {
    await t.step(transition, async () => {
      const f = await fixture(), hold = barrier(), queued = barrier();
      const clock = Date.now, now = clock();
      let first: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
      let second: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
      try {
        f.protect();
        const token = await f.token(
          transition === "expiry" ? Math.floor(now / 1000) + 60 : undefined,
        );
        const guard = f.runtime.guard.bind(f.runtime);
        let armed = true;
        f.runtime.guard = async (...args) => {
          if (armed) {
            armed = false;
            hold.arrive();
            await hold.waiting;
          }
          return await guard(...args);
        };
        first = outcome(
          admitted(
            create,
            request(
              "POST",
              "notes",
              { path: "blocked-A", content: "old A" },
              undefined,
              token,
            ),
          ),
        );
        await bounded(hold.reached);
        const updateNote = f.operations.updateNote.bind(f.operations);
        f.operations.updateNote = (...args) => {
          const result = updateNote(...args);
          queued.arrive();
          return result;
        };
        second = outcome(
          admitted(
            update,
            request(
              "PATCH",
              "notes/victim",
              { newContent: "old B" },
              undefined,
              token,
            ),
          ),
        );
        await bounded(queued.reached);
        await f.lifecycle.gate.run(() => {
          if (transition === "rotation") f.protect(true);
          else Date.now = () => now + 120000;
        });
        hold.release();
        const [a, b] = await bounded(Promise.all([first, second]));
        Date.now = clock;
        console.log(
          JSON.stringify({
            transition,
            boundary: "operation-lock",
            a,
            b,
            facts: f.facts.length,
          }),
        );
        assertEquals(a.status, 401);
        assertEquals(b.status, 401);
        f.untouched();
      } finally {
        hold.release();
        if (first) await first;
        if (second) await second;
        Date.now = clock;
        await f.close();
      }
    });
  }
});

Deno.test("review repairs: R01 missing API leases fail closed before preparation", async () => {
  const f = await fixture();
  try {
    const observed = await outcome(
      f.operations.createNote(
        { path: "blocked", content: "missing authority" },
        { origin: "api" } as never,
      ),
    );
    assertEquals(observed.status, 401);
    f.untouched();
  } finally {
    await f.close();
  }
});

Deno.test("HTTP lease controls: verified admission completion binds auth config and lifecycle identities", async (t) => {
  for (const replacement of ["auth", "config", "lifecycle"] as const) {
    await t.step(replacement, async () => {
      const f = await fixture(), hold = barrier();
      let pending: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
      try {
        f.protect();
        const base = request(
          "PATCH",
          "notes/victim",
          null,
          undefined,
          await f.token(),
        );
        let bodies = 0;
        const req = {
          ...base,
          body: {
            json: () => {
              bodies++;
              return Promise.resolve({ newContent: "must not enter body" });
            },
          },
        } as unknown as PathfinderRequest;
        await enforceAuth(req._raw);
        const auth = state.auth!;
        const verify = auth.validateTokenMetadata.bind(auth);
        auth.validateTokenMetadata = async (...args) => {
          const metadata = await verify(...args);
          hold.arrive();
          await hold.waiting;
          return metadata;
        };
        pending = outcome(update(req));
        await bounded(hold.reached);
        if (replacement === "auth") state.auth = new LocalAuth(f.config);
        else if (replacement === "config") state.config = new GlobalConfig();
        else state.lifecycle = new PluginLifecycle(f.config);
        hold.release();
        const observed = await bounded(pending);
        assertEquals(observed.status, replacement === "auth" ? 401 : 409);
        assertEquals(bodies, 0);
        f.untouched();
      } finally {
        hold.release();
        if (pending) await pending;
        await f.close();
      }
    });
  }
});

Deno.test("HTTP lease controls: setup and note read-only statuses survive late handler catch mappings; cookies remain supported", async (t) => {
  for (const mode of ["setup", "read-only", "cookie"] as const) {
    await t.step(mode, async () => {
      const f = await fixture(), hold = barrier();
      let pending: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
      try {
        if (mode === "cookie") {
          f.protect();
          const req = request("PATCH", "notes/victim", {
            newContent: "cookie-authorized writer",
          });
          req._raw.headers.set("cookie", `token=${await f.token()}`);
          assertEquals((await outcome(admitted(update, req))).status, 200);
          assertEquals(
            f.notes.get("victim").content,
            "cookie-authorized writer",
          );
          return;
        }
        const prepare = f.notes.prepareRefsRewrite.bind(f.notes);
        f.notes.prepareRefsRewrite = async (...args) => {
          const changes = await prepare(...args);
          hold.arrive();
          await hold.waiting;
          return changes;
        };
        pending = outcome(
          admitted(
            rewrite,
            request(
              "POST",
              "files/rewrite-refs?old_path=old.png&new_path=blocked.png",
              null,
            ),
          ),
        );
        await bounded(hold.reached);
        await f.lifecycle.gate.run(() => {
          if (mode === "setup") f.config.setupRequired = true;
          else f.config.authType = AuthType.READ_ONLY;
          f.lifecycle.bumpEpoch();
        });
        hold.release();
        assertEquals(
          (await bounded(pending)).status,
          mode === "setup" ? 503 : 403,
        );
        f.untouched();
      } finally {
        hold.release();
        if (pending) await pending;
        await f.close();
      }
    });
  }
});
