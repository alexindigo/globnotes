import { testMetadata, testServices } from "./helpers/environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only

/** Real handlers/storage/index consumers with test-local await barriers.
 * These cases import no proposed lease helper, so the preserved product can
 * execute them and demonstrate its existing authority failure. */
import { currentBase, gatedNotes } from "./helpers/storage.ts";
import { assert, assertEquals } from "@std/assert";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { GlobalConfig } from "./helpers/config.ts";
import { signedInScenario } from "./helpers/fixture_scenarios.ts";
import { createHttpPolicy } from "../server/auth/http_policy.ts";
import { AdmissionRefusal } from "../server/auth/admission_refusal.ts";
import { OperationError } from "../server/plugins/errors.ts";
import { createUuid } from "../shared/uuid.ts";
import { identityTokenScope } from "../shared/identity_token.ts";
import { openFixtureIdentity } from "./helpers/identity_fixture.ts";
import { type FixtureScope, fixtureScope } from "./helpers/fixture_scope.ts";
import { fixtureGate } from "./helpers/fixture_coordination.ts";
import { awaitIndexReady, installFixtureState } from "./helpers/state.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { bounded as boundedWorker } from "./helpers/worker_liveness.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { createPluginManager } from "./helpers/plugin_manager.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { state } from "../server/state.ts";
import type { OperationFact } from "../server/plugins/contracts.ts";
import { testEnvironment } from "./helpers/environment.ts";
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

function barrier(scope: FixtureScope) {
  const reached = fixtureGate(scope);
  const release = fixtureGate(scope);
  return {
    reached: reached.promise,
    arrive: reached.resolve,
    waiting: release.promise,
    release: release.resolve,
  };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  return await boundedWorker(
    promise,
    "R01 fixture reached its intended barrier",
  );
}

async function outcome(promise: Promise<unknown>) {
  try {
    const result = await promise;
    if (result instanceof Response) {
      return { status: result.status, body: await result.json() };
    }
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof AdmissionRefusal) {
      return { status: error.status, body: await error.response().json() };
    }
    if (error instanceof HttpError) {
      return { status: error.status, body: error.message };
    }
    if (error instanceof OperationError) {
      return { status: error.status, body: { code: error.code } };
    }
    throw error;
  }
}

async function fixture(owner: FixtureScope) {
  const root = await Deno.makeTempDir({ prefix: "review-r01-" });
  // Kept on disk as evidence after owned runtime teardown.
  owner.defer(() =>
    console.log(
      JSON.stringify({ fixture: "R01", root, evidenceRetained: true }),
    )
  );
  const vault = `${root}/vault`, storage = `${root}/state`;
  await Deno.mkdir(vault);
  await Deno.mkdir(storage);
  const login = "lease-fixture";
  let password = "fixture-only-password";
  let now = 1_800_000_000_000;
  const env = testEnvironment({
    GLOBNOTES_GLOBNOTES_PATH: vault,
    fixtureStatePath: storage,
    GLOBNOTES__METADATA_PATH: `${root}/metadata`,
    fixtureScenario: signedInScenario({ login, password }, {
      everybody: "edit",
    }),
    GLOBNOTES__INDEX_SCANCACHETTL: "0",
  });
  const config = new GlobalConfig(env);
  const notes = gatedNotes(
      new FileSystemNotes(vault, {}, testServices(env).notes),
    ),
    files = new FileServing(vault);
  const indexer = new Fts5Indexer(
    testMetadata(storage),
    testServices(env).index,
  );
  const manager = createPluginManager(vault, undefined, 1, storage, {
    internalRoot: `${root}/internal`,
    env,
  });
  owner.defer(() => manager.stop());
  const identity = await openFixtureIdentity(
    owner,
    config,
    config.fixtureIdentity!,
    () => manager,
    { sessionClock: { now: () => now } },
  );
  installFixtureState(
    owner.defer,
    config,
    identity,
    notes,
    indexer,
    files,
    manager,
  );
  const lifecycle = identity.composition.lifecycle;
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
  owner.defer(() => runtime.close());
  state.lifecycle = lifecycle;
  state.operations = operations;
  const facts: OperationFact[] = [];
  lifecycle.onFact((fact) => facts.push(fact));
  notes.create({
    path: "victim",
    content: "original victim [attachment](old.png)",
  });
  Deno.writeTextFileSync(`${vault}/old.png`, "original attachment");
  // Raw fixture setup bypasses managed writes; seed its derived index explicitly.
  indexer.startBackgroundSync();
  await awaitIndexReady(indexer);
  function protect(everybody: "none" | "view" = "none") {
    const before = identity.acl.capture();
    identity.acl.save({ everybody, grants: before.value.grants }, before, {
      updateId: createUuid(),
      actorId: identity.accounts.byLogin(login)!.id,
    });
  }
  const session = () =>
    signIn(identity.sessions, { username: login, password });
  return {
    barrier: () => barrier(owner),
    root,
    vault,
    config,
    notes,
    indexer,
    lifecycle,
    runtime,
    operations,
    facts,
    identity,
    protect,
    expire() {
      now += identity.sessions.settings.expirySeconds * 1000 + 1;
    },
    async rotate() {
      const { principal } = await session();
      const next = "fixture-only-password-rotated";
      await new Response(
        await identity.account.change(principal, {
          revision: principal.credentialRevision,
          updateId: createUuid(),
          currentPassword: password,
          newPassword: next,
        }),
      ).json();
      password = next;
    },
    async token() {
      return (await session()).access_token;
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
  };
}

function mutationFixture(
  run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  return fixtureScope(async (scope) => await run(await fixture(scope)));
}

type Handler = (request: PathfinderRequest) => Promise<unknown>;
function request(
  method: string,
  route: string,
  body: unknown,
  hold?: ReturnType<typeof barrier>,
  token?: string,
) {
  // Writers state what they read (docs/hub.md "Write gate"): the victim's
  // version as on disk when the request is built.
  const based = method === "DELETE"
    ? `${route}${route.includes("?") ? "&" : "?"}base_version=${
      currentBase("victim").kind === "version"
        ? (currentBase("victim") as { version: string }).version
        : "0".repeat(64)
    }`
    : route;
  if (
    method === "PATCH" && body && typeof body === "object" &&
    !("base" in body) && !("baseContent" in body)
  ) body = { ...body, base: currentBase("victim") };
  const raw = new Request(`http://fixture/_/api/${based}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    _raw: raw,
    params: { path: "victim" },
    query: new URL(raw.url).searchParams,
    body: {
      text: async () => {
        hold?.arrive();
        if (hold) await hold.waiting;
        return JSON.stringify(body);
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
  if (state.identity) {
    await createHttpPolicy(state.identity.composition.auth).admit(
      req._raw,
      "editNotes",
    );
  }
  return await handler(req);
}

Deno.test("review repairs: R01 old HTTP body authority cannot borrow protection or rotation", async (t) => {
  for (const transition of ["protection", "rotation"] as const) {
    await t.step(transition, () =>
      mutationFixture(async (f) => {
        const hold = f.barrier();
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
          if (transition === "rotation") await f.rotate();
          else f.protect();
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
          assertEquals(observed.status, transition === "rotation" ? 401 : 409);
          assertEquals(
            (observed.body as { code?: string }).code,
            transition === "rotation"
              ? "credentials_refused"
              : "operation_conflict",
          );
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
          assertEquals(
            f.notes.get("victim").content,
            "authorized fresh writer",
          );
        } finally {
          hold.release();
        }
      }));
  }
});

Deno.test("review repairs: R01 multipart and file-byte awaits preserve original HTTP authority", async (t) => {
  for (const boundary of ["multipart", "file-bytes"] as const) {
    await t.step(boundary, () =>
      mutationFixture(async (f) => {
        const hold = f.barrier();
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
          assertEquals(observed.status, 409);
          f.untouched();
        } finally {
          hold.release();
        }
      }));
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
    await t.step(name, () =>
      mutationFixture(async (f) => {
        const hold = f.barrier(), queued = f.barrier();
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
          assertEquals(b.status, 409);
          assertEquals(a.status, 409);
          f.untouched();
        } finally {
          hold.release();
          if (first) await first;
          if (second) await second;
        }
      }));
  }
});

Deno.test("review repairs: R01 preparation and commit waits reject stale public epochs", async (t) => {
  for (const boundary of ["preparation", "commit", "empty-rewrite"] as const) {
    await t.step(boundary, () =>
      mutationFixture(async (f) => {
        const hold = f.barrier();
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
          const entered = f.barrier();
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
        }
      }));
  }
});

Deno.test("review repairs: R01 real signed expiry fences effects while a fresh account and guest Edit remain writable", () =>
  mutationFixture(async (f) => {
    const hold = f.barrier();
    try {
      const token = await f.token();
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
      f.expire();
      hold.release();
      const observed = await bounded(pending);
      console.log(
        JSON.stringify({
          boundary: "signed-expiry-after-admission",
          observed,
          facts: f.facts.length,
        }),
      );
      assertEquals(observed.status, 401);
      assertEquals(
        (observed.body as { code?: string }).code,
        "credentials_refused",
      );
      f.untouched();
      const req = request(
        "PATCH",
        "notes/victim",
        { newContent: "authorized fresh session" },
        undefined,
        await f.token(),
      );
      assertEquals((await outcome(admitted(update, req))).status, 200);
      assertEquals(f.notes.get("victim").content, "authorized fresh session");
      const guest = await f.identity.composition.auth.capabilities(
        new Request("http://fixture/"),
      );
      assertEquals([guest.canManageVault, guest.canEdit], [false, true]);
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
      hold.release();
    }
  }));

Deno.test("review repairs: R01 protection rotation and signed expiry are rechecked after preparation and commit waits", async (t) => {
  for (const transition of ["protection", "rotation", "expiry"] as const) {
    for (const boundary of ["preparation", "commit"] as const) {
      await t.step(
        `${transition}/${boundary}`,
        () =>
          mutationFixture(async (f) => {
            const hold = f.barrier(), queued = f.barrier();
            let gateOwner: Promise<void> | undefined;
            let pending:
              | Promise<Awaited<ReturnType<typeof outcome>>>
              | undefined;
            try {
              if (transition !== "protection") f.protect();
              const token = transition === "protection"
                ? undefined
                : await f.token();
              const retire = async () => {
                if (transition === "expiry") f.expire();
                else if (transition === "rotation") await f.rotate();
                else f.protect();
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
                  await retire();
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
              if (boundary === "preparation") {
                await f.lifecycle.gate.run(retire);
              }
              hold.release();
              if (gateOwner) await gateOwner;
              const observed = await bounded(pending);
              console.log(
                JSON.stringify({
                  transition,
                  boundary,
                  observed,
                  facts: f.facts.length,
                }),
              );
              assertEquals(
                observed.status,
                transition === "protection" ? 409 : 401,
              );
              f.untouched();
            } finally {
              hold.release();
              if (gateOwner) await gateOwner;
              if (pending) await pending;
            }
          }),
      );
    }
  }
});

Deno.test("review repairs: R01 queued requests reject rotation and signed expiry without borrowing a new epoch", async (t) => {
  for (const transition of ["rotation", "expiry"] as const) {
    await t.step(transition, () =>
      mutationFixture(async (f) => {
        const hold = f.barrier(), queued = f.barrier();
        let first: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
        let second: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
        try {
          f.protect();
          const token = await f.token();
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
          await f.lifecycle.gate.run(async () => {
            if (transition === "rotation") await f.rotate();
            else f.expire();
          });
          hold.release();
          const [a, b] = await bounded(Promise.all([first, second]));
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
        }
      }));
  }
});

Deno.test("review repairs: R01 missing API leases fail closed before preparation", () =>
  mutationFixture(async (f) => {
    const observed = await outcome(
      f.operations.createNote(
        { path: "blocked", content: "missing authority" },
        { origin: "api" } as never,
      ),
    );
    assertEquals(observed.status, 401);
    assertEquals(observed.body, {
      detail: "API mutation request authority is required.",
      code: "mutation_authority_required",
    });
    f.untouched();
  }));

Deno.test("HTTP lease controls: verified admission completion binds auth config and lifecycle identities", async (t) => {
  for (const replacement of ["auth", "config", "lifecycle"] as const) {
    await t.step(replacement, () =>
      mutationFixture(async (f) => {
        const hold = f.barrier();
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
              text: () => {
                bodies++;
                return Promise.resolve(
                  JSON.stringify({ newContent: "must not enter body" }),
                );
              },
            },
          } as unknown as PathfinderRequest;
          const sessions = f.identity.sessions;
          const verify = sessions.validateToken.bind(sessions);
          sessions.validateToken = async (...args) => {
            const metadata = await verify(...args);
            hold.arrive();
            await hold.waiting;
            return metadata;
          };
          pending = outcome(update(req));
          await bounded(hold.reached);
          if (replacement === "auth") state.identity = null;
          else if (replacement === "config") {
            state.config = new GlobalConfig(f.config.resolved);
          } else {state.lifecycle = new PluginLifecycle(
              f.config,
              f.identity.composition.eligibility,
            );}
          hold.release();
          const observed = await bounded(pending);
          assertEquals(observed.status, 409);
          assertEquals(bodies, 0);
          f.untouched();
        } finally {
          hold.release();
          if (pending) await pending;
        }
      }));
  }
});

Deno.test("HTTP lease controls: removed owners and guest View cannot write; cookies remain supported", async (t) => {
  for (const mode of ["owner-retired", "read-only", "cookie"] as const) {
    await t.step(mode, () =>
      mutationFixture(async (f) => {
        const hold = f.barrier();
        let pending: Promise<Awaited<ReturnType<typeof outcome>>> | undefined;
        try {
          if (mode === "cookie") {
            f.protect();
            const req = request("PATCH", "notes/victim", {
              newContent: "cookie-authorized writer",
            });
            req._raw.headers.set(
              "cookie",
              `${identityTokenScope(f.config.pathPrefix).cookieName}=${await f
                .token()}`,
            );
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
            if (mode === "owner-retired") state.identity = null;
            else f.protect("view");
          });
          hold.release();
          assertEquals((await bounded(pending)).status, 409);
          const fresh = await outcome(
            admitted(rewrite, request("POST", "files/rewrite-refs", null)),
          );
          assertEquals(fresh.status, mode === "owner-retired" ? 503 : 403);
          f.untouched();
        } finally {
          hold.release();
          if (pending) await pending;
        }
      }));
  }
});
