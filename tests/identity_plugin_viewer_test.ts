// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { InstanceAuthority } from "../server/auth/authority.ts";
import type { AuthorityReadContext } from "../server/auth/authority_context.ts";
import { createInstanceAuth } from "../server/auth/middleware.ts";
import {
  PluginHost,
  VIEWER_CONTINUATION_LIMIT,
} from "../server/plugins/host.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { PluginEndpoints } from "../server/plugins/endpoints.ts";
import { createIdentityPluginProxy } from "../server/plugins/proxy.ts";
import { withPluginOperationsFixture } from "./helpers/plugin_operations_fixture.ts";
import { withPluginFixture } from "./helpers/plugin_fixture.ts";
import { credentialCommandFixture } from "./helpers/credential_commands.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { ACCOUNT_A, UPDATE, VAULT_A } from "./helpers/identity.ts";
import { AclRepository } from "../server/auth/acl.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import { hostInitialized } from "./helpers/product_settlement.ts";
import { state } from "../server/state.ts";
import { createIdentityNoteRender } from "../server/api/endpoints/_/api/render/%23...path/get.ts";
import { createIdentityRender } from "../server/api/endpoints/_/api/render/post.ts";
import { createIdentityPluginCommand } from "../server/api/endpoints/_/api/plugin-host/%23id/commands/%23command/post.ts";
import { OperationError } from "../server/plugins/errors.ts";

const source =
  `let status=Promise.withResolvers();export function activate(ctx){
  ctx.commands.register({id:'echo',label:'Echo',target:'server'},payload=>payload);
  ctx.commands.register({id:'timer',label:'Timer',target:'server'},()=>{
    status=Promise.withResolvers();ctx.timers.setTimeout(async()=>{try{await ctx.readNote('gate');
      const receipt=await ctx.actions.request('create',{path:'viewer-output',content:'live-edit',base:{kind:'absent'}});
      status.resolve({status:'accepted',requestId:receipt.requestId});}catch{status.resolve({status:'denied'});}},0);return 'armed';});
  ctx.commands.register({id:'direct',label:'Direct',target:'server'},()=>ctx.actions.request('create',{path:'direct-output',content:'deferred',base:{kind:'absent'}}));
  ctx.commands.register({id:'background',label:'Background',target:'server'},()=>ctx.actions.request('create',{path:'background-output',content:'independent',base:{kind:'absent'}}));
  ctx.commands.register({id:'private-write',label:'Private',target:'server'},()=>ctx.data.save({value:'private'},0));
  ctx.commands.register({id:'status',label:'Status',target:'server'},()=>status.promise);
  ctx.commands.register({id:'settle-action',label:'Settle action',target:'server'},async id=>{for(;;){const receipt=await ctx.actions.result(id);if(!['accepted','running'].includes(receipt.status))return receipt;await new Promise(resolve=>ctx.timers.setTimeout(resolve,0));}});
}`;

async function withViewer(run: (f: ViewerFixture) => Promise<void>) {
  let hold: (() => Promise<void>) | undefined;
  await withPluginOperationsFixture({
    id: "viewer",
    manifest: {
      runtime: { server: "service.js" },
      capabilities: { read: ["vault"], write: ["vault"] },
    },
    files: {
      "service.js": source,
      "endpoints/get.js":
        `export default async function(request,ctx){let outcome,requestId;try{requestId=(await ctx.actions.request('create',{path:'endpoint-output',content:'endpoint-live-edit',base:{kind:'absent'}})).requestId;outcome='accepted';}catch{outcome='denied';}return {outcome,requestId,headers:request.headers,snapshot:ctx.snapshot};}`,
    },
    fault: async (method, args, boundary) => {
      if (
        method === "readNote" && args[0] === "gate" && boundary === "before"
      ) await hold?.();
    },
  }, async (f) => {
    await credentialCommandFixture(async (identity) => {
      const lifetime = createOperationLease("live", [() => {}]);
      f.scope.onCancel(lifetime.retire);
      Deno.writeTextFileSync(
        `${f.fixture.vault}/gate.md`,
        "timer hold fixture",
      );
      const token = await signIn(identity.sessions, {
        username: "alice",
        password: "password",
      });
      const acl = new AclRepository(f.fixture.statePath, VAULT_A, {
        accounts: identity.accounts,
      });
      acl.initializeForCreator(identity.accounts.byId(ACCOUNT_A)!, "none");
      const lifecycle = {
        get epoch() {
          return f.lifecycle.epoch;
        },
        operational: (context: AuthorityReadContext) =>
          f.lifecycle.operational() &&
          context.accounts(identity.accounts).value.initialized &&
          context.signing(identity.sessions.signing).initialized,
      };
      let vault = { identity: {}, id: VAULT_A, acl, lifecycle };
      const authority = new InstanceAuthority(
        identity.sessions,
        () => ({ ...vault }),
        lifetime.lease,
      );
      const viewer = authority.viewer(token.principal);
      const auth = createInstanceAuth({
        sessions: identity.sessions,
        vault: () => ({ ...vault }),
        cookieName: "fixture",
        lifetime: () => lifetime.lease,
      });
      await run({
        ...f,
        token,
        identity,
        viewer,
        authority,
        auth,
        lifetime,
        replace: () => {
          vault = { ...vault, identity: {} };
        },
        hold: (value) => {
          hold = value;
        },
        policy: (level) =>
          acl.save(
            { everybody: "none", grants: { [ACCOUNT_A]: level } },
            acl.capture(),
            { updateId: UPDATE, actorId: ACCOUNT_A },
          ),
        commandAsViewer: (command) =>
          f.runtime.invokeCommand(f.id, command, {}, viewer),
      });
    });
  });
}
type PluginFixture = Parameters<
  Parameters<typeof withPluginOperationsFixture>[1]
>[0];
type IdentityFixture = Parameters<
  Parameters<typeof credentialCommandFixture>[0]
>[0];
type ViewerFixture = PluginFixture & {
  token: Awaited<ReturnType<typeof signIn>>;
  identity: IdentityFixture;
  viewer: ReturnType<InstanceAuthority["viewer"]>;
  authority: InstanceAuthority;
  auth: ReturnType<typeof createInstanceAuth>;
  lifetime: ReturnType<typeof createOperationLease<"live">>;
  replace(): void;
  hold(value: () => Promise<void>): void;
  policy(level: "view" | "edit" | "admin" | "none"): unknown;
  commandAsViewer(command: string): Promise<unknown>;
};
function absent(filename: string): boolean {
  try {
    Deno.statSync(filename);
    return false;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
}

for (
  const outcome of [
    "edit",
    "view",
    "demoted",
    "expired",
    "credentials",
  ] as const
) {
  Deno.test(`identity viewer: post-return timer ${outcome}, final bytes and independent background`, () =>
    withViewer(async (f) => {
      f.policy(outcome === "view" ? "view" : "edit");
      await heldOperation({
        label: "viewer timer read",
        owner: () => f.runtime,
        progress: { kind: "product" },
        signal: f.scope.signal,
      }, async (hold) => {
        f.hold(hold);
        assertEquals(await f.commandAsViewer("timer"), "armed");
        return await f.command("status");
      }, async (operation) => {
        await operation.reached();
        if (outcome === "demoted") f.policy("view");
        if (outcome === "expired") f.identity.now = f.token.principal.expiresAt;
        if (outcome === "credentials") {
          await f.identity.accounts.credentials.changeOwn(
            f.identity.bound(),
            f.identity.request({ newPassword: "changed" }),
          );
        }
        const status = await operation.result() as {
          status: string;
          requestId?: string;
        };
        assertEquals(status.status, outcome === "edit" ? "accepted" : "denied");
        if (outcome === "edit") {
          const receipt = await f.command(
            "settle-action",
            status.requestId,
          ) as { status: string; requestId: string; result: unknown };
          assertEquals([receipt.status, receipt.requestId], [
            "completed",
            status.requestId,
          ]);
          assertEquals(
            Deno.readTextFileSync(`${f.fixture.vault}/viewer-output.md`),
            "live-edit",
          );
        } else {assertEquals(
            absent(`${f.fixture.vault}/viewer-output.md`),
            true,
          );}
      });
      const receipt = await f.command("background") as { requestId: string };
      const completed = await f.command("settle-action", receipt.requestId) as {
        status: string;
        requestId: string;
      };
      assertEquals([completed.status, completed.requestId], [
        "completed",
        receipt.requestId,
      ]);
      assertEquals(
        Deno.readTextFileSync(`${f.fixture.vault}/background-output.md`),
        "independent",
      );
    }));
}

Deno.test("identity viewer: deferred action survives return and Edit cannot write private settings", () =>
  withViewer(async (f) => {
    f.policy("edit");
    await f.command("private-write");
    const filename = `${f.fixture.statePath}/plugin-data/${f.id}/data.json`;
    const bytes = Deno.readFileSync(filename);
    const before = await f.data.forPlugin(f.id).load();
    await assertRejects(
      () => f.commandAsViewer("private-write"),
      Error,
      "plugin handler failed",
    );
    assertEquals(await f.data.forPlugin(f.id).load(), before);
    assertEquals(Deno.readFileSync(filename), bytes);
    const receipt = await f.commandAsViewer("direct") as { requestId: string };
    const completed = await f.command("settle-action", receipt.requestId) as {
      status: string;
      requestId: string;
    };
    assertEquals([completed.status, completed.requestId], [
      "completed",
      receipt.requestId,
    ]);
    assertEquals(
      Deno.readTextFileSync(`${f.fixture.vault}/direct-output.md`),
      "deferred",
    );
  }));

Deno.test("identity viewer: GET proxy captures caller and Worker envelopes contain no identity", () =>
  withViewer(async (f) => {
    const previous = state.pluginEndpoints;
    f.scope.defer(() => {
      state.pluginEndpoints = previous;
    });
    state.pluginEndpoints = new PluginEndpoints(() => f.runtime);
    const proxy = createIdentityPluginProxy(f.auth);
    const request = () => {
      const raw = new Request("http://fixture/_/api/plugins/viewer/", {
        headers: {
          authorization: `Bearer ${f.token.access_token}`,
          cookie: "secret-cookie",
        },
      });
      return {
        method: "GET",
        params: { id: f.id },
        query: new URLSearchParams(),
        headers: raw.headers,
        _raw: raw,
        body: { stream: null },
      };
    };
    f.policy("view");
    const denied = await (await proxy(request())).json();
    assertEquals(denied, {
      outcome: "denied",
      headers: [],
      snapshot: {
        changesApiVersion: 1,
        contractVersion: 2,
        pluginId: "viewer",
      },
    });
    assertEquals(absent(`${f.fixture.vault}/endpoint-output.md`), true);
    assertEquals([
      JSON.stringify(denied).includes(f.token.access_token),
      JSON.stringify(denied).includes(ACCOUNT_A),
    ], [false, false]);
    f.policy("edit");
    const accepted = await (await proxy(request())).json();
    assertEquals([accepted.outcome, accepted.headers], ["accepted", []]);
    const completed = await f.command("settle-action", accepted.requestId) as {
      status: string;
      requestId: string;
    };
    assertEquals([completed.status, completed.requestId], [
      "completed",
      accepted.requestId,
    ]);
    assertEquals(
      Deno.readTextFileSync(`${f.fixture.vault}/endpoint-output.md`),
      "endpoint-live-edit",
    );
  }));

Deno.test("identity viewer: fresh bundle projections, replacement and prepared render consumption", () =>
  withViewer(async (f) => {
    f.policy("edit");
    f.viewer.assertCurrent("editNotes");
    assertEquals(f.viewer.sessionCurrent(), true);
    const raw = new Request("http://fixture/_/api/render/gate", {
      headers: { authorization: `Bearer ${f.token.access_token}` },
    });
    const response = await createIdentityNoteRender(f.auth)(
      {
        _raw: raw,
        params: { path: "gate" },
        query: new URLSearchParams(),
      } as PathfinderRequest<{ path: string }>,
    );
    f.identity.now = f.token.principal.expiresAt;
    const error = await assertRejects(
      () => response.text(),
      HttpError,
      "HTTP 401",
    );
    assertEquals([error.status, error.detail], [
      401,
      "Invalid authentication credentials.",
    ]);
    assertEquals(f.viewer.sessionCurrent(), false);
  }));

for (const caller of ["render-post", "command"] as const) {
  Deno.test(`identity viewer: ${caller} preserves its complete response and fences late consumption`, () =>
    withViewer(async (f) => {
      f.policy("view");
      const invoke = () => {
        const raw = new Request(`http://fixture/_/api/${caller}`, {
          method: "POST",
          headers: { authorization: `Bearer ${f.token.access_token}` },
        });
        const request = {
          _raw: raw,
          params: { id: f.id, command: "echo" },
          query: new URLSearchParams(),
          body: {
            text: () => Promise.resolve("unsaved buffer"),
            json: () => Promise.resolve({ message: "viewer echo" }),
          },
        } as unknown as PathfinderRequest;
        return caller === "render-post"
          ? createIdentityRender(f.auth)(request)
          : createIdentityPluginCommand(f.auth, f.runtime)(request);
      };
      const response = await invoke();
      assertEquals(
        [
          response.status,
          response.headers.get("content-type"),
          caller === "render-post"
            ? await response.text()
            : await response.json(),
        ],
        caller === "render-post"
          ? [
            200,
            "text/html; charset=utf-8",
            '<p data-source-line="0" data-line="L1">unsaved buffer</p>\n',
          ]
          : [200, "application/json", { result: { message: "viewer echo" } }],
      );
      const stale = await invoke();
      f.identity.now = f.token.principal.expiresAt;
      const error = await assertRejects(
        () => stale.text(),
        HttpError,
        "HTTP 401",
      );
      assertEquals([error.status, error.detail], [
        401,
        "Invalid authentication credentials.",
      ]);
    }));
}

Deno.test("identity viewer: concrete bundle replacement retires its retained reference", () =>
  withViewer(async (f) => {
    f.viewer.assertCurrent();
    f.replace();
    assertEquals(f.viewer.sessionCurrent(), false);
    assertThrows(
      () => f.viewer.assertCurrent(),
      OperationError,
      "Access policy changed while this operation was pending; it was not applied.",
    );
    const replacement = f.authority.lease(f.token.principal, "readVault");
    assertEquals(
      await new Response(
        replacement.body(replacement.prepare("replacement bytes")),
      ).json(),
      "replacement bytes",
    );
  }));

Deno.test("identity viewer: registration cancellation, cap reuse and full retirement", () =>
  withViewer(async (f) => {
    await withPluginFixture(async (fixture, scope) => {
      const dir = await fixture.install("cap", {
        runtime: { server: "service.js" },
      }, {
        "service.js":
          `let cancel=[];export function activate(ctx){ctx.commands.register({id:'arm',label:'Arm',target:'server'},n=>{for(let i=0;i<n;i++)cancel.push(ctx.timers.setInterval(()=>{},60000));});ctx.commands.register({id:'cancel-pending',label:'Cancel pending',target:'server'},()=>{const cancel=ctx.timers.setTimeout(()=>{throw new Error('cancelled timer fired');},0);cancel();});ctx.commands.register({id:'clear',label:'Clear',target:'server'},async()=>{await Promise.all(cancel.splice(0).map(f=>f()));});ctx.commands.register({id:'late',label:'Late',target:'server'},()=>{ctx.commands.register({id:'late-registered',label:'Late registered',target:'server'},()=>'incorrect');return 'returned';});}`,
      });
      const host = (await scope.acquire(() =>
        new PluginHost(
          readManifest(dir),
          fixture.vault,
          () => Promise.resolve(null),
          1,
          { role: "service" },
        ), (host) => host.stop())).value;
      await host.start();
      await hostInitialized(host);
      const id = (name: string) =>
        [...host.registrations].find(([, registration]) =>
          registration.id === name
        )![0];
      const invoke = (name: string, args: unknown[] = []) =>
        host.invoke(id(name), args, false, host.limits.serviceCallMs, {
          viewer: f.viewer,
        });
      const generation = host.generation;
      const retained = createOperationLease("retained", [() => {}]);
      let revoked = false;
      const assertLive = (): undefined => {
        // The first check after admission sees the Worker's registration in
        // flight; revoke there so it arrives for a retired continuation.
        if (host.continuationCount > 0) revoked = true;
        if (revoked) throw new Error("viewer revoked after admission");
        return undefined;
      };
      await assertRejects(
        () =>
          host.invoke(id("late"), [], false, host.limits.serviceCallMs, {
            viewer: {
              retained: retained.lease,
              operation: () =>
                createOperationLease("live", [assertLive], [retained.lease])
                  .lease,
              assertCurrent: assertLive,
              sessionCurrent: () => true,
            },
          }),
        Error,
        "viewer revoked after admission",
      );
      await waitUntil(
        () =>
          host.continuationCount === 0
            ? done()
            : pending(host.continuationCount),
        { label: "late registration releases its continuation" },
      );
      assertEquals(
        [
          host.available,
          host.generation,
          [...host.registrations.values()].map((value) => value.id).sort(),
        ],
        [true, generation, ["arm", "cancel-pending", "clear", "late"]],
      );
      // Without a viewer, release before admission is ordinary success too.
      assertEquals(await host.invoke(id("cancel-pending"), []), undefined);
      await invoke("cancel-pending");
      await waitUntil(
        () =>
          host.continuationCount === 0
            ? done()
            : pending(host.continuationCount),
        {
          label: "cancelled admission releases child",
        },
      );
      await invoke("arm", [VIEWER_CONTINUATION_LIMIT]);
      assertEquals(host.continuationCount, VIEWER_CONTINUATION_LIMIT);
      await assertRejects(
        () => invoke("arm", [1]),
        Error,
        "plugin handler failed",
      );
      assertEquals(host.continuationCount, VIEWER_CONTINUATION_LIMIT);
      await host.invoke(id("clear"), []);
      await waitUntil(
        () =>
          host.continuationCount === 0
            ? done()
            : pending(host.continuationCount),
        {
          label: "released continuation capacity",
        },
      );
      await invoke("arm", [1]);
      assertEquals(host.continuationCount, 1);
      f.identity.now = f.token.principal.expiresAt;
      await waitUntil(
        () =>
          host.continuationCount === 0
            ? done()
            : pending(host.continuationCount),
        {
          label: "expired session releases repeating resources",
        },
      );
      assert(host.available);
      f.identity.now = f.token.principal.expiresAt - 1000;
      await invoke("arm", [1]);
      assertEquals(host.continuationCount, 1);
      host.stop();
      assertEquals(host.continuationCount, 0);
    });
  }));
