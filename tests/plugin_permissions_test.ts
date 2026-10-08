// SPDX-License-Identifier: LGPL-3.0-only

/** Permission boundary tests: service raw filesystem denial, mediated grant
 * checks, reserved-state exclusion, read-only policy enforcement on plugin
 * writes, and no credential transport into worker payloads. */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { GlobalConfig } from "../server/config.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import { PluginActions } from "../server/plugins/actions.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { servicePluginRpc } from "../server/plugins/rpc.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { initState, state } from "../server/state.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";

async function serviceBundle(opts: {
  manifest: Record<string, unknown>;
  service: string;
  authType?: string;
  stateInVault?: boolean;
  retain?: boolean;
}) {
  const fixture = await pluginFixture({ stateInVault: opts.stateInVault });
  await fixture.install("svc", opts.manifest, { "service.js": opts.service });
  const env = {
    GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES_INDEX_PATH: fixture.statePath,
    GLOBNOTES_AUTH_TYPE: opts.authType ?? "none",
  };
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    prev[key] = Deno.env.get(key);
    Deno.env.set(key, value);
  }
  const config = new GlobalConfig();
  const notes = new FileSystemNotes(fixture.vault);
  const indexer = new Fts5Indexer(fixture.statePath);
  const files = new FileServing(fixture.vault);
  const manager = new PluginManager(
    fixture.vault,
    undefined,
    1,
    fixture.statePath,
    {
      internalRoot: path.join(fixture.root, "internal"),
      renderWritable: () => lifecycle.writable(),
    },
  );
  initState(config, null, notes, indexer, files, manager);
  const lifecycle = new PluginLifecycle(config);
  const operations = new NoteOperations({
    notes,
    files,
    indexer,
    runtime: () => manager.runtime,
    lifecycle,
  });
  const actions = new PluginActions({
    operations,
    runtime: () => manager.runtime,
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
  });
  state.lifecycle = lifecycle;
  state.operations = operations;
  state.actions = actions;
  const runtime = manager.configureRuntime({
    operational: () => lifecycle.operational(),
    writable: () => lifecycle.writable(),
    commit: (effect) => lifecycle.gate.run(effect),
    rpc: servicePluginRpc({
      vaultPath: fixture.vault,
      statePath: fixture.statePath,
      actions: () => actions,
    }),
  });
  await runtime.reconcile();
  const deadline = Date.now() + 5000;
  while (
    runtime.status("svc")?.status === "starting" && Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return {
    fixture,
    runtime,
    lifecycle,
    manager,
    indexer,
    async dispose() {
      await runtime.close();
      manager.stop();
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      if (!opts.retain) await fixture.dispose();
    },
  };
}

for (const grants of [[], ["z-visible"]]) {
  Deno.test(`review repairs: R11 real service resolver selects only ${grants.length ? "eligible" : "no"} basename and alias candidates`, async () => {
    const previous = { ...state };
    const b = await serviceBundle({
      retain: true,
      manifest: {
        runtime: { server: "service.js" },
        capabilities: { read: grants },
      },
      service: `export function activate(ctx) {
        ctx.commands.register({ id: 'resolve', label: 'Resolve', target: 'server' }, async () => ({
          basename: await ctx.resolvePath(' Shared '),
          alias: await ctx.resolvePath(' SameAlias '),
          hiddenAlias: await ctx.resolvePath(' HiddenOnly '),
          missing: await ctx.resolvePath(' Missing '),
        }));
      }`,
    });
    try {
      for (const folder of ["a-hidden", "z-visible"]) {
        Deno.mkdirSync(`${b.fixture.vault}/${folder}`);
        Deno.writeTextFileSync(
          `${b.fixture.vault}/${folder}/Shared.md`,
          `---\naliases: [SameAlias${
            folder === "a-hidden" ? ", HiddenOnly" : ""
          }]\n---\n# ${folder} content\n`,
        );
        b.indexer.reindexNote(`${folder}/Shared`);
      }
      const result = await b.runtime.invokeCommand("svc", "resolve", {});
      console.log(
        JSON.stringify({
          grants,
          resolverConsumer: result,
          retainedResolverFixture: b.fixture.root,
        }),
      );
      assertEquals(result, {
        basename: grants.length ? "z-visible/Shared" : "Shared",
        alias: grants.length ? "z-visible/Shared" : "SameAlias",
        hiddenAlias: "HiddenOnly",
        missing: "Missing",
      });
    } finally {
      await b.dispose();
      Object.assign(state, previous);
    }
  });
}

for (const stateInVault of [false, true]) {
  Deno.test(`review repairs: R12 real render mediated reads exclude ${stateInVault ? "visible in-vault and aliased" : "relocated"} host state while legacy raw authority is separate`, async () => {
    const previous = { ...state };
    const b = await serviceBundle({
      retain: true,
      stateInVault,
      manifest: { runtime: { server: "service.js" } },
      service: "export function activate() {}",
    });
    try {
      Deno.writeTextFileSync(
        `${b.fixture.vault}/Public.md`,
        "# Public\nneedle public consumer\n",
      );
      const note = `${b.fixture.statePath}/Host.md`,
        body = "---\naliases: [PrivateAlias]\n---\nneedle PRIVATE HOST STATE\n";
      Deno.writeTextFileSync(note, body);
      Deno.mkdirSync(`${b.fixture.statePath}/plugin-data/renderer`, {
        recursive: true,
      });
      Deno.mkdirSync(`${b.fixture.statePath}/plugin-data/other`, {
        recursive: true,
      });
      Deno.writeTextFileSync(
        `${b.fixture.statePath}/plugin-data/renderer/data.json`,
        '{"private":"OWN HOST DATA"}',
      );
      Deno.writeTextFileSync(
        `${b.fixture.statePath}/plugin-data/other/data.json`,
        '{"private":"OTHER HOST DATA"}',
      );
      Deno.writeTextFileSync(
        `${b.fixture.statePath}/config.json`,
        '{"auth_type":"none","host_config_marker":"PRIVATE CONFIG"}',
      );
      if (stateInVault) {
        Deno.symlinkSync(note, `${b.fixture.vault}/Alias-state.md`);
      }
      b.indexer.reindexNote("Public");
      if (stateInVault) {
        b.indexer.reindexNote("State/Host");
        b.indexer.reindexNote("Alias-state");
      }
      await b.fixture.install("renderer", {
        capabilities: { read: ["vault", b.fixture.statePath] },
      }, {
        "main.js": `export function getSelectors() { return [{node: 'fence'}]; }
          export async function parseNode(paths, ctx) {
            const attempt = async (run) => { try { return {ok: await run()}; } catch(error) {return {error: error.message};} };
            return {
              public: await ctx.readNote('Public'),
              stateFile: await attempt(() => ctx.readFile(paths.config)),
              own: await attempt(() => ctx.readFile(paths.own)),
              other: await attempt(() => ctx.readFile(paths.other)),
              stateNote: await attempt(() => ctx.readNote(paths.note)),
              aliasNote: paths.alias ? await attempt(() => ctx.readNote(paths.alias)) : null,
              list: await ctx.listPaths(), search: await ctx.search('needle'),
              alias: await ctx.resolvePath('PrivateAlias'),
              raw: Deno.readTextFileSync(paths.raw),
            };
          }`,
      });
      await b.manager.start();
      const host = b.manager.hosts.get("renderer")!;
      // The owning manager must keep its root binding when unrelated global
      // configuration is replaced; note/files/index consumers remain this fixture's.
      const alien = `${b.fixture.root}/alien-state`;
      Deno.mkdirSync(alien);
      Deno.env.set("GLOBNOTES_INDEX_PATH", alien);
      state.config = new GlobalConfig();
      const stateDirectory = stateInVault ? "State" : "../relocated-state";
      if (stateInVault) {
        assert(
          new TextDecoder().decode(state.files.get("State/config.json").body)
            .includes("PRIVATE CONFIG"),
        );
      }
      const result = await host.call("parseNode", [{
        config: `${stateDirectory}/config.json`,
        own: `${stateDirectory}/plugin-data/renderer/data.json`,
        other: `${stateDirectory}/plugin-data/other/data.json`,
        raw: `${b.fixture.statePath}/config.json`,
        note: `${stateDirectory}/Host`,
        alias: stateInVault ? "Alias-state" : null,
      }]) as {
        public: { content: string };
        stateFile: { error?: string };
        own: { error?: string };
        other: { error?: string };
        stateNote: { error?: string };
        aliasNote: { error?: string } | null;
        list: string[];
        search: { path: string }[];
        alias: string;
        raw: string;
      };
      console.log(JSON.stringify({
        stateInVault,
        mediatedStateFileDenied: !!result.stateFile.error,
        mediatedOwnDataDenied: !!result.own.error,
        mediatedOtherDataDenied: !!result.other.error,
        paths: result.list,
        searchPaths: result.search.map((entry) => entry.path),
        alias: result.alias,
        legacyRawReadRetained: result.raw.includes("PRIVATE CONFIG"),
        retainedRenderReadFixture: b.fixture.root,
      }));
      assertEquals(result.public.content, "# Public\nneedle public consumer\n");
      assert(result.stateFile.error);
      assert(result.own.error);
      assert(result.other.error);
      assert(result.stateNote.error);
      if (stateInVault) assert(result.aliasNote?.error);
      assertEquals(result.list, ["Public"]);
      assertEquals(result.search.map((entry) => entry.path), ["Public"]);
      assertEquals(result.alias, "PrivateAlias");
      assert(
        result.raw.includes("PRIVATE CONFIG"),
        "explicit legacy raw read is an independent compatibility control",
      );
    } finally {
      await b.dispose();
      Object.assign(state, previous);
      console.log(JSON.stringify({ retainedR12Fixture: b.fixture.root }));
    }
  });
}

Deno.test("review repairs: R12 render with empty read grants cannot borrow host note file search listing or resolver authority", async () => {
  const previous = { ...state };
  const b = await serviceBundle({
    retain: true,
    manifest: { runtime: { server: "service.js" } },
    service: "export function activate() {}",
  });
  try {
    Deno.writeTextFileSync(
      `${b.fixture.vault}/Public.md`,
      "---\naliases: [PublicAlias]\n---\nneedle public\n",
    );
    b.indexer.reindexNote("Public");
    await b.fixture.install("empty-render", { capabilities: { read: [] } }, {
      "main.js": `export function getSelectors() { return [{node: 'fence'}]; }
      export async function parseNode(node, ctx) {
        const denied = async (run) => { try { await run(); return false; } catch { return true; } };
        return { noteDenied: await denied(() => ctx.readNote('Public')), fileDenied: await denied(() => ctx.readFile('Public.md')), list: await ctx.listPaths(), search: await ctx.search('needle'), alias: await ctx.resolvePath('PublicAlias') };
      }`,
    });
    await b.manager.start();
    const result = await b.manager.hosts.get("empty-render")!.call(
      "parseNode",
      [{}],
    );
    console.log(
      JSON.stringify({
        emptyRenderGrantConsumer: result,
        retainedEmptyRenderFixture: b.fixture.root,
      }),
    );
    assertEquals(result, {
      noteDenied: true,
      fileDenied: true,
      list: [],
      search: [],
      alias: "PublicAlias",
    });
  } finally {
    await b.dispose();
    Object.assign(state, previous);
  }
});

Deno.test("permissions: mediated reads honor grants and reserved state is withheld", async () => {
  const b = await serviceBundle({
    manifest: {
      runtime: { server: "service.js" },
      capabilities: { read: ["sub"], write: [] },
    },
    service: `export function activate(ctx) {
      const attempt = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { error: e.message }; } };
      ctx.commands.register({ id: 'probe', label: 'Probe', target: 'server' }, async () => ({
        inside: await attempt(() => ctx.files.read('sub/note.md')),
        outside: await attempt(() => ctx.files.read('secret.md')),
        state: await attempt(() => ctx.files.read('../relocated-state/config.json')),
        absolute: await attempt(() => ctx.files.read('/etc/hostname')),
        raw: await attempt(() => Deno.readTextFileSync('/etc/hostname')),
        search: await attempt(() => ctx.search('hidden')),
        list: await attempt(() => ctx.listPaths()),
      }));
    }`,
  });
  try {
    Deno.mkdirSync(path.join(b.fixture.vault, "sub"), { recursive: true });
    Deno.writeTextFileSync(
      path.join(b.fixture.vault, "sub", "note.md"),
      "# Sub\n",
    );
    Deno.writeTextFileSync(
      path.join(b.fixture.vault, "secret.md"),
      "hidden treasure",
    );
    const result = await b.runtime.invokeCommand("svc", "probe", {}) as {
      inside: { ok?: { body: Uint8Array } };
      outside: { error?: string };
      state: { error?: string };
      absolute: { error?: string };
      raw: { error?: string };
      search: { ok?: unknown[] };
      list: { ok?: string[] };
    };
    // Granted path reads through the mediated facade.
    assertEquals(new TextDecoder().decode(result.inside.ok!.body), "# Sub\n");
    // Outside grants, reserved state, and absolute escapes all denied.
    assert(result.outside.error !== undefined);
    assert(result.state.error !== undefined);
    assert(result.absolute.error !== undefined);
    // Raw filesystem authority is narrower than the mediated facade allows.
    assert(result.raw.error !== undefined);
    // Result-level grant checks: search/listings exclude ungranted paths.
    assertEquals(result.search.ok, []);
    assertEquals(result.list.ok, ["sub/note"]);
  } finally {
    await b.dispose();
  }
});

Deno.test("permissions: read-only vault denies plugin data and file writes but keeps reads", async () => {
  const b = await serviceBundle({
    authType: "read_only",
    manifest: { runtime: { server: "service.js" } },
    service: `export function activate(ctx) {
      const attempt = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { error: e.message }; } };
      ctx.commands.register({ id: 'probe', label: 'Probe', target: 'server' }, async () => ({
        dataWrite: await attempt(async () => { const d = await ctx.data.load(); await ctx.data.save(d.values, d.revision); }),
        action: await attempt(() => ctx.actions.request('create', { path: 'x', content: 'y' })),
        read: await attempt(() => ctx.listPaths()),
      }));
    }`,
  });
  try {
    const result = await b.runtime.invokeCommand("svc", "probe", {}) as {
      dataWrite: { error?: string };
      action: { error?: string };
      read: { ok?: unknown };
    };
    assert(result.dataWrite.error !== undefined, "data write not denied");
    assert(result.action.error !== undefined, "action request not denied");
    assert(result.read.ok !== undefined, "reads should still work");
  } finally {
    await b.dispose();
  }
});

Deno.test("permissions: setup-pending revokes runtime; writes after reset are rejected", async () => {
  const b = await serviceBundle({
    manifest: { runtime: { server: "service.js" } },
    service: `export function activate(ctx) {
      ctx.commands.register({ id: 'write', label: 'Write', target: 'server' }, async () => {
        const d = await ctx.data.load();
        await ctx.data.save({ ...d.values, n: 1 }, d.revision);
        return 'written';
      });
    }`,
  });
  try {
    assertEquals(await b.runtime.invokeCommand("svc", "write", {}), "written");
    // Access transition: epoch first, old generations terminated.
    b.lifecycle.bumpEpoch();
    b.runtime.suspend();
    // Setup becomes pending (config mutated as the reset endpoint does).
    state.config.setupRequired = true;
    state.config.authType = null;
    await b.runtime.reconcile();
    assertEquals(b.runtime.status("svc")?.status, "discovered");
    await assertRejectsMessage(
      () => b.runtime.invokeCommand("svc", "write", {}),
      "unavailable",
    );
    const dataFile = path.join(
      b.fixture.statePath,
      "plugin-data",
      "svc",
      "data.json",
    );
    const raw = JSON.parse(Deno.readTextFileSync(dataFile));
    assertEquals(raw.values, { n: 1 });
  } finally {
    await b.dispose();
  }
});

async function assertRejectsMessage(fn: () => Promise<unknown>, part: string) {
  let error: Error | null = null;
  try {
    await fn();
  } catch (e) {
    error = e as Error;
  }
  assert(
    error !== null && error.message.includes(part),
    `expected rejection containing '${part}', got ${error}`,
  );
}
