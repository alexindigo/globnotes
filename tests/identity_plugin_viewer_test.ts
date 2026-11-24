// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { InstanceAuthority } from "../server/auth/authority.ts";
import type { AuthorityReadContext } from "../server/auth/authority_context.ts";
import { createInstanceAuth } from "../server/auth/middleware.ts";
import {
  PluginHost,
  RETAINED_CONTINUATION_LIMIT,
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
import { METADATA_LIMITS } from "../server/metadata/contracts.ts";
import { WorkerDeliveryGate } from "./helpers/worker_liveness.ts";
import { createPluginManager } from "./helpers/plugin_manager.ts";

const source =
  `let status=Promise.withResolvers(), fsOutcome, endpointVisits=0, observedCause=Promise.withResolvers();export function enteredEndpoint(){endpointVisits++;}export function activate(ctx){
  const follow = kind => ctx.actions.request('create',{path:'causal-output',content:kind,base:{kind:'absent'}});
  ctx.hooks.on('on-create',fact=>{if(fact.path==='causal-input')return follow('create');if(fact.path==='causal-output')observedCause.resolve([fact.causalParent,fact.causalDepth]);});
  ctx.hooks.on('on-sync',fact=>{if(fact.operationId==='source-sync')return follow('sync');});
  ctx.commands.register({id:'causal-result',label:'Causal result',target:'server'},()=>observedCause.promise);
  ctx.commands.register({id:'echo',label:'Echo',target:'server'},payload=>payload);
  ctx.commands.register({id:'fail',label:'Fail',target:'server'},()=>{throw new Error('deliberate failure');});
  ctx.commands.register({id:'endpoint-visits',label:'Endpoint visits',target:'server'},()=>endpointVisits);
  ctx.commands.register({id:'timer',label:'Timer',target:'server'},()=>{
    status=Promise.withResolvers();ctx.timers.setTimeout(async()=>{try{await ctx.readNote('gate');
      const receipt=await ctx.actions.request('create',{path:'viewer-output',content:'live-edit',base:{kind:'absent'}});
      status.resolve({status:'accepted',requestId:receipt.requestId});}catch{status.resolve({status:'denied'});}},0);return 'armed';});
  ctx.commands.register({id:'direct',label:'Direct',target:'server'},()=>ctx.actions.request('create',{path:'direct-output',content:'deferred',base:{kind:'absent'}}));
  ctx.commands.register({id:'background',label:'Background',target:'server'},()=>ctx.actions.request('create',{path:'background-output',content:'independent',base:{kind:'absent'}}));
  ctx.commands.register({id:'private-write',label:'Private',target:'server'},()=>ctx.data.save({value:'private'},0));
  ctx.commands.register({id:'status',label:'Status',target:'server'},()=>status.promise);
  ctx.commands.register({id:'fs-outcome',label:'FS outcome',target:'server'},()=>fsOutcome);
  ctx.commands.register({id:'fs-write',label:'FS write',target:'server'},async path=>{
    try{fsOutcome={result:await ctx.fs.writeFile(path,new Uint8Array([65]),{expect:{kind:'absent'}})};}
    catch({status,code,effect}){fsOutcome={status,code,effect};}
    return fsOutcome;});
  ctx.commands.register({id:'settle-action',label:'Settle action',target:'server'},async id=>{for(;;){const receipt=await ctx.actions.result(id);if(!['accepted','running'].includes(receipt.status))return receipt;await new Promise(resolve=>ctx.timers.setTimeout(resolve,0));}});
}`;

async function withViewer(run: (f: ViewerFixture) => Promise<void>) {
  let hold: (() => Promise<void>) | undefined;
  let writeHold: (() => Promise<void>) | undefined;
  await withPluginOperationsFixture({
    id: "viewer",
    manifest: {
      runtime: { server: "service.js" },
      hooks: ["on-create", "on-sync"],
      capabilities: {
        read: ["vault"],
        write: ["vault"],
        filesystem: { read: ["vault"], write: ["vault"] },
      },
    },
    files: {
      "service.js": source,
      "endpoints/get.js":
        `import {enteredEndpoint} from '../service.js';export default async function(request,ctx){enteredEndpoint();if(request.query.length){await ctx.readNote('gate');return 'private';}let outcome,requestId;try{requestId=(await ctx.actions.request('create',{path:'endpoint-output',content:'endpoint-live-edit',base:{kind:'absent'}})).requestId;outcome='accepted';}catch{outcome='denied';}return {outcome,requestId,headers:request.headers,snapshot:ctx.snapshot};}`,
      "endpoints/post.js":
        `import {enteredEndpoint} from '../service.js';export default () => {enteredEndpoint();return 'posted';};`,
    },
    fault: async (method, args, boundary) => {
      if (
        method === "readNote" && args[0] === "gate" && boundary === "before"
      ) await hold?.();
      if (method === "fs.writeFile" && boundary === "after") {
        await writeHold?.();
      }
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
        holdWrite: (value) => {
          writeHold = value;
        },
        policy: (level, everybody = "none") =>
          acl.save(
            { everybody, grants: { [ACCOUNT_A]: level } },
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
  holdWrite(value: () => Promise<void>): void;
  policy(
    level: "view" | "edit" | "admin" | "none",
    everybody?: "none" | "view",
  ): unknown;
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

Deno.test("identity viewer: active command parses once and preserves outcomes", () =>
  withViewer(async (f) => {
    f.policy("edit");
    const raw = new Request("http://fixture/command", {
      method: "POST",
      headers: { authorization: `Bearer ${f.token.access_token}` },
    });
    {
      const handler = createIdentityPluginCommand(f.auth, f.runtime);
      let bodyReads = 0;
      const request = (id: string, command: string, text = "") =>
        ({
          _raw: raw,
          params: { id, command },
          body: {
            text() {
              bodyReads++;
              return Promise.resolve(text);
            },
          },
        }) as unknown as PathfinderRequest;
      const missing = await assertRejects(
        () => handler(request("not-installed", "echo")),
        HttpError,
        "HTTP 404",
      );
      assertEquals([missing.status, bodyReads], [404, 0]);
      for (const payload of [undefined, null, [1, "ok"]]) {
        const response = await handler(
          request(f.id, "echo", JSON.stringify(payload)),
        );
        assertEquals([response.status, await response.json()], [200, {
          result: payload === undefined ? {} : payload,
        }]);
      }
      assertEquals(bodyReads, 3);
      const malformed = await assertRejects(
        () => handler(request(f.id, "echo", "{")),
        HttpError,
        "HTTP 400",
      );
      assertEquals([malformed.detail, bodyReads], [
        "Invalid JSON request body.",
        4,
      ]);
      const unknown = await assertRejects(
        () => handler(request(f.id, "not-registered")),
        HttpError,
        "HTTP 404",
      );
      const failed = await handler(request(f.id, "fail"));
      assertEquals([unknown.status, failed.status, await failed.json()], [
        404,
        500,
        {
          detail: "plugin command failed",
        },
      ]);
    }
  }));

Deno.test("identity viewer: revoked command reply does not claim the completed side effect was refused at admission", () =>
  withViewer(async (f) => {
    f.policy("edit");
    const command = createIdentityPluginCommand(f.auth, f.runtime);
    const request = () => {
      const raw = new Request("http://fixture/command", {
        method: "POST",
        body: JSON.stringify("command-receipt.bin"),
        headers: { authorization: `Bearer ${f.token.access_token}` },
      });
      return {
        _raw: raw,
        body: raw,
        params: { id: f.id, command: "fs-write" },
      } as unknown as PathfinderRequest;
    };
    const filename = `${f.fixture.vault}/command-receipt.bin`;
    assertEquals(absent(filename), true);
    const route = request();
    await heldOperation({
      label: "command reply after filesystem commit",
      owner: () => f.runtime,
      progress: { kind: "product" },
      signal: f.scope.signal,
    }, (hold) => {
      f.holdWrite(hold);
      return command(route);
    }, async (operation) => {
      await operation.reached();
      assertEquals(Deno.readTextFileSync(filename), "A");
      f.identity.now = f.token.principal.expiresAt;
      const result = await operation.result();
      assertEquals(await result.json(), {
        code: "plugin_outcome_unknown",
        detail: "The plugin callback was dispatched; its outcome is unknown.",
      });
    });
    const refused = await command(request());
    assertEquals([refused.status, await refused.json()], [401, {
      code: "credentials_refused",
      detail: "Invalid authentication credentials.",
    }]);
    assertEquals(Deno.readTextFileSync(filename), "A");
  }));

Deno.test("identity viewer: render POST skips whitespace-padded plugin IDs", () =>
  withViewer(async (f) => {
    const dir = await f.fixture.install("probe", {}, {
      "main.js":
        `export function getSelectors(){return [{node:'fence',language:'probe'}]};export function parseNode(){return {parts:['<b>rendered by probe</b>']}};`,
    });
    const prior = state.plugins;
    const manager = (await f.scope.acquire(() =>
      createPluginManager(f.fixture.vault, undefined, 1, f.fixture.statePath, {
        internalRoot: `${dir}/no-internal`,
        autoEnable: true,
      }), (manager) =>
      manager.stop())).value;
    f.scope.defer(() => {
      state.plugins = prior;
    });
    state.plugins = manager;
    const raw = new Request("http://fixture/render", {
      method: "POST",
      headers: { authorization: `Bearer ${f.token.access_token}` },
    });
    {
      const handler = createIdentityRender(f.auth);
      const render = async (query: string) =>
        await (await handler({
          _raw: raw,
          query: new URLSearchParams(query),
          body: {
            text: () =>
              Promise.resolve("```probe\noriginal\n```\n"),
          },
        } as unknown as PathfinderRequest)).text();
      assert((await render("")).includes("<b>rendered by probe</b>"));
      const disabled = await render("disabled=alpha,%20probe%20,%20");
      assertEquals([
        disabled.includes("rendered by probe"),
        disabled.includes("original"),
      ], [false, true]);
    }
  }));

Deno.test("identity viewer: a newer ACL revision with the same grant does not authorize stale command effects", () =>
  withViewer(async (f) => {
    f.policy("edit");
    const filename = `${f.fixture.vault}/acl-revision.bin`;
    const raw = new Request("http://fixture/command", {
      method: "POST",
      headers: { authorization: `Bearer ${f.token.access_token}` },
    });
    const admitted = await f.auth.readLease(raw);
    const invoke = createIdentityPluginCommand(f.auth, f.runtime);
    await heldOperation({
      label: "ACL changes before command body completes",
      owner: () => f.runtime,
      progress: { kind: "controlled", clock: "external" },
      signal: f.scope.signal,
    }, (hold) =>
      invoke({
        _raw: raw,
        params: { id: f.id, command: "fs-write" },
        body: {
          text: async () => {
            await hold();
            return JSON.stringify("acl-revision.bin");
          },
        },
      } as unknown as PathfinderRequest), async (operation) => {
      await operation.reached();
      admitted.assertCurrent();
      // Change the ACL contents as well as its revision without changing Alice's grant.
      f.policy("edit", "view");
      const fresh = await f.auth.readLease(raw);
      assertEquals(fresh.aclRevision, admitted.aclRevision + 1);
      fresh.viewer.assertCurrent("editNotes");
      await assertRejects(
        operation.result,
        OperationError,
        "Access policy changed",
      );
      assertEquals(absent(filename), true);
      // Without HTTP response checks, a retained viewer still cannot accept or
      // start a deferred write; only the effect owner can enforce this.
      const before = f.actions.retentionCounts();
      await assertRejects(
        () => f.runtime.invokeCommand(f.id, "direct", {}, admitted.viewer),
        Error,
        "plugin handler failed",
      );
      assertEquals(f.actions.retentionCounts(), before);
      assertEquals(absent(`${f.fixture.vault}/direct-output.md`), true);
    });
  }));

for (const action of ["create", "sync"] as const) {
  Deno.test(`identity viewer: ${action} observer retains its source operation parent`, () =>
    withViewer(async (f) => {
      f.policy("edit");
      const fact = {
        operationId: `source-${action}`,
        action,
        path: "causal-input",
        origin: "api" as const,
        timestamp: "2026-01-01T00:00:00Z",
        causalDepth: 2,
      };
      if (fact.action === "sync") await f.manager.syncAll(fact, f.viewer);
      else f.lifecycle.observe(fact);
      // The observer publishing the final fact uses the ordinary Worker lane.
      // Read only after the durable consumer exists so the query cannot hold it up.
      const filename = `${f.fixture.vault}/causal-output.md`;
      await waitUntil(() => absent(filename) ? pending(filename) : done(), {
        label: "observer action published its note",
      });
      assertEquals(Deno.readTextFileSync(filename), action);
      assertEquals(await f.command("causal-result"), [fact.operationId, 3]);
    }));
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
        if (outcome === "view") {
          // The HTTP surface now refuses before dispatch. The retained
          // View context still must not let a deferred RPC borrow authority.
          assertEquals(await f.commandAsViewer("timer"), "armed");
          return await f.command("status");
        }
        const transport = new AbortController();
        const dispatch = createIdentityPluginCommand(f.auth, f.runtime);
        const response = await dispatch({
          _raw: new Request(
            "http://fixture/_/api/plugin-host/viewer/commands/timer",
            {
              method: "POST",
              signal: transport.signal,
              headers: { authorization: `Bearer ${f.token.access_token}` },
            },
          ),
          params: { id: f.id, command: "timer" },
          body: { text: () => Promise.resolve("") },
        } as unknown as PathfinderRequest);
        assertEquals(await response.json(), { result: "armed" });
        // Deno closes the request signal when the response was delivered.
        transport.abort(
          new DOMException("HTTP response delivered", "AbortError"),
        );
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
    await heldOperation({
      label: "admitted plugin proxy handler",
      owner: () => f.runtime,
      progress: { kind: "product" },
      signal: f.scope.signal,
    }, (hold) => {
      f.hold(hold);
      return proxy({ ...request(), query: new URLSearchParams("hold=1") });
    }, async (operation) => {
      await operation.reached();
      f.identity.now = f.token.principal.expiresAt;
      const refused = await assertRejects(
        operation.result,
        HttpError,
        "HTTP 401",
      );
      assertEquals(refused.status, 401);
    });
  }));

Deno.test("identity viewer: filesystem refusal preserves effect status and no success token", () =>
  withViewer(async (f) => {
    const invoke = (name: string) =>
      f.runtime.invokeCommand(f.id, "fs-write", name, f.viewer);
    const filename = `${f.fixture.vault}/effect.bin`;
    f.policy("view");
    assertEquals(await invoke("effect.bin"), {
      status: 403,
      code: "fs_denied",
      effect: "none",
    });
    assertEquals(absent(filename), true);
    f.policy("edit");
    await heldOperation({
      label: "committed filesystem reply",
      owner: () => f.runtime,
      progress: { kind: "product" },
      signal: f.scope.signal,
    }, (hold) => {
      f.holdWrite(hold);
      return invoke("effect.bin");
    }, async (operation) => {
      await operation.reached();
      assertEquals(Deno.readTextFileSync(filename), "A");
      f.policy("view");
      assertEquals(await operation.result(), {
        status: 409,
        code: "fs_generation_revoked",
        effect: "committed",
      });
      assertEquals(Deno.readTextFileSync(filename), "A");
    });
  }));

Deno.test("identity viewer: queued mutating proxy retains its admitted Edit lease through the Worker post", () =>
  withViewer(async (f) => {
    f.policy("edit");
    const previous = state.pluginEndpoints;
    f.scope.defer(() => {
      state.pluginEndpoints = previous;
    });
    state.pluginEndpoints = new PluginEndpoints(() => f.runtime);
    const request = (method: string) => {
      const raw = new Request("http://fixture/_/api/plugins/viewer/", {
        method,
        headers: { authorization: `Bearer ${f.token.access_token}` },
      });
      return {
        _raw: raw,
        method,
        params: { id: f.id },
        query: new URLSearchParams(method === "GET" ? "hold=1" : ""),
        headers: raw.headers,
        body: { stream: null },
      };
    };
    await heldOperation({
      label: "hold ordinary plugin service lane",
      owner: () => f.runtime,
      progress: { kind: "product" },
      signal: f.scope.signal,
    }, (hold) => {
      f.hold(hold);
      return createIdentityPluginProxy(f.auth)(request("GET"));
    }, async (running) => {
      await running.reached();
      const stale = createIdentityPluginProxy(f.auth, "editNotes")(
        request("POST"),
      );
      stale.catch(() => {});
      await waitUntil(async () => {
        const work = f.runtime.settlement(f.id, ["ordinary"]);
        if (work.pending === 2) return done();
        await work.changed;
        return pending(work.pending);
      }, { label: "exact proxy queued beside held callback" });
      f.policy("view");
      f.viewer.assertCurrent("readVault");
      running.release();
      await assertRejects(
        running.result,
        OperationError,
        "Access policy changed",
      );
      await assertRejects(() => stale, OperationError, "Access policy changed");
      assertEquals(await f.command("endpoint-visits"), 1);
    });
  }));

for (
  const route of ["proxy", "render-get", "render-post", "command"] as const
) {
  Deno.test(`identity viewer: ${route} does not enter work after the admitted vault is replaced`, () =>
    withViewer(async (f) => {
      f.policy("edit");
      const previous = state.pluginEndpoints;
      f.scope.defer(() => {
        state.pluginEndpoints = previous;
      });
      state.pluginEndpoints = new PluginEndpoints(() => f.runtime);
      const milestones: string[] = [];
      const auth = {
        ...f.auth,
        async lease(...args: Parameters<typeof f.auth.lease>) {
          const lease = await f.auth.lease(...args);
          lease.assertCurrent();
          milestones.push("admitted");
          f.replace();
          f.authority.viewer(f.token.principal).assertCurrent("editNotes");
          milestones.push("replacement current");
          return lease;
        },
      };
      const raw = new Request(
        `http://fixture/${route === "proxy" ? "_/api/plugins/viewer/" : route}`,
        { headers: { authorization: `Bearer ${f.token.access_token}` } },
      );
      const request = {
        _raw: raw,
        method: "GET",
        headers: raw.headers,
        params: {
          id: f.id,
          command: "direct",
          get path() {
            milestones.push("read note");
            return "gate";
          },
        },
        query: new URLSearchParams(),
        body: {
          get stream() {
            milestones.push("acquire stream");
            return null;
          },
          text() {
            milestones.push("acquire text");
            return Promise.resolve("buffer");
          },
          json() {
            milestones.push("acquire json");
            return Promise.resolve({});
          },
        },
      };
      const invoke = () =>
        route === "proxy"
          ? createIdentityPluginProxy(auth)(request)
          : route === "render-get"
          ? createIdentityNoteRender(auth)(
            request as unknown as PathfinderRequest<{ path: string }>,
          )
          : route === "render-post"
          ? createIdentityRender(auth)(request as unknown as PathfinderRequest)
          : createIdentityPluginCommand(auth, f.runtime)(
            request as unknown as PathfinderRequest,
          );
      await assertRejects(invoke, OperationError, "Access policy changed");
      assertEquals(milestones, ["admitted", "replacement current"]);
      assertEquals(await f.command("endpoint-visits"), 0);
      assertEquals(absent(`${f.fixture.vault}/endpoint-output.md`), true);
      assertEquals(absent(`${f.fixture.vault}/direct-output.md`), true);
    }));
}

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
      f.policy(caller === "command" ? "edit" : "view");
      const invoke = () => {
        const raw = new Request(`http://fixture/_/api/${caller}`, {
          method: "POST",
          headers: { authorization: `Bearer ${f.token.access_token}` },
          body: caller === "render-post"
            ? "unsaved buffer"
            : JSON.stringify({ message: "viewer echo" }),
        });
        const request = {
          _raw: raw,
          params: { id: f.id, command: "echo" },
          query: new URLSearchParams(),
          body: raw,
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
      if (caller === "command") {
        assertEquals(await stale.json(), {
          code: "plugin_outcome_unknown",
          detail: "The plugin callback was dispatched; its outcome is unknown.",
        });
      } else {
        const error = await assertRejects(
          () => stale.text(),
          HttpError,
          "HTTP 401",
        );
        assertEquals([error.status, error.detail], [
          401,
          "Invalid authentication credentials.",
        ]);
      }
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

Deno.test("identity viewer: denied sync does not take healthy render replicas out of service", () =>
  withViewer(async (f) => {
    await withPluginFixture(async (fixture, scope) => {
      const dir = await fixture.install("render", { entry: "render.js" }, {
        "render.js":
          `let syncs=0;export async function onSync(ctx){await ctx.readNote('sync');syncs++;}export function parseNode(){return syncs;}`,
      });
      let syncHold: (() => Promise<void>) | undefined;
      const host = (await scope.acquire(() =>
        new PluginHost(readManifest(dir), fixture.vault, async () => {
          await syncHold?.();
          return null;
        }, 1), (host) =>
        host.stop())).value;
      await host.start();
      await hostInitialized(host);
      const generations = host.generations;
      assertEquals(await host.call("parseNode", []), 1);
      await heldOperation({
        label: "viewer sync inside shared render replica",
        owner: () =>
          host,
        progress: { kind: "product" },
        signal: scope.signal,
      }, (hold) => {
        syncHold = hold;
        return host.syncAll(f.viewer);
      }, async (operation) => {
        await operation.reached();
        f.policy("none");
        assertEquals(f.viewer.sessionCurrent(), true);
        await operation.result();
      });
      // The same denied viewer also cannot dispatch a subsequent sync.
      await host.syncAll(f.viewer);
      f.policy("view");
      const otherViewer = f.authority.viewer(f.token.principal);
      assertEquals(
        await host.call("parseNode", [], { viewer: otherViewer }),
        1,
      );
      assertEquals(host.generations, generations);
    });
  }));

Deno.test("identity viewer: cancellation during timer begin prevents callback entry", () =>
  withViewer(async (f) => {
    await withPluginFixture(async (fixture, scope) => {
      const gate = (await scope.acquire(() =>
        new WorkerDeliveryGate(), (gate) =>
        gate.restore())).value;
      gate.holdHeartbeat = false;
      const dir = await fixture.install("timer-race", {
        runtime: { server: "service.js" },
      }, {
        "service.js": `let dispose, entries=0;export function activate(ctx){
          ctx.commands.register({id:'arm',label:'Arm',target:'server'},()=>{dispose=ctx.timers.setTimeout(()=>{entries++;},0);});
          ctx.commands.register({id:'cancel',label:'Cancel',target:'server'},()=>{dispose();return entries;});
          ctx.commands.register({id:'entries',label:'Entries',target:'server'},()=>entries);
        }`,
      });
      const host = (await scope.acquire(() =>
        new PluginHost(
          readManifest(dir),
          fixture.vault,
          () =>
            Promise.resolve(null),
          1,
          { role: "service" },
        ), (host) =>
        host.stop())).value;
      await host.start();
      await hostInitialized(host);
      const command = (name: string, viewer?: ViewerFixture["viewer"]) =>
        host.invoke(
          [...host.registrations].find(([, value]) => value.id === name)![0],
          [],
          false,
          host.limits.serviceCallMs,
          { viewer },
        );
      let begin: { id: number; parent: string } | undefined;
      let reply: (() => void) | undefined;
      let releasedParent: (() => void) | undefined;
      let firing: string | undefined, releasedFiring = false;
      gate.holdInbound = (message, deliver) => {
        if (message.type !== "rpc") return false;
        if (message.method === "context.begin") {
          begin = { id: message.id, parent: message.contextId };
        }
        if (message.method === "context.release") {
          if (message.contextId === begin?.parent) {
            releasedParent = deliver;
            return true;
          }
          if (message.contextId === firing) releasedFiring = true;
        }
        return false;
      };
      gate.holdOutbound = (message, deliver) => {
        if (message.type !== "rpcResponse" || message.id !== begin?.id) {
          return false;
        }
        assert(message.ok, "must hold a successful firing admission");
        firing = (message.value as { id: string }).id;
        reply = deliver;
        return true;
      };
      await command("arm", f.viewer);
      await waitUntil(() => reply ? done() : pending(begin), {
        label: "successful timer begin reply held",
      });
      assertEquals(host.continuationCount, 1);
      assertEquals(await command("cancel"), 0);
      assert(
        releasedParent,
        "the disposer must have requested release while begin was held",
      );
      reply!();
      await waitUntil(() => releasedFiring ? done() : pending(firing), {
        label: "firing context released after reply",
      });
      assertEquals(await command("entries"), 0);
      releasedParent();
      assertEquals(await command("entries"), 0);
    });
  }));

Deno.test("identity viewer: registration cancellation, cap reuse and full retirement", () =>
  withViewer(async (f) => {
    await withPluginFixture(async (fixture, scope) => {
      const dir = await fixture.install("cap", {
        runtime: { server: "service.js" },
      }, {
        "service.js":
          `let cancel=[], cancelledEntries=0;export function activate(ctx){
            for(let i=0;i<${METADATA_LIMITS.watches};i++)ctx.metadata.watch({offset:i},()=>{});
            ctx.commands.register({id:'arm',label:'Arm',target:'server'},n=>{for(let i=0;i<n;i++)cancel.push(ctx.timers.setInterval(()=>{},60000));});ctx.commands.register({id:'cancel-pending',label:'Cancel pending',target:'server'},()=>{const cancel=ctx.timers.setTimeout(()=>{cancelledEntries++;},0);cancel();});ctx.commands.register({id:'timer-checkpoint',label:'Timer checkpoint',target:'server'},()=>new Promise(resolve=>ctx.timers.setTimeout(()=>resolve(cancelledEntries),0)));ctx.commands.register({id:'clear',label:'Clear',target:'server'},async()=>{await Promise.all(cancel.splice(0).map(f=>f()));});ctx.commands.register({id:'late',label:'Late',target:'server'},()=>{ctx.metadata.watch({},()=>{});return 'returned';});}`,
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
      const watchCount = () =>
        [...host.registrations.values()].filter((value) =>
          value.kind === "metadata-watch"
        ).length;
      assertEquals(watchCount(), METADATA_LIMITS.watches);
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
          watchCount(),
          [...host.registrations.values()].filter((value) =>
            value.kind === "command"
          ).map((value) => value.id).sort(),
        ],
        [true, generation, METADATA_LIMITS.watches, [
          "arm",
          "cancel-pending",
          "clear",
          "late",
          "timer-checkpoint",
        ]],
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
      await invoke("arm", [RETAINED_CONTINUATION_LIMIT - 2]);
      await host.invoke(id("arm"), [1], true);
      await host.invoke(id("arm"), [1], false, host.limits.serviceCallMs, {
        causal: { parentId: "source-observer", depth: 1 },
      });
      assertEquals(host.continuationCount, RETAINED_CONTINUATION_LIMIT);
      assertEquals(await invoke("cancel-pending"), undefined);
      assertEquals(await host.invoke(id("timer-checkpoint"), []), 0);
      await assertRejects(
        () => invoke("arm", [1]),
        Error,
        "plugin handler failed",
      );
      await assertRejects(
        () => host.invoke(id("arm"), [1], true),
        Error,
        "plugin handler failed",
      );
      await assertRejects(
        () =>
          host.invoke(id("arm"), [1], false, host.limits.serviceCallMs, {
            causal: { parentId: "source-observer", depth: 1 },
          }),
        Error,
        "plugin handler failed",
      );
      assertEquals(host.continuationCount, RETAINED_CONTINUATION_LIMIT);
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
      f.policy("none");
      assertEquals(f.viewer.sessionCurrent(), true);
      await waitUntil(
        () =>
          host.continuationCount === 0
            ? done()
            : pending(host.continuationCount),
        {
          label:
            "live session without vault access releases repeating resources",
        },
      );
      f.policy("view");
      await host.invoke(id("arm"), [1], false, host.limits.serviceCallMs, {
        viewer: f.authority.viewer(f.token.principal),
      });
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
      await host.invoke(id("arm"), [1], false, host.limits.serviceCallMs, {
        viewer: f.authority.viewer(f.token.principal),
      });
      assertEquals(host.continuationCount, 1);
      host.stop();
      assertEquals(host.continuationCount, 0);
    });
  }));
