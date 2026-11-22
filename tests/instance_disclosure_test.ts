// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { AccountRepository } from "../server/auth/accounts.ts";
import {
  InstanceAuthority,
  type PreparedAuthorityRead,
} from "../server/auth/authority.ts";
import { createInstanceAuth } from "../server/auth/middleware.ts";
import {
  GUEST,
  InstanceSessions,
  SessionRepository,
} from "../server/auth/sessions.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import { OwnershipError } from "../shared/ownership.js";
import {
  identityFixture,
  prepareFixtureAccount,
  UPDATE,
} from "./helpers/identity.ts";
import {
  disableFixtureAuthenticator,
  importFixtureAccount,
} from "./helpers/account_preparation.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { type FixtureScope } from "./helpers/fixture_scope.ts";
import { withPluginFixture } from "./helpers/plugin_fixture.ts";
import { fixtureGate } from "./helpers/fixture_coordination.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import { PluginHost, type RpcAuthority } from "../server/plugins/host.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { type HostMessage } from "../server/plugins/contracts.ts";

async function fixture(
  run: (f: Awaited<ReturnType<typeof prepare>>) => Promise<void>,
) {
  await identityFixture(async (root, scope) => {
    await run(await prepare(root, scope));
  });
}
async function prepare(root: string, scope: FixtureScope) {
  const accounts = new AccountRepository(`${root}/identity`);
  scope.onCancel(() => accounts.retireCredentials());
  const alice = importFixtureAccount(
    accounts,
    await prepareFixtureAccount("alice", "password"),
  );
  const signing = new SessionRepository(accounts.root);
  signing.initialize();
  const sessions = new InstanceSessions(accounts, signing, {
    expirySeconds: 1000,
  });
  const signed = await signIn(sessions, {
    username: "alice",
    password: "password",
  });
  const lifetime = createOperationLease("live", [() => {}]);
  scope.onCancel(() => lifetime.retire());
  let vaultSelections = 0;
  const adapters = {
    sessions,
    cookieName: "token",
    vault() {
      vaultSelections++;
      return null;
    },
    lifetime: () => lifetime.lease,
  };
  const auth = createInstanceAuth(adapters);
  const authority = new InstanceAuthority(
    sessions,
    adapters.vault,
    lifetime.lease,
  );
  const request = () =>
    new Request("http://globnotes.test/account", {
      headers: { authorization: `Bearer ${signed.access_token}` },
    });
  return {
    root,
    scope,
    accounts,
    alice,
    sessions,
    signed,
    lifetime,
    auth,
    adapters,
    authority,
    request,
    vaultSelections: () => vaultSelections,
  };
}

Deno.test("G3 instance: own-account and guest status bodies need no vault and preserve complete JSON", () =>
  fixture(async (f) => {
    const own = await f.auth.instanceLease(f.request(), "manageOwnAccount");
    const value = { login: "alice", passwordChangeRequired: false };
    const handle = await own.read(() => Promise.resolve(value));
    assertEquals(JSON.stringify(handle), "{}");
    assertEquals(await new Response(own.body(handle)).json(), value);
    const status = f.authority.instanceLease(GUEST, "readInstance");
    assertEquals(
      await new Response(status.body(status.prepare({ initialized: true })))
        .json(),
      { initialized: true },
    );
    assertEquals(f.vaultSelections(), 0);
    assertThrows(
      () => f.authority.instanceLease(GUEST, "manageOwnAccount"),
      HttpError,
      "HTTP 401",
    );
    (await f.auth.instanceGuard(f.request(), "manageOwnAccount"))();
  }));

for (
  const change of ["composition", "session", "credentials", "abort"] as const
) {
  Deno.test(`G3 instance: ${change} after preparation fences actual response consumption`, () =>
    fixture(async (f) => {
      const abort = new AbortController();
      const lease = await f.auth.instanceLease(
        new Request(f.request(), { signal: abort.signal }),
        "manageOwnAccount",
      );
      const handle = lease.prepare({ login: "alice" });
      const current = new Response(lease.body(handle));
      assertEquals(await current.json(), { login: "alice" });
      const queued = new Response(lease.body(handle));
      if (change === "composition") f.lifetime.retire();
      if (change === "session") {
        f.adapters.sessions = new InstanceSessions(
          f.accounts,
          f.sessions.signing,
          { expirySeconds: 1000 },
        );
      }
      if (change === "credentials") {
        await disableFixtureAuthenticator(f.accounts, f.alice.id, UPDATE);
      }
      const error = new Error("request retired");
      if (change === "abort") abort.abort(error);
      const rejection = await assertRejects(
        () => queued.json(),
        change === "composition"
          ? OwnershipError
          : change === "abort"
          ? Error
          : HttpError,
        change === "composition"
          ? "Owner is retired"
          : change === "abort"
          ? "request retired"
          : "HTTP 401",
      );
      if (change === "abort") assertStrictEquals(rejection, error);
    }));
}

for (const getter of ["then", "toJSON", "property"] as const) {
  Deno.test(`G3 instance: ${getter} retirement runs before the final JSON enqueue fence`, () =>
    fixture(async (f) => {
      const lease = await f.auth.instanceLease(f.request(), "manageOwnAccount");
      let armed = false, reads = 0;
      const retire = () => {
        reads++;
        if (armed) f.lifetime.retire();
      };
      const value = getter === "then"
        ? {
          get then() {
            retire();
            return undefined;
          },
          login: "alice",
        }
        : getter === "toJSON"
        ? {
          toJSON() {
            retire();
            return { login: "alice" };
          },
        }
        : {
          get login() {
            retire();
            return "alice";
          },
        };
      // Isolate the thenability probe from JSON's separate enumerable-key visit.
      if (getter === "then") {
        Object.defineProperty(value, "then", { enumerable: false });
      }
      const handle = lease.prepare(value);
      const queued = new Response(lease.body(handle));
      reads = 0;
      armed = true;
      await assertRejects(
        () => queued.text(),
        OwnershipError,
        "Owner is retired",
      );
      assertEquals(reads, 1);
    }));
}

Deno.test("G3 instance: request/session capture precedes verification, replacement cannot read request bodies", () =>
  fixture(async (f) => {
    const resolve = f.sessions.resolve.bind(f.sessions);
    let bodies = 0;
    await heldOperation({
      label: "G3 validation",
      owner: () => f.sessions,
      progress: { kind: "controlled", clock: "external" },
    }, (hold) => {
      f.sessions.resolve = async (token) => {
        const value = await resolve(token);
        await hold();
        return value;
      };
      return f.auth.instanceLease(f.request(), "manageOwnAccount").then(
        async (lease) => {
          return await lease.read(() => {
            bodies++;
            return Promise.resolve("body");
          });
        },
      );
    }, async (operation) => {
      await operation.reached();
      f.adapters.sessions = new InstanceSessions(
        f.accounts,
        f.sessions.signing,
        { expirySeconds: 1000 },
      );
      await assertRejects(() => operation.result(), HttpError, "HTTP 401");
      assertEquals(bodies, 0);
    });
  }));

Deno.test("G3 instance: reentrant session policy cannot retire the composition then permit delivery", () =>
  fixture(async (f) => {
    const lease = f.authority.instanceLease(
      f.signed.principal,
      "manageOwnAccount",
    );
    const handle = lease.prepare({ login: "alice" });
    const response = new Response(lease.body(handle));
    const assertCurrent = f.sessions.assertCurrent.bind(f.sessions);
    f.sessions.assertCurrent = (principal) => {
      assertCurrent(principal);
      f.lifetime.retire();
    };
    await assertRejects(
      () => response.json(),
      OwnershipError,
      "Owner is retired",
    );
  }));

Deno.test("G3 instance: issued lifetime/mode and prepared-handle provenance cannot be forged or crossed", () =>
  fixture(async (f) => {
    for (
      const parent of [
        undefined,
        {},
        { ...f.lifetime.lease },
        createOperationLease("outcome", [() => {}]).lease,
      ]
    ) {
      const invalid = new InstanceAuthority(
        f.sessions,
        () => null,
        parent as never,
      );
      assertThrows(
        () => invalid.instanceLease(f.signed.principal, "manageOwnAccount"),
        TypeError,
        "issued operation lease",
      );
    }
    const lease = f.authority.instanceLease(
      f.signed.principal,
      "manageOwnAccount",
    );
    const other = f.authority.instanceLease(
      f.signed.principal,
      "manageOwnAccount",
    );
    const handle = lease.prepare("private");
    assertEquals(await new Response(lease.body(handle)).json(), "private");
    for (
      const bad of [
        null,
        {},
        { ...handle },
        other.prepare("foreign"),
        () => "effect",
      ]
    ) {
      assertThrows(
        () => lease.disclose(bad as PreparedAuthorityRead<string>),
        TypeError,
        "this operation's prepared read",
      );
    }
    let entries = 0;
    assertThrows(
      () =>
        lease.prepare(
          (() => {
            entries++;
          }) as never,
        ),
      TypeError,
      "prepared data",
    );
    assertThrows(
      () => lease.prepare(Promise.resolve("private") as never),
      TypeError,
      "prepared data",
    );
    assertEquals(entries, 0);
    assertThrows(
      () => f.authority.acknowledgment(lease.lease as never),
      TypeError,
      "issued operation lease",
    );
  }));

Deno.test("G3 outcome: exact acknowledgment survives self-change but never composition replacement or live dispatch", () =>
  fixture(async (f) => {
    const domain = createOperationLease("outcome", [() => {}], [
      f.lifetime.lease,
    ]);
    const live = f.authority.instanceLease(
      f.signed.principal,
      "manageOwnAccount",
    );
    const outcome = f.authority.acknowledgment(domain.lease);
    const handle = outcome.prepare({ operationId: UPDATE, committed: true });
    await disableFixtureAuthenticator(f.accounts, f.alice.id, UPDATE);
    assertThrows(() => live.assertCurrent(), HttpError, "HTTP 401");
    assertEquals(await new Response(outcome.body(handle)).json(), {
      operationId: UPDATE,
      committed: true,
    });
    const queued = new Response(outcome.body(handle));
    f.lifetime.retire();
    await assertRejects(
      () => queued.json(),
      OwnershipError,
      "Owner is retired",
    );
  }));

Deno.test("G3 instance streams: complete arbitrary chunks preserve identity without then inspection", () =>
  fixture(async (f) => {
    const lease = f.authority.instanceLease(GUEST, "readInstance");
    let thenReads = 0;
    const chunks = [
      Promise.resolve("promise chunk"),
      {
        get then() {
          thenReads++;
          return () => {};
        },
      },
      null,
      0,
    ];
    const source = new ReadableStream<unknown>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const reader = lease.stream(source).getReader();
    const seen: unknown[] = [];
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        seen.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    assertEquals(seen.length, chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      assertStrictEquals(seen[i], chunks[i]);
    }
    assertEquals([thenReads, source.locked], [0, false]);
  }));

for (const mode of ["error", "cancel"] as const) {
  Deno.test(`G3 instance streams: ${mode} releases its reader without waiting for tee cleanup`, () =>
    fixture(async (f) => {
      const lease = f.authority.instanceLease(GUEST, "readInstance");
      const cleanupError = new Error("G3 source cleanup failed");
      const cancellations: unknown[] = [];
      const source = new ReadableStream<string>({
        cancel(reason) {
          cancellations.push(reason);
          throw cleanupError;
        },
      }, { highWaterMark: 0 });
      const [branch, peer] = source.tee();
      const reader = lease.stream(branch).getReader();
      try {
        if (mode === "error") {
          f.lifetime.retire();
          await assertRejects(
            () => reader.read(),
            OwnershipError,
            "Owner is retired",
          );
        } else await reader.cancel("stop");
        assertEquals([branch.locked, peer.locked, cancellations], [
          false,
          false,
          [],
        ]);
        const error = await assertRejects(
          () => peer.cancel("peer done"),
          Error,
          "G3 source cleanup failed",
        );
        assertStrictEquals(error, cleanupError);
        assertEquals(cancellations.length, 1);
        const reasons = cancellations[0] as unknown[];
        assertEquals(reasons[1], "peer done");
        if (mode === "cancel") assertEquals(reasons[0], "stop");
        else assertEquals((reasons[0] as Error).message, "Owner is retired");
      } finally {
        reader.releaseLock();
      }
    }));
}

const service =
  `let messages=[];addEventListener('message',({data})=>{if(data.type==='rpcResponse')messages.push(data);});
export function activate(ctx){ctx.commands.register({id:'read',label:'Read',target:'server'},async()=>await ctx.readNote('private'));ctx.commands.register({id:'detach',label:'Detach',target:'server'},()=>{ctx.readNote('private').catch(()=>{});return 'detached';});ctx.commands.register({id:'seen',label:'Seen',target:'server'},()=>messages);}`;
for (
  const change of [
    "unchanged",
    "generation",
    "context",
    "source",
    "source-getter",
    "getter",
    "selector",
  ] as const
) {
  Deno.test(`G3 RPC: ${change} at queued disclosure observes the captured Worker consumer`, () =>
    withPluginFixture(async (fixture, scope) => {
      let authority: RpcAuthority | undefined;
      const callbacks: string[] = [];
      const posts: unknown[] = [];
      const requests: { id: number; method: string; args: unknown[] }[] = [];
      const nativeWorker = globalThis.Worker;
      const dir = await fixture.install("g3-rpc", {
        runtime: { server: "service.js" },
      }, { "service.js": service });
      const released = fixtureGate(scope);
      const prepared = fixtureGate(scope);
      const observed = fixtureGate(scope);
      // Observe actual native posting; restore the constructor before asynchronous work.
      globalThis.Worker = new Proxy(nativeWorker, {
        construct(target, args, newTarget) {
          const worker = Reflect.construct(target, args, newTarget) as Worker;
          worker.addEventListener("message", ({ data }) => {
            if (data.type === "rpc") {
              requests.push({
                id: data.id,
                method: data.method,
                args: data.args,
              });
            }
          });
          const post = worker.postMessage.bind(worker);
          worker.postMessage = (message: HostMessage) => {
            if (message.type === "rpcResponse") posts.push(message);
            post(message);
          };
          return worker;
        },
      });
      let host!: PluginHost;
      try {
        host = new PluginHost(
          readManifest(dir),
          fixture.vault,
          async (_method, _args, admitted) => {
            authority = admitted!;
            const handle = authority.prepareDisclosure!(() => {
              callbacks.push("prepare");
              if (change === "selector") host.stop();
              return {
                get content() {
                  callbacks.push("serialize");
                  if (change === "getter") host.stop();
                  if (change === "source-getter") {
                    Object.defineProperty(authority!.source!, "revision", {
                      get() {
                        host.stop();
                        return 1;
                      },
                    });
                  }
                  if (change === "source") {
                    authority!.source!.revision++;
                    // Close only after this exact synchronous post turn, not by deadline.
                    queueMicrotask(() => host.stop());
                  }
                  return "private bytes";
                },
              };
            });
            authority.disclose!(handle);
            prepared.resolve();
            await released.promise;
            observed.resolve();
            return null;
          },
          1,
          {
            role: "service",
            source: {
              key: "source",
              revision: 1,
              settingsRevision: 1,
              codeFingerprint: "code",
            },
          },
        );
        scope.defer(() => host.stop());
        const start = host.start();
        globalThis.Worker = nativeWorker;
        await start;
        const handler = (id: string) =>
          [...host.registrations].find(([, item]) => item.id === id)![0];
        await heldOperation({
          label: "G3 queued RPC",
          progress: { kind: "product" },
          owner: () => host,
        }, (hold) => {
          return fixture.admit(async () => {
            const running = host.invoke(
              handler(change === "context" ? "detach" : "read"),
              [],
            );
            running.catch(() => {});
            await prepared.promise;
            if (change === "context") assertEquals(await running, "detached");
            await hold();
            released.resolve();
            return await running;
          });
        }, async (operation) => {
          await operation.reached();
          assertEquals([callbacks, posts], [[], []]);
          if (change === "generation") host.stop();
          if (change === "unchanged" || change === "context") {
            assertEquals(
              (await operation.result()).value,
              change === "context" ? "detached" : { content: "private bytes" },
            );
            await observed.promise;
            const messages = await host.invoke(
              handler("seen"),
              [],
            ) as unknown[];
            assertEquals(messages, posts);
            assertEquals(
              requests.map(({ method, args }) => ({ method, args })),
              [{ method: "readNote", args: ["private"] }],
            );
            assertEquals(
              posts,
              change === "context" ? [] : [{
                type: "rpcResponse",
                generation: authority!.generation,
                id: requests[0].id,
                ok: true,
                value: { content: "private bytes" },
                receiptRequired: false,
              }],
            );
            assertEquals(
              callbacks,
              change === "context" ? [] : ["prepare", "serialize"],
            );
          } else {
            await assertRejects(
              () => operation.result(),
              Error,
              "plugin host stopped",
            );
            // Join the actual host RPC preparation, even if invocation retirement was earlier.
            await observed.promise;
            assertEquals(posts, []);
            assertEquals(
              callbacks,
              ["getter", "selector", "source", "source-getter"].includes(change)
                ? ["prepare", "serialize"]
                : [],
            );
          }
        });
      } finally {
        globalThis.Worker = nativeWorker;
        released.resolve();
        host?.stop();
      }
    }));
}

Deno.test("G3 RPC: handle provenance rejects callbacks, null, clones and foreign children without invoking them", () =>
  withPluginFixture(async (fixture, scope) => {
    const dir = await fixture.install("g3-provenance", {
      runtime: { server: "service.js" },
    }, { "service.js": service });
    let saved: PreparedAuthorityRead<unknown> | undefined;
    let attempt = "current", entries = 0;
    const host = new PluginHost(
      readManifest(dir),
      fixture.vault,
      (_method, _args, authority) => {
        const handle = authority!.prepareDisclosure!(() => {
          entries++;
          return { content: "allowed" };
        });
        const supplied = attempt === "current"
          ? handle
          : attempt === "foreign"
          ? saved
          : attempt === "clone"
          ? { ...handle }
          : attempt === "null"
          ? null
          : () => {
            entries++;
            return "leak";
          };
        authority!.disclose!(supplied as PreparedAuthorityRead<unknown>);
        saved = handle;
        return Promise.resolve({
          content: "unsealed fallback must not escape",
        });
      },
      1,
      { role: "service" },
    );
    scope.defer(() => host.stop());
    await host.start();
    const handler = [...host.registrations].find(([, item]) =>
      item.id === "read"
    )![0];
    assertEquals(await host.invoke(handler, []), { content: "allowed" });
    for (const invalid of ["foreign", "clone", "null", "callback"]) {
      attempt = invalid;
      await assertRejects(
        () => host.invoke(handler, []),
        Error,
        "plugin handler failed",
      );
    }
    assertEquals(entries, 1);
    attempt = "current";
    assertEquals(await host.invoke(handler, []), { content: "allowed" });
    assertEquals(entries, 2);
    const inspect = [...host.registrations].find(([, item]) =>
      item.id === "seen"
    )![0];
    const messages = await host.invoke(inspect, []) as {
      ok: boolean;
      value: unknown;
    }[];
    assertEquals(messages.map(({ ok, value }) => ({ ok, value })), [
      { ok: true, value: { content: "allowed" } },
      ...["foreign", "clone", "null", "callback"].map(() => ({
        ok: false,
        value: "Disclosure requires this operation's prepared read",
      })),
      { ok: true, value: { content: "allowed" } },
    ]);
  }));

Deno.test("G3 instance: replacing one composition leaves an unrelated instance disclosure current", () =>
  fixture(async (f) => {
    const otherParent = createOperationLease("live", [() => {}]);
    f.scope.onCancel(() => otherParent.retire());
    const otherAuthority = new InstanceAuthority(
      f.sessions,
      () => null,
      otherParent.lease,
    );
    const other = otherAuthority.instanceLease(GUEST, "readInstance");
    const own = f.authority.instanceLease(GUEST, "readInstance");
    const accepted = other.prepare({ status: "unrelated" });
    const refused = new Response(own.body(own.prepare({ status: "retired" })));
    f.lifetime.retire();
    await assertRejects(
      () => refused.json(),
      OwnershipError,
      "Owner is retired",
    );
    assertEquals(await new Response(other.body(accepted)).json(), {
      status: "unrelated",
    });
  }));

Deno.test("G3 instance: credential facts are captured before the validation microtask", () =>
  fixture(async (f) => {
    const request = f.request();
    const pending = f.auth.instanceLease(request, "manageOwnAccount");
    request.headers.set("authorization", "Bearer replacement-invalid");
    const lease = await pending;
    assertEquals(
      await new Response(lease.body(lease.prepare({ login: "alice" }))).json(),
      { login: "alice" },
    );
  }));
