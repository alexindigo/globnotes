// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { createIdentityPluginEvents } from "../server/plugins/identity_events.ts";
import { createIdentityVaultChanges } from "../server/hub/identity_changes.ts";
import type { IdentityStreamAccess } from "../server/auth/composition.ts";
import { AclRepository } from "../server/auth/acl.ts";
import { InstanceSessions } from "../server/auth/sessions.ts";
import type { DriverSupervisor } from "../server/hub/drivers/supervisor.ts";
import {
  PLUGIN_CONTRACT_VERSION,
  PLUGIN_LIMITS,
} from "../server/plugins/contracts.ts";
import { validateSettingsPages } from "../server/plugins/settings.ts";
import { fixturePage } from "./helpers/plugin_fixture.ts";
import { OperationError } from "../server/plugins/errors.ts";
import { OwnershipError } from "../shared/ownership.js";
import {
  pathfinderRequest,
  streamProbe,
  withIdentityComposition,
} from "./helpers/identity_scope.ts";
import { resetFixturePassword } from "./helpers/account_preparation.ts";
import { VAULT_B } from "./helpers/identity.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { bounded } from "./helpers/worker_liveness.ts";

type Scope = Parameters<Parameters<typeof withIdentityComposition>[0]>[0];
type Surface = "plugins" | "vault";
const NEXT_UPDATE = "00000000-0000-4000-8000-000000000017";
const CHANGED =
  "Access policy changed while this operation was pending; it was not applied.";

function handler(
  f: Scope,
  surface: Surface,
  admit: (request: Request) => Promise<IdentityStreamAccess> =
    f.composition.streamAccess,
  services: Partial<Scope["services"]> & { drivers?(): DriverSupervisor } = {},
) {
  return surface === "plugins"
    ? createIdentityPluginEvents(admit)
    : createIdentityVaultChanges(admit, { ...f.services, ...services });
}
/** Parsed SSE frames in one delivered chunk. */
async function frames(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  if (result.done) return "done";
  return new TextDecoder().decode(result.value).split("\n\n").filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "));
      const data = lines.find((line) => line.startsWith("data: "));
      return event
        ? [event.slice(7), data ? JSON.parse(data.slice(6)) : null]
        : [block, null];
    });
}
const firstFrame = (surface: Surface) =>
  surface === "plugins" ? "hello" : "conflicts";

for (const surface of ["plugins", "vault"] as const) {
  Deno.test(`identity streams: ${surface} request aborted before admission subscribes nothing`, () =>
    withIdentityComposition(async (f) => {
      f.policy("view");
      const probe = streamProbe(f.scope, f.composition.streamAccess);
      const abort = new AbortController();
      abort.abort();
      const raw = f.request("", undefined, abort.signal);
      const error = await assertRejects(
        () => handler(f, surface, probe.admit)(pathfinderRequest(raw)),
        DOMException,
      );
      assertEquals([error.name, probe.subscriptions, probe.active], [
        "AbortError",
        0,
        0,
      ]);
    }));

  Deno.test(`identity streams: ${surface} request aborted after admission never registers listeners`, () =>
    withIdentityComposition(async (f) => {
      f.policy("view");
      const abort = new AbortController();
      const probe = streamProbe(
        f.scope,
        f.composition.streamAccess,
        () => abort.abort(),
      );
      const raw = f.request("", undefined, abort.signal);
      const error = await assertRejects(
        () => handler(f, surface, probe.admit)(pathfinderRequest(raw)),
        DOMException,
      );
      assertEquals([error.name, probe.subscriptions, probe.active], [
        "AbortError",
        0,
        0,
      ]);
    }));

  Deno.test(`identity streams: ${surface} abort while streaming releases listeners and ends the consumer`, () =>
    withIdentityComposition(async (f) => {
      f.policy("view");
      const probe = streamProbe(f.scope, f.composition.streamAccess);
      const abort = new AbortController();
      const raw = f.request("", undefined, abort.signal);
      const reader = (await handler(f, surface, probe.admit)(
        pathfinderRequest(raw),
      )).body!.getReader();
      const first = await frames(reader);
      assertEquals(first === "done" ? first : first[0][0], firstFrame(surface));
      assertEquals([probe.subscriptions, probe.active], [1, 1]);
      abort.abort();
      await bounded(probe.idle(), `${surface} abort listener release`);
      const error = await assertRejects(() => reader.read(), DOMException);
      assertEquals([error.name, probe.active], ["AbortError", 0]);
    }));

  Deno.test(`identity streams: ${surface} queued data cannot disclose after demotion`, () =>
    withIdentityComposition(async (f) => {
      f.policy("view");
      const probe = streamProbe(f.scope, f.composition.streamAccess);
      const response = await handler(f, surface, probe.admit)(
        pathfinderRequest(f.request()),
      );
      f.policy("none");
      await bounded(probe.idle(), `${surface} demotion listener release`);
      const reader = response.body!.getReader();
      const error = await assertRejects(
        () => reader.read(),
        OperationError,
        CHANGED,
      );
      assertEquals(error.status, 409);
      assertEquals(f.operations.runtime.status("projection")?.status, "ready");
    }));

  Deno.test(`identity streams: ${surface} lifecycle epoch retirement releases idle listeners`, () =>
    withIdentityComposition(async (f) => {
      f.policy("view");
      const probe = streamProbe(f.scope, f.composition.streamAccess);
      const reader = (await handler(f, surface, probe.admit)(
        pathfinderRequest(f.request()),
      )).body!.getReader();
      const first = await frames(reader);
      assertEquals(first === "done" ? first : first[0][0], firstFrame(surface));
      f.operations.lifecycle.bumpEpoch();
      await bounded(probe.idle(), `${surface} epoch listener release`);
      await assertRejects(() => reader.read(), OperationError, CHANGED);
    }));

  Deno.test(`identity streams: ${surface} retired composition lifetime fences delivery`, () =>
    withIdentityComposition(async (f) => {
      f.policy("view");
      const response = await handler(f, surface)(
        pathfinderRequest(f.request()),
      );
      f.lifetime.retire();
      const reader = response.body!.getReader();
      await assertRejects(
        () => reader.read(),
        OwnershipError,
        "Owner is retired",
      );
    }));
}

Deno.test("identity streams: only the affected account or concrete vault retires a subscription", () =>
  withIdentityComposition(async (f) => {
    f.policy("view");
    const alice = streamProbe(f.scope, f.composition.streamAccess);
    const bob = streamProbe(f.scope, f.composition.streamAccess);
    const a = (await createIdentityPluginEvents(alice.admit)(
      pathfinderRequest(f.request()),
    )).body!.getReader();
    const b = (await createIdentityPluginEvents(bob.admit)(
      pathfinderRequest(f.request("", f.other.access_token)),
    )).body!.getReader();
    const events = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const result = await frames(reader);
      return result === "done" ? result : result.map(([event]) => event);
    };
    assertEquals([await events(a), await events(b)], [["hello"], ["hello"]]);
    const otherVault = new AclRepository(
      `${f.fixture.root}/other-vault`,
      VAULT_B,
      { accounts: f.accounts },
    );
    otherVault.prepareParents();
    otherVault.initializeForCreator(f.alice, "none");
    f.operations.lifecycle.notifyInvalidation("catalog");
    assertEquals([await events(a), await events(b)], [["invalidate"], [
      "invalidate",
    ]]);
    await resetFixturePassword(
      f.accounts,
      f.alice.id,
      "replacement",
      NEXT_UPDATE,
    );
    await bounded(alice.idle(), "affected account listener release");
    const retired = await assertRejects(() => a.read(), HttpError, "HTTP 401");
    assertEquals(
      [retired.status, retired.detail, alice.active, bob.active],
      [
        401,
        "Invalid authentication credentials.",
        0,
        1,
      ],
    );
    f.operations.lifecycle.notifyInvalidation("catalog");
    assertEquals(await events(b), ["invalidate"]);
    await b.cancel();
    await bounded(bob.idle(), "cancelled listener release");
    assertEquals(f.operations.runtime.status("projection")?.status, "ready");
  }));

Deno.test("identity streams: View omits administrative domains while file, conflict and driver cursors stay distinct", () =>
  withIdentityComposition(async (f) => {
    const driverListeners = new Set<(revision: number) => void>();
    let revisionReads = 0;
    const drivers = {
      revision: () => {
        revisionReads++;
        return 17;
      },
      subscribe(listener: (revision: number) => void) {
        driverListeners.add(listener);
        return () => {
          driverListeners.delete(listener);
        };
      },
    } as DriverSupervisor;
    f.policy("view");
    const events = (await createIdentityPluginEvents(
      f.composition.streamAccess,
    )(pathfinderRequest(f.request()))).body!.getReader();
    await frames(events);
    const next = frames(events);
    f.operations.lifecycle.notifyInvalidation("settings");
    f.operations.lifecycle.notifyInvalidation("drivers");
    f.operations.lifecycle.notifyInvalidation("catalog");
    const visible = await next;
    assertEquals(
      visible === "done"
        ? visible
        : visible.map(([event, data]) => [event, data.domain]),
      [["invalidate", "catalog"]],
    );
    await events.cancel();
    const probe = streamProbe(f.scope, f.composition.streamAccess);
    const changes = handler(f, "vault", probe.admit, {
      drivers: () => drivers,
    });
    assertEquals(
      await (await changes(pathfinderRequest(f.request("?poll=1")))).json(),
      { entries: [], next: 0, conflictRevision: 0 },
    );
    const reader = (await changes(pathfinderRequest(f.request()))).body!
      .getReader();
    assertEquals(await frames(reader), [["conflicts", { revision: 0 }]]);
    assertEquals([driverListeners.size, revisionReads], [0, 0]);
    await reader.cancel();
    await bounded(probe.idle(), "reader listener release");
    f.policy("admin");
    assertEquals(
      await (await changes(pathfinderRequest(f.request("?poll=1")))).json(),
      { entries: [], next: 0, conflictRevision: 0, driverRevision: 17 },
    );
    const admin = (await changes(pathfinderRequest(f.request()))).body!
      .getReader();
    assertEquals(await frames(admin), [["conflicts", { revision: 0 }]]);
    assertEquals(await frames(admin), [["drivers", { revision: 17 }]]);
    assertEquals(driverListeners.size, 1);
    await admin.cancel();
    await bounded(probe.idle(), "admin listener release");
    assertEquals(driverListeners.size, 0);
  }));

Deno.test("identity streams: an idle plugin reader receives only one pending invalidation per domain", () =>
  withIdentityComposition(async (f) => {
    f.policy("admin");
    const reader = (await handler(f, "plugins")(
      pathfinderRequest(f.request()),
    )).body!.getReader();
    f.scope.defer(() => reader.cancel());
    assertEquals(await frames(reader), [["hello", {
      contractVersion: PLUGIN_CONTRACT_VERSION,
      heartbeatMs: PLUGIN_LIMITS.streamHeartbeatMs,
    }]]);
    for (const domain of ["catalog", "catalog", "settings"] as const) {
      f.operations.lifecycle.notifyInvalidation(domain);
    }
    const pending = [];
    for (let i = 0; i < 2; i++) {
      const next = await bounded(frames(reader), "coalesced invalidation");
      pending.push(
        next === "done"
          ? next
          : next.map(([event, data]) => [event, data.domain]),
      );
    }
    assertEquals(pending, [[["invalidate", "catalog"]], [[
      "invalidate",
      "settings",
    ]]]);
  }));

Deno.test("identity streams: settings commit invalidates Admin once but not View", () =>
  withIdentityComposition(async (f) => {
    f.policy("admin", "view");
    const open = async (token: string) => {
      const reader = (await handler(f, "plugins")(
        pathfinderRequest(f.request("", token)),
      )).body!.getReader();
      f.scope.defer(() => reader.cancel());
      await frames(reader);
      return reader;
    };
    const [admin, view] = await Promise.all([
      open(f.token.access_token),
      open(f.other.access_token),
    ]);
    const domains: string[] = [];
    f.scope.defer(
      f.operations.lifecycle.subscribeInvalidation((domain) =>
        domains.push(domain)
      ),
    );
    const page = validateSettingsPages([fixturePage])[0];
    const store = f.operations.data.forPlugin("projection");
    const before = await store.page(page);
    const committed = await store.savePage(
      page,
      before.values,
      before.revision,
      before.sourceKey,
    );
    assertEquals([committed.revision, domains], [before.revision + 1, [
      "settings",
    ]]);
    const readDomains = async (reader: typeof admin) => {
      const result = await bounded(frames(reader), "settings invalidation");
      return result === "done"
        ? result
        : result.map(([event, data]) => [event, data.domain]);
    };
    assertEquals(await readDomains(admin), [["invalidate", "settings"]]);
    f.operations.lifecycle.notifyInvalidation("catalog");
    assertEquals(await readDomains(view), [["invalidate", "catalog"]]);
  }));

Deno.test("identity streams: a slow reader resets when the hub has retired its cursor", () =>
  withIdentityComposition(async (f) => {
    f.policy("view");
    const reader = (await handler(f, "vault")(
      pathfinderRequest(f.request()),
    )).body!.getReader();
    f.scope.defer(() => reader.cancel());
    assertEquals(await frames(reader), [["conflicts", { revision: 0 }]]);
    const { hub } = f.operations;
    for (const name of ["first", "next", "latest"]) {
      Deno.writeTextFileSync(`${f.fixture.vault}/${name}.md`, name);
      hub.scanNow();
    }
    assertEquals([hub.changesSince(0).gap, hub.sequence()], [true, 3]);
    assertEquals(await bounded(frames(reader), "compaction reset"), [["reset", {
      next: 3,
    }]]);
    Deno.writeTextFileSync(`${f.fixture.vault}/resumed.md`, "resumed");
    hub.scanNow();
    const resumed = await bounded(frames(reader), "change after reset");
    assertEquals(
      resumed === "done"
        ? resumed
        : resumed.map(([event, data]) => [event, data.seq, data.path]),
      [["change", 4, "resumed.md"]],
    );
  }, { changeLimit: 2 }));

Deno.test("identity streams: a live deletion retains its path; durable replay resets", () =>
  withIdentityComposition(async (f) => {
    f.policy("view");
    const changes = handler(f, "vault");
    const reader = (await changes(pathfinderRequest(f.request()))).body!
      .getReader();
    f.scope.defer(() => reader.cancel());
    assertEquals(await frames(reader), [["conflicts", { revision: 0 }]]);
    const names = ["a.md", "b.md"];
    for (const path of names) {
      Deno.writeTextFileSync(`${f.fixture.vault}/${path}`, path);
    }
    f.operations.hub.scanNow();
    const observe = async () => {
      const next = await bounded(frames(reader), "live change frame");
      return next === "done"
        ? next
        : next.map(([event, data]) => [event, data.seq, data.path, data.kind]);
    };
    assertEquals([await observe(), await observe()], [[[
      "change",
      1,
      "a.md",
      "created",
    ]], [["change", 2, "b.md", "created"]]]);
    Deno.removeSync(`${f.fixture.vault}/a.md`);
    f.operations.hub.scanNow();
    assertEquals(await observe(), [["change", 3, "a.md", "deleted"]]);
    assertEquals(
      await (await changes(pathfinderRequest(f.request("?poll=1&since=2"))))
        .json(),
      { gap: true, next: 3, conflictRevision: 0 },
    );
  }));

Deno.test("identity streams: a stream for another vault is refused before any listener", () =>
  withIdentityComposition(async (f) => {
    f.policy("view");
    const probe = streamProbe(f.scope, f.composition.streamAccess);
    const error = await assertRejects(
      () =>
        handler(f, "vault", probe.admit, { vaultId: VAULT_B })(
          pathfinderRequest(f.request()),
        ),
      HttpError,
      "HTTP 404",
    );
    assertEquals([error.status, error.detail, probe.subscriptions], [
      404,
      "Vault unavailable.",
      0,
    ]);
  }));

Deno.test("identity streams: session expiry timer retires an idle stream and its listeners", () =>
  withIdentityComposition(async (f) => {
    f.policy("view");
    const short = new InstanceSessions(f.accounts, f.signing, {
      expirySeconds: 2,
    });
    const token = await signIn(short, {
      username: "alice",
      password: "password",
    });
    const probe = streamProbe(f.scope, f.composition.streamAccess);
    const reader = (await createIdentityPluginEvents(probe.admit)(
      pathfinderRequest(f.request("", token.access_token)),
    )).body!.getReader();
    const hello = await frames(reader);
    assertEquals(hello === "done" ? hello : hello[0][0], "hello");
    await bounded(probe.idle(), "expiry listener release");
    const error = await assertRejects(
      () => reader.read(),
      HttpError,
      "HTTP 401",
    );
    assertEquals([error.status, error.detail, probe.active], [
      401,
      "Invalid authentication credentials.",
      0,
    ]);
  }));
