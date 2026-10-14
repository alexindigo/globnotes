// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals } from "@std/assert";
import { fixturePage, pluginFixture } from "./helpers/plugin_fixture.ts";

/** Feature-owned normal launcher; importAuthority is an isolated positive control only. */
async function bootNetworkServer(
  env: Record<string, string>,
  importAuthority?: string,
  privateLockPath?: string,
) {
  const root = new URL("../", import.meta.url).pathname;
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = listener.addr.port;
  listener.close();
  // jsr.io:443 is an existing normal-parent import right needed by the host graph.
  const args = [
    "run",
    "--unstable-worker-options",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    ...importAuthority ? [`--allow-import=jsr.io:443,${importAuthority}`] : [],
    ...privateLockPath ? [`--lock=${privateLockPath}`] : [],
    `${root}server/main.ts`,
  ];
  const child = new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    env: {
      ...env,
      GLOBNOTES_PORT: String(port),
      GLOBNOTES_HOST: "127.0.0.1",
      NO_COLOR: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = { stdout: "", stderr: "" };
  const drains = ["stdout", "stderr"].map(async (name) => {
    for await (const bytes of name === "stdout" ? child.stdout : child.stderr) {
      output[name as keyof typeof output] += new TextDecoder().decode(bytes);
    }
  });
  let status: Deno.CommandStatus | null = null;
  child.status.then((value) => {
    status = value;
  });
  const readStatus = (): Deno.CommandStatus | null => status;
  const baseUrl = `http://127.0.0.1:${port}`,
    prefix = env.GLOBNOTES_PATH_PREFIX ?? "";
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (!status) child.kill("SIGTERM");
    await child.status;
    await Promise.all(drains);
  };
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      const exited = readStatus();
      if (exited) {
        throw Error(
          `owned network fixture exited ${exited.code}: ${output.stderr}`,
        );
      }
      try {
        const response = await fetch(`${baseUrl}${prefix}/_/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) break;
      } catch { /* bounded startup admission */ }
      if (Date.now() > deadline) {
        throw Error(`owned network fixture health deadline: ${output.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    console.log(
      JSON.stringify({
        networkFixtureParent: {
          pid: child.pid,
          args,
          cwd: root,
          isolatedImportControl: !!importAuthority,
        },
      }),
    );
    return { baseUrl, close, output, pid: child.pid, args };
  } catch (error) {
    await close();
    throw error;
  }
}

async function apiFixture(
  extra: Record<string, string> = {},
  imports: "none" | "parent-missing" | "parent-granted" = "none",
  runtimeOnly = false,
) {
  const fixture = await pluginFixture();
  let traffic = 0;
  let afterGateTraffic = 0;
  const held = Promise.withResolvers<void>(),
    releaseHeld = Promise.withResolvers<void>();
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      traffic++;
      const path = new URL(request.url).pathname;
      if (path === "/held" || path === "/held-module.js") {
        held.resolve();
        await releaseHeld.promise;
      }
      if (path === "/after-held" || path === "/after-module.js") {
        afterGateTraffic++;
      }
      return path.endsWith("module.js")
        ? new Response("export const value='approved remote code'", {
          headers: { "content-type": "application/javascript" },
        })
        : new Response("approved API receiver");
    },
  );
  const authority = `127.0.0.1:${receiver.addr.port}`;
  await fixture.install("networked", {
    runtime: { server: "service.js" },
    ...(runtimeOnly ? { hooks: ["pre-save"] } : {}),
    settings: [fixturePage],
    capabilities: {
      network: runtimeOnly ? false : [authority],
      imports: runtimeOnly || imports === "none" ? false : [authority],
      read: [],
      write: [],
    },
  }, {
    "service.js":
      `const instance=crypto.randomUUID(); export async function activate(ctx) {
      ${
        runtimeOnly
          ? `const settings = await ctx.settings.read();
      await ctx.permissions.declare({network: ${
            imports === "none"
              ? "settings.values.preferences.protect ? ['" + authority +
                "'] : false"
              : "false"
          }, imports: ${
            imports === "none"
              ? "false"
              : "settings.values.preferences.protect ? ['" + authority +
                "'] : false"
          }});
      ctx.hooks.on('pre-save', () => {});`
          : ""
      }
      const request = ${
        runtimeOnly
          ? "null"
          : `await ctx.permissions.requestAccess({kind:'network',hosts:['${authority}'],reason:'Read service status'})`
      };
      ctx.commands.register({id:'inspect',label:'Inspect',target:'server'},async()=>({instance,request,view:await ctx.permissions.status()}));
      ctx.commands.register({id:'fetch',label:'Fetch',target:'server'},async()=>await(await fetch('http://${authority}/consumer')).text());
      ctx.commands.register({id:'request',label:'Request',target:'server'},()=>ctx.permissions.requestAccess({kind:'network',hosts:['${authority}'],reason:'Read service status'}));
      ctx.commands.register({id:'fresh-declare',label:'Fresh declaration',target:'server'},async()=>{const view=await ctx.permissions.status();const settings=await ctx.settings.read();if(view.source.settingsRevision!==settings.revision)throw Error('settings source mismatch');await ctx.permissions.declare({network:['${authority}'],imports:false},{source:view.source});return {instance,source:view.source,settingsRevision:settings.revision}});
      ctx.commands.register({id:'old-declare',label:'Old declaration',target:'server'},async()=>{try{await ctx.permissions.declare({network:['${authority}'],imports:false});return {unexpected:true}}catch(error){return {code:error.code,status:error.status}}});
      ctx.commands.register({id:'import',label:'Import',target:'server'},async()=>{const module=await import('http://${authority}/module.js');return {value:module.value,network:Deno.permissions.querySync({name:'net',host:'${authority}'}).state,imports:Deno.permissions.querySync({name:'import',host:'${authority}'}).state}});
      ctx.commands.register({id:'held-fetch',label:'Held fetch',target:'server'},async()=>{await(await fetch('http://${authority}/held')).text();return await(await fetch('http://${authority}/after-held')).text()});
      ${
        runtimeOnly
          ? `ctx.commands.register({id:'state',label:'Settings consumer',target:'server'},async()=>({instance,settings:await ctx.settings.read()}));
      ctx.commands.register({id:'held-import',label:'Held import',target:'server'},async()=>{const base='http://${authority}';await import(base+'/held-module.js');return (await import(base+'/after-module.js')).value;});`
          : ""
      }
    }`,
  });
  await fixture.install("disabled-browser", {
    runtime: { client: "application.js" },
  }, { "application.js": "export function activate(){}" });
  await Deno.writeTextFile(
    `${fixture.statePath}/plugins.json`,
    JSON.stringify({ disabled: ["disabled-browser"] }),
  );
  const launchEnv = {
    GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES_INDEX_PATH: fixture.statePath,
    GLOBNOTES_AUTH_TYPE: "none",
    GLOBNOTES_PATH_PREFIX: "",
    ...extra,
  };
  const privateLockPath = imports === "parent-granted"
    ? `${fixture.root}/import-control.lock`
    : undefined;
  if (privateLockPath) {
    await Deno.copyFile(
      new URL("../deno.lock", import.meta.url),
      privateLockPath,
    );
  }
  let server = await bootNetworkServer(
    launchEnv,
    imports === "parent-granted" ? authority : undefined,
    privateLockPath,
  );
  const prefix = extra.GLOBNOTES_PATH_PREFIX ?? "";
  let base = `${server.baseUrl}${prefix}`;
  const get = async (suffix: string) =>
    await fetch(`${base}/_/api/plugin-host/${suffix}`, {
      signal: AbortSignal.timeout(3000),
    });
  const view = async () => {
    const response = await get("networked/permissions");
    assertEquals(response.status, 200);
    return await response.json();
  };
  const controls = (
    value: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) => ({
    revision: value.revision,
    signature: value.signature,
    requestSourceKey: value.requestSourceKey,
    requestSourceRevision: value.requestSourceRevision,
    allowNetwork: value.allowNetwork,
    approvedNetwork: value.approvedNetwork,
    approvedImports: value.approvedImports,
    ...overrides,
  });
  const put = async (body: unknown) =>
    await fetch(`${base}/_/api/plugin-host/networked/permissions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  const invoke = async (command: string) =>
    await fetch(`${base}/_/api/plugin-host/networked/commands/${command}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    });
  const ready = async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const catalog = await (await fetch(`${base}/_/api/plugin-host`, {
        signal: AbortSignal.timeout(3000),
      })).json();
      const plugin = catalog.plugins.find((entry: { id: string }) =>
        entry.id === "networked"
      );
      if (plugin?.status === "ready") return;
      if (plugin?.status === "failed" || Date.now() > deadline) {
        throw Error(`fixture activation failed ${JSON.stringify(plugin)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return {
    fixture,
    get server() {
      return server;
    },
    get base() {
      return base;
    },
    authority,
    privateLockPath,
    get,
    view,
    controls,
    put,
    invoke,
    ready,
    held: held.promise,
    releaseHeld: () => releaseHeld.resolve(),
    afterGateTraffic: () => afterGateTraffic,
    traffic: () => traffic,
    async restart() {
      await server.close();
      server = await bootNetworkServer(
        launchEnv,
        imports === "parent-granted" ? authority : undefined,
        privateLockPath,
      );
      base = `${server.baseUrl}${prefix}`;
    },
    async close() {
      releaseHeld.resolve();
      await server.close();
      await receiver.shutdown();
      if (runtimeOnly) {
        console.log(
          JSON.stringify({
            reviewSettingsFixtureRetained: fixture.root,
            serverOutput: server.output,
          }),
        );
      } else await fixture.dispose();
    },
  };
}

Deno.test("plugin network api: discovered disabled and settings-less views are protected host projections", async () => {
  const b = await apiFixture();
  try {
    const value = await b.view();
    assertEquals(value.allowNetwork, false);
    assertEquals(value.approvedNetwork, []);
    assertEquals(value.effectiveNetwork, []);
    assertEquals(value.requestedImports, []);
    assertEquals(value.requestedNetwork, [{
      type: "host",
      authority: b.authority,
    }]);
    assert(
      value.rows.some((row: { blockedReasons: string[] }) =>
        row.blockedReasons.includes("unapproved")
      ),
    );
    const disabled = await b.get("disabled-browser/permissions");
    assertEquals(disabled.status, 200);
    const browser = await disabled.json();
    assertEquals(browser.runsInBrowser, true);
    assertEquals(browser.browserComponents, ["runtime"]);
    const unknown = await b.get("unknown/permissions");
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();
    assertEquals(b.traffic(), 0);
  } finally {
    await b.close();
  }
});

Deno.test("review repairs: R02 settings commit stops runtime-only raw traffic without any later status reader", async (t) => {
  for (const kind of ["network", "imports"] as const) {
    await t.step(kind, async () => {
      const projectLock = new URL("../deno.lock", import.meta.url);
      const lockBefore = await Deno.readFile(projectLock);
      const b = await apiFixture(
        {},
        kind === "imports" ? "parent-granted" : "none",
        true,
      );
      let running: Promise<Response> | undefined;
      try {
        await b.ready();
        const before = await b.view();
        assertEquals(before.source.settingsRevision, 0);
        const granted = await b.put(b.controls(before, {
          allowNetwork: true,
          approvedNetwork: kind === "network"
            ? [{ type: "host", authority: b.authority }]
            : [],
          approvedImports: kind === "imports"
            ? [{ type: "host", authority: b.authority }]
            : [],
        }));
        assertEquals(granted.status, 200);
        await granted.body?.cancel();
        const deadline = Date.now() + 5000;
        for (;;) {
          const view = await b.view();
          if (view.reload.state === "ready") break;
          if (view.reload.state === "failed" || Date.now() > deadline) {
            throw Error(
              `DIAG_R02_IMPORT_SETUP runtime-only approval did not reach ready: ${
                JSON.stringify(view.reload)
              }`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        running = b.invoke(kind === "network" ? "held-fetch" : "held-import");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            b.held,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(Error("raw continuation did not reach receiver")),
                2000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        const saved = await fetch(
          `${b.base}/_/api/plugin-host/networked/settings/preferences`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              revision: 0,
              values: {
                message: "committed narrowing",
                protect: false,
                limit: 5,
              },
            }),
            signal: AbortSignal.timeout(3000),
          },
        );
        assertEquals(saved.status, 200);
        const settings = await saved.json();
        assertEquals(settings.revision, 1);
        // No permissions/catalog/status call after settings acknowledgement.
        b.releaseHeld();
        const old = await running;
        await old.body?.cancel();
        console.log(
          JSON.stringify({
            kind,
            settingsPersistedRevision: settings.revision,
            oldContinuationStatus: old.status,
            afterCommitReceiverTraffic: b.afterGateTraffic(),
            noLaterStatusReader: true,
          }),
        );
        assertEquals(b.afterGateTraffic(), 0);
        assert(!old.ok);
        const ledger = JSON.parse(
          await Deno.readTextFile(
            `${b.fixture.statePath}/plugin-network/networked.json`,
          ),
        );
        assertEquals(ledger.allowNetwork, true);
        assertEquals(
          kind === "network" ? ledger.approvedNetwork : ledger.approvedImports,
          [{ type: "host", authority: b.authority }],
        );
        assertEquals(await Deno.readFile(projectLock), lockBefore);
      } finally {
        b.releaseHeld();
        if (running) await running.catch(() => undefined);
        await b.close();
        assertEquals(await Deno.readFile(projectLock), lockBefore);
      }
    });
  }
});

Deno.test("review repairs: R08 reader-detected settings retirement arranges same-code narrowed command and guard recovery", async () => {
  const b = await apiFixture({}, "none", true);
  try {
    await b.ready();
    const before = await b.view();
    const granted = await b.put(
      b.controls(before, {
        allowNetwork: true,
        approvedNetwork: [{ type: "host", authority: b.authority }],
      }),
    );
    assertEquals(granted.status, 200);
    await granted.body?.cancel();
    const deadline = Date.now() + 5000;
    for (;;) {
      const view = await b.view();
      if (view.reload.state === "ready") break;
      if (view.reload.state === "failed" || Date.now() > deadline) {
        throw Error("runtime-only fixture approval failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const initial = await b.invoke("state");
    assertEquals(initial.status, 200);
    const original = (await initial.json()).result;
    // External settings bytes exercise the existing view-detected path, which
    // has no settings-route publisher to arrange recovery on its behalf.
    const settingsFile =
      `${b.fixture.statePath}/plugin-data/networked/settings.json`;
    await Deno.mkdir(`${b.fixture.statePath}/plugin-data/networked`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      settingsFile,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        values: {
          preferences: {
            message: "reader-recovered consumer",
            protect: false,
            limit: 5,
          },
        },
      }),
    );
    const fresh = await b.view();
    assertEquals(fresh.source.settingsRevision, 1);
    assertEquals(fresh.effectiveNetwork, []);
    let current: Response | undefined;
    let value: {
      instance: string;
      settings: {
        revision: number;
        values: { preferences: { message: string } };
      };
    } | undefined;
    const recoverUntil = Date.now() + 1000;
    while (Date.now() < recoverUntil) {
      current = await b.invoke("state");
      if (current.ok) {
        value = (await current.json()).result;
        break;
      }
      await current.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    console.log(
      JSON.stringify({
        originalInstance: original.instance,
        currentStatus: current?.status,
        currentConsumer: value,
        explicitEnableCalls: 0,
      }),
    );
    assertEquals(current?.status, 200);
    assert(value && value.instance !== original.instance);
    assertEquals(value.settings.revision, 1);
    assertEquals(
      value.settings.values.preferences.message,
      "reader-recovered consumer",
    );
    const create = await fetch(`${b.base}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "guarded",
        content: "fresh required guard consumer",
      }),
      signal: AbortSignal.timeout(3000),
    });
    assertEquals(create.status, 200);
    await create.body?.cancel();
    const save = await fetch(`${b.base}/_/api/notes/guarded`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        newContent: "narrowed required guard remains usable",
      }),
      signal: AbortSignal.timeout(3000),
    });
    assertEquals(save.status, 200);
    await save.body?.cancel();
    assertEquals(
      await Deno.readTextFile(`${b.fixture.vault}/guarded.md`),
      "narrowed required guard remains usable",
    );
  } finally {
    await b.close();
  }
});

Deno.test("plugin network api: persisted approvals survive normal restart and master off terminates old raw network continuation", async () => {
  const b = await apiFixture();
  try {
    await b.ready();
    let view = await b.view();
    let changed = await b.put(
      b.controls(view, {
        allowNetwork: true,
        approvedNetwork: [{ type: "host", authority: b.authority }],
      }),
    );
    assertEquals(changed.status, 200);
    await changed.body?.cancel();
    const readyReload = async () => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const current = await b.view();
        if (
          current.reload.state === "ready" || current.reload.state === "none"
        ) return current;
        if (current.reload.state === "failed" || Date.now() > deadline) {
          throw Error("persisted consent reload failed");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await readyReload();
    await b.restart();
    await b.ready();
    view = await b.view();
    assertEquals(view.allowNetwork, true);
    assertEquals(view.approvedNetwork, [{
      type: "host",
      authority: b.authority,
    }]);
    const fetch = await b.invoke("fetch");
    assertEquals(fetch.status, 200);
    assertEquals((await fetch.json()).result, "approved API receiver");
    const running = b.invoke("held-fetch");
    await b.held;
    changed = await b.put(b.controls(view, { allowNetwork: false }));
    assertEquals(changed.status, 200);
    await changed.body?.cancel();
    b.releaseHeld();
    const interrupted = await running;
    assertEquals(interrupted.status, 500);
    await interrupted.body?.cancel();
    await readyReload();
    await b.ready();
    const inspect = await b.invoke("inspect");
    assertEquals(inspect.status, 200);
    await inspect.body?.cancel();
    assertEquals(b.afterGateTraffic(), 0);
    view = await b.view();
    assertEquals(view.approvedNetwork, [{
      type: "host",
      authority: b.authority,
    }]);
    assertEquals(view.effectiveNetwork, []);
  } finally {
    b.releaseHeld();
    await b.close();
  }
});

Deno.test("plugin network api: remote imports need independent consent and already-granted parent authority", async () => {
  const projectLock = new URL("../deno.lock", import.meta.url);
  const digest = async (bytes: Uint8Array) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
      ),
    )
      .map((value) => value.toString(16).padStart(2, "0")).join("");
  for (const parent of ["parent-missing", "parent-granted"] as const) {
    const projectLockBefore = await Deno.readFile(projectLock);
    const b = await apiFixture({}, parent);
    try {
      await b.ready();
      let view = await b.view();
      const denied = await b.invoke("import");
      assertEquals(denied.status, 500);
      await denied.body?.cancel();
      assertEquals(b.traffic(), 0);
      const approved = await b.put(
        b.controls(view, {
          allowNetwork: true,
          approvedNetwork: [],
          approvedImports: [{ type: "host", authority: b.authority }],
        }),
      );
      assertEquals(approved.status, 200);
      view = (await approved.json()).view;
      assertEquals(view.approvedImports, [{
        type: "host",
        authority: b.authority,
      }]);
      assertEquals(view.effectiveNetwork, []);
      if (parent === "parent-missing") {
        assertEquals(view.effectiveImports, []);
        assert(
          view.rows.some((row: { kind: string; blockedReasons: string[] }) =>
            row.kind === "imports" &&
            row.blockedReasons.includes("parent-unavailable")
          ),
        );
        const rejected = await b.invoke("import");
        assertEquals(rejected.status, 500);
        await rejected.body?.cancel();
        assertEquals(b.traffic(), 0);
        assert(
          !b.server.args.some((argument) =>
            argument.startsWith("--allow-import") ||
            argument === "--cached-only"
          ),
        );
        assertEquals(b.privateLockPath, undefined);
        assert(
          !b.server.args.some((argument) => argument.startsWith("--lock=")),
        );
      } else {
        const deadline = Date.now() + 5000;
        do {
          view = await b.view();
          if (view.reload.state === "failed" || Date.now() > deadline) {
            throw Error(`import reload failed ${JSON.stringify(view.reload)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        } while (view.reload.state !== "ready");
        const imported = await b.invoke("import");
        assertEquals(imported.status, 200);
        const result = (await imported.json()).result;
        assertEquals(result.value, "approved remote code");
        assertEquals(result.imports, "granted");
        assert(result.network !== "granted");
        assertEquals(b.traffic(), 1);
        const fetch = await b.invoke("fetch");
        assertEquals(fetch.status, 500);
        await fetch.body?.cancel();
        assertEquals(b.traffic(), 1);
        const privateLockPath = b.privateLockPath;
        assert(
          privateLockPath && privateLockPath.startsWith(`${b.fixture.root}/`),
        );
        const initialArgs = [...b.server.args];
        const lockArgs = initialArgs.filter((argument) =>
          argument.startsWith("--lock=")
        );
        assertEquals(lockArgs, [`--lock=${privateLockPath}`]);
        const moduleUrl = `http://${b.authority}/module.js`;
        const moduleChecksum = await digest(
          new TextEncoder().encode("export const value='approved remote code'"),
        );
        const initialPrivateLock = await Deno.readFile(privateLockPath);
        assertEquals(
          JSON.parse(new TextDecoder().decode(initialPrivateLock))
            .remote[moduleUrl],
          moduleChecksum,
        );
        await b.restart();
        await b.ready();
        assertEquals(b.server.args, initialArgs);
        view = await b.view();
        assertEquals(view.allowNetwork, true);
        assertEquals(view.approvedNetwork, []);
        assertEquals(view.approvedImports, [{
          type: "host",
          authority: b.authority,
        }]);
        assertEquals(view.effectiveNetwork, []);
        assertEquals(view.effectiveImports, view.approvedImports);
        // Restart must retain the consumed URL/checksum, not recopy the baseline.
        assertEquals(await Deno.readFile(privateLockPath), initialPrivateLock);
        const trafficBeforeRestartImport = b.traffic();
        const restartedImport = await b.invoke("import");
        assertEquals(restartedImport.status, 200);
        const restartedResult = (await restartedImport.json()).result;
        assertEquals(restartedResult.value, "approved remote code");
        assertEquals(restartedResult.imports, "granted");
        assert(restartedResult.network !== "granted");
        const trafficAfterRestartImport = b.traffic();
        const deniedFetch = await b.invoke("fetch");
        assertEquals(deniedFetch.status, 500);
        await deniedFetch.body?.cancel();
        assertEquals(b.traffic(), trafficAfterRestartImport);
        const privateLockBytes = await Deno.readFile(privateLockPath);
        const privateLock = JSON.parse(
          new TextDecoder().decode(privateLockBytes),
        );
        assertEquals(privateLock.remote[moduleUrl], moduleChecksum);
        console.log(JSON.stringify({
          privateImportLock: {
            path: privateLockPath,
            launchArgs: lockArgs,
            moduleUrl,
            moduleChecksum,
            lockSha256: await digest(privateLockBytes),
            restartTrafficDelta: trafficAfterRestartImport -
              trafficBeforeRestartImport,
            restartedResult,
          },
        }));
      }
      assertEquals(await Deno.readFile(projectLock), projectLockBefore);
      console.log(JSON.stringify({
        projectLockControl: {
          parent,
          before: await digest(projectLockBefore),
          after: await digest(await Deno.readFile(projectLock)),
        },
      }));
    } finally {
      await b.close();
      assertEquals(await Deno.readFile(projectLock), projectLockBefore);
    }
  }
});

Deno.test("plugin network api: settings source changes retire requests and fresh declarations retain the actual Worker", async () => {
  const b = await apiFixture();
  try {
    await b.ready();
    const before = await b.view();
    const instance = (await (await b.invoke("inspect")).json()).result.instance;
    const update = await fetch(
      `${b.base}/_/api/plugin-host/networked/settings/preferences`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision: 0,
          values: { message: "new source", protect: true, limit: 5 },
        }),
        signal: AbortSignal.timeout(3000),
      },
    );
    assertEquals(update.status, 200);
    const settings = await update.json();
    const changed = await b.view();
    assert(changed.source.revision > before.source.revision);
    assert(changed.source.key !== before.source.key);
    assertEquals(changed.source.settingsRevision, settings.revision);
    assertEquals(changed.pendingRequests, []);
    const stale = await b.invoke("old-declare");
    assertEquals((await stale.json()).result, {
      code: "permission_source_conflict",
      status: 409,
    });
    const fresh = await b.invoke("fresh-declare");
    assertEquals(fresh.status, 200);
    const actual = (await fresh.json()).result;
    assertEquals(actual.instance, instance);
    assertEquals(actual.source, changed.source);
    assertEquals(actual.settingsRevision, settings.revision);
    const oldDecision = await fetch(
      `${b.base}/_/api/plugin-host/networked/permission-requests/${
        before.pendingRequests[0].id
      }/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          b.controls(before, {
            decision: "approve",
            allowNetwork: true,
            approvedNetwork: [{ type: "host", authority: b.authority }],
          }),
        ),
        signal: AbortSignal.timeout(3000),
      },
    );
    assertEquals(oldDecision.status, 409);
    await oldDecision.body?.cancel();
    assertEquals((await b.view()).approvedNetwork, []);
    assertEquals(b.traffic(), 0);
  } finally {
    await b.close();
  }
});

Deno.test("plugin network api: operator grant, stale CAS, off and delete reach real receiver and ledger", async () => {
  const b = await apiFixture();
  try {
    await b.ready();
    const deadline = Date.now() + 5000;
    let value = await b.view();
    while (!value.pendingRequests.length) {
      if (Date.now() > deadline) {
        throw Error("runtime access request not published");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      value = await b.view();
    }
    const denied = await b.invoke("fetch");
    assertEquals(denied.status, 500);
    await denied.body?.cancel();
    assertEquals(b.traffic(), 0);
    const saved = await b.put(
      b.controls(value, {
        allowNetwork: true,
        approvedNetwork: [{ type: "host", authority: b.authority }],
      }),
    );
    assertEquals(saved.status, 200);
    const committed = await saved.json();
    assertEquals(committed.view.allowNetwork, true);
    const stale = await b.put(b.controls(value, { allowNetwork: false }));
    assertEquals(stale.status, 409);
    assertEquals((await stale.json()).code, "permission_revision_conflict");
    do {
      value = await b.view();
      if (value.reload.state === "failed" || Date.now() > deadline) {
        throw Error(`network reload failed ${JSON.stringify(value.reload)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    } while (value.reload.state !== "ready");
    const fetched = await b.invoke("fetch");
    assertEquals(fetched.status, 200);
    assertEquals((await fetched.json()).result, "approved API receiver");
    assertEquals(b.traffic(), 1);
    const off = await b.put(b.controls(value, { allowNetwork: false }));
    assertEquals(off.status, 200);
    const offView = (await off.json()).view;
    assertEquals(offView.approvedNetwork, [{
      type: "host",
      authority: b.authority,
    }]);
    assertEquals(offView.effectiveNetwork, []);
    const removed = await b.put(b.controls(offView, { approvedNetwork: [] }));
    assertEquals(removed.status, 200);
    value = (await removed.json()).view;
    assertEquals(value.approvedNetwork, []);
    assert(
      value.rows.some((row: { requested: boolean; approved: boolean }) =>
        row.requested && !row.approved
      ),
    );
    const persisted = JSON.parse(
      await Deno.readTextFile(
        `${b.fixture.statePath}/plugin-network/networked.json`,
      ),
    );
    assertEquals(persisted.allowNetwork, false);
    assertEquals(persisted.approvedNetwork, []);
  } finally {
    await b.close();
  }
});

Deno.test("plugin network api: explicit decisions persist terminal state without repeated requests or accidental grants", async () => {
  const b = await apiFixture();
  try {
    await b.ready();
    let view = await b.view();
    const request = view.pendingRequests[0];
    assert(request);
    const pending = await b.get("permission-requests");
    assertEquals(pending.status, 200);
    assert(
      (await pending.json()).some((entry: { id: string }) =>
        entry.id === request.id
      ),
    );
    const decision = await fetch(
      `${b.base}/_/api/plugin-host/networked/permission-requests/${request.id}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          b.controls(view, {
            decision: "deny",
            allowNetwork: true,
            approvedNetwork: [{ type: "host", authority: b.authority }],
          }),
        ),
        signal: AbortSignal.timeout(3000),
      },
    );
    assertEquals(decision.status, 200);
    view = (await decision.json()).view;
    assertEquals(view.allowNetwork, false);
    assertEquals(view.approvedNetwork, []);
    assertEquals(view.pendingRequests, []);
    const repeated = await b.invoke("request");
    assertEquals(repeated.status, 200);
    const admission = (await repeated.json()).result;
    assertEquals(admission.requestId, request.id);
    assertEquals(admission.status, "denied");
    assertEquals((await b.view()).pendingRequests, []);
    assertEquals(b.traffic(), 0);
    const approve = await fetch(
      `${b.base}/_/api/plugin-host/networked/permission-requests/${request.id}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          b.controls(view, {
            decision: "approve",
            allowNetwork: false,
            approvedNetwork: [{ type: "host", authority: b.authority }],
          }),
        ),
        signal: AbortSignal.timeout(3000),
      },
    );
    assertEquals(approve.status, 200);
    view = (await approve.json()).view;
    assertEquals(view.allowNetwork, false);
    assertEquals(view.effectiveNetwork, []);
    const approved = await b.invoke("request");
    assertEquals((await approved.json()).result.status, "approved");
    const removed = await b.put(b.controls(view, { approvedNetwork: [] }));
    assertEquals(removed.status, 200);
    await removed.body?.cancel();
    const revoked = await b.invoke("request");
    assertEquals((await revoked.json()).result.status, "revoked");
    assertEquals((await b.view()).pendingRequests, []);
    assertEquals(b.traffic(), 0);
  } finally {
    await b.close();
  }
});

Deno.test("plugin network api: malformed scopes, unknown control fields and oversized JSON never mutate the ledger", async () => {
  const b = await apiFixture();
  try {
    await b.ready();
    const view = await b.view();
    const file = `${b.fixture.statePath}/plugin-network/networked.json`;
    const bytes = await Deno.readTextFile(file);
    for (
      const update of [
        {
          approvedNetwork: [{
            type: "host",
            authority: "https://example.com/path",
          }],
        },
        {
          approvedNetwork: [{
            type: "host",
            authority: "unrequested.example:443",
          }],
        },
        { approvedNetwork: [{ type: "all" }] },
        { requestSourceKey: "0".repeat(64) },
        { allowNetwork: "yes" },
        { approve: true },
      ]
    ) {
      const response = await b.put(b.controls(view, update));
      assert([409, 422].includes(response.status));
      await response.body?.cancel();
      assertEquals(await Deno.readTextFile(file), bytes);
    }
    const invalid = await fetch(
      `${b.base}/_/api/plugin-host/networked/permissions`,
      { method: "PUT", body: "{broken", signal: AbortSignal.timeout(3000) },
    );
    assertEquals(invalid.status, 422);
    await invalid.body?.cancel();
    const oversized = await fetch(
      `${b.base}/_/api/plugin-host/networked/permissions`,
      {
        method: "PUT",
        body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
        signal: AbortSignal.timeout(3000),
      },
    );
    assertEquals(oversized.status, 413);
    await oversized.body?.cancel();
    assertEquals(await Deno.readTextFile(file), bytes);
  } finally {
    await b.close();
  }
});

Deno.test("plugin network api: corrupted control bytes are retained and cannot be overwritten by operator decisions", async () => {
  const b = await apiFixture();
  try {
    await b.ready();
    const view = await b.view();
    const file = `${b.fixture.statePath}/plugin-network/networked.json`;
    for (const bytes of ["{broken", JSON.stringify({ schemaVersion: 99 })]) {
      await Deno.writeTextFile(file, bytes);
      const response = await b.get("networked/permissions");
      assertEquals(response.status, 409);
      await response.body?.cancel();
      const mutation = await b.put(
        b.controls(view, {
          allowNetwork: true,
          approvedNetwork: [{ type: "host", authority: b.authority }],
        }),
      );
      assertEquals(mutation.status, 409);
      await mutation.body?.cancel();
      assertEquals(await Deno.readTextFile(file), bytes);
      assertEquals(b.traffic(), 0);
    }
  } finally {
    await b.close();
  }
});

Deno.test("plugin network api: setup, password and read-only enforcement cover the new host routes", async () => {
  for (const mode of ["", "password", "read_only"]) {
    const b = await apiFixture({
      GLOBNOTES_AUTH_TYPE: mode,
      GLOBNOTES_USERNAME: "fixture-user",
      GLOBNOTES_PASSWORD: "fixture-password",
      GLOBNOTES_SECRET_KEY: crypto.randomUUID(),
    });
    try {
      const response = await b.get("networked/permissions");
      assertEquals(
        response.status,
        mode === "" ? 503 : mode === "password" ? 401 : 200,
      );
      await response.body?.cancel();
      const pending = await b.get("permission-requests");
      assertEquals(
        pending.status,
        mode === "" ? 503 : mode === "password" ? 401 : 200,
      );
      await pending.body?.cancel();
      const mutation = await b.put({ allowNetwork: true });
      assertEquals(
        mutation.status,
        mode === "" ? 503 : mode === "password" ? 401 : 403,
      );
      await mutation.body?.cancel();
      const decision = await fetch(
        `${b.base}/_/api/plugin-host/networked/permission-requests/not-current/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(3000),
        },
      );
      assertEquals(
        decision.status,
        mode === "" ? 503 : mode === "password" ? 401 : 403,
      );
      await decision.body?.cancel();
      assertEquals(b.traffic(), 0);
    } finally {
      await b.close();
    }
  }
});

Deno.test("plugin network api: prefixed control routes preserve consent and reject mismatched paths", async () => {
  const b = await apiFixture({ GLOBNOTES_PATH_PREFIX: "/notes" });
  try {
    await b.ready();
    const view = await b.view();
    assertEquals(view.pluginId, "networked");
    const saved = await b.put(
      b.controls(view, {
        allowNetwork: false,
        approvedNetwork: [{ type: "host", authority: b.authority }],
      }),
    );
    assertEquals(saved.status, 200);
    assertEquals((await saved.json()).view.approvedNetwork, [{
      type: "host",
      authority: b.authority,
    }]);
    const mismatch = await fetch(
      `${b.server.baseUrl}/notes-other/_/api/plugin-host/networked/permissions`,
      { signal: AbortSignal.timeout(3000) },
    );
    assertEquals(mismatch.status, 404);
    await mismatch.body?.cancel();
    assertEquals(b.traffic(), 0);
  } finally {
    await b.close();
  }
});
