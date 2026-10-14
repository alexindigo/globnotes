// Production-assets native consumers. Every target, server, variant and artifact is owned.
import { nativeSession } from "./native-cdp-session.mjs";
import { bootServer } from "./harness-helpers.mjs";
import { executeChild } from "./legacy-native-suite.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const kinds = ["count", "order", "location", "preimage", "pin", "recovery", "aliases", "distinct", "retarget", "cleanup"];
const options = { artifacts: null, controls: false, case: null, negative: false }, seen = new Set();
for (let index = 0; index < Deno.args.length; index++) {
  const flag = Deno.args[index];
  if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
  seen.add(flag);
  if (flag === "--artifacts") options.artifacts = Deno.args[++index];
  else if (flag === "--controls") options.controls = true;
  else if (flag === "--case") options.case = Deno.args[++index];
  else if (flag === "--negative") options.negative = true;
  else throw new Error(`Unknown argument: ${flag}`);
}
if (!options.artifacts?.startsWith("/") || options.controls && options.case || options.case && ![...kinds, "failure", "settings-lock"].includes(options.case) || options.negative && !options.case) throw new Error("A fresh absolute artifact directory and valid mode are required");
await Deno.mkdir(options.artifacts, { mode: 0o700 });
const artifacts = options.artifacts, assert = (value, message) => { if (!value) throw new Error(message); };
const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}; actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
const deltas = {
  count: [["const planned = stages.slice(0, config.count)", "const planned = stages.slice(0, Math.min(3, config.count + 1))"], ["Math.min(journal.count, journal.old.length + 1)", "Math.min(Math.min(3, journal.count + 1), journal.old.length + 1)"]],
  order: [["const planned = stages.slice(0, config.count)", "const planned = stages.slice(0, config.count).reverse()"], ["slot.hash !== journal.stages[index].hash", "slot.hash !== journal.stages[journal.planned.length - index - 1].hash"], ["this.#verifiedFile(state.stages[index].file, slot.hash, config)", "this.#verifiedFile(state.stages[state.planned.length - index - 1].file, slot.hash, config)"]],
  location: [["root = workspace.vault;", "root = join(workspace.vault, 'misplaced');"]],
  preimage: [["content: before.content", "content: fact.after?.content ?? before.content"]],
  pin: [["base: values.basePath", "base: ''"]],
  recovery: [["if (metadata?.value.operationKey === state.operationKey)", "if (false && metadata?.value.operationKey === state.operationKey)"]],
  cleanup: [["this.#remember(state.operationKey);", "this.#remember(state.operationKey); this.#status.pendingRecovery=false; return {completed:true};"]],
  aliases: [["JSON.stringify([root, captured.path])", "JSON.stringify([config.base, captured.path])"], ["JSON.stringify([state.root, state.path])", "JSON.stringify([state.base, state.path])"]],
  distinct: [["const canonical = await fs.stat(root, options);", "root = workspace.vault; const canonical = await fs.stat(root, options);"]],
  retarget: [["#slot(root, path, index) { return join(root,", "#slot(root, path, index) { return join(this.#status.configuration.basePath || root,"]],
};
async function copyTree(from, to, relative = "") {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if ([".git", "node_modules", "client/.vite"].includes(name)) continue;
    if (entry.isDirectory) await copyTree(`${from}/${entry.name}`, `${to}/${entry.name}`, name);
    else if (entry.isSymlink) await Deno.symlink(await Deno.readLink(`${from}/${entry.name}`), `${to}/${entry.name}`);
    else await Deno.copyFile(`${from}/${entry.name}`, `${to}/${entry.name}`);
  }
}
if (options.controls) {
  const outcomes = [], original = await Deno.readTextFile(`${ROOT}/plugins/globnotes-backup/backup.js`);
  for (const kind of kinds) {
    for (const mode of ["healthy", "broken"]) {
      const directory = `${artifacts}/${kind}-${mode}`; await Deno.mkdir(directory);
      const source = `${directory}/source`; await copyTree(ROOT, source);
      for (const name of ["deno.json", "deno.lock"]) equal(await Deno.readTextFile(`${source}/${name}`), await Deno.readTextFile(`${ROOT}/${name}`), "Locked dependency inputs must match before cache reuse");
      assert((await Deno.stat(`${ROOT}/node_modules`)).isDirectory, "Installed dependency reference unavailable");
      await Deno.symlink(`${ROOT}/node_modules`, `${source}/node_modules`);
      await Deno.writeTextFile(`${directory}/dependency-custody.json`, JSON.stringify({ reference: `${ROOT}/node_modules`, selected: `${source}/node_modules`, configAndLockBytesMatch: true, sourceOnlyVariant: true }, null, 2), { createNew: true });
      let text = original;
      if (mode === "broken") for (const [before, after] of deltas[kind]) { equal(text.split(before).length - 1, 1, "variant match count"); text = text.replace(before, after); }
      await Deno.writeTextFile(`${source}/plugins/globnotes-backup/backup.js`, text);
      await Deno.writeTextFile(`${directory}/variant.json`, JSON.stringify({ kind, mode, source, delta: mode === "broken" ? deltas[kind] : [], originalSource: original, variantSource: text }, null, 2), { createNew: true });
      const result = await executeChild(["run", "--cached-only", "--frozen", `--config=${source}/deno.json`, "--unstable-worker-options", "--allow-read", "--allow-write", "--allow-env", "--allow-run", "--allow-net", "--allow-sys", `${source}/client/tests/e2e/backup-plugin.mjs`, "--case", kind, ...(mode === "broken" ? ["--negative"] : []), "--artifacts", `${directory}/consumers`], { artifacts: directory, label: "child", timeout: 120000 });
      assert(!result.timedOut, `${kind}: timeout is not intended consumer failure`);
      if (mode === "healthy") {
        assert(result.code === 0, `${kind}: healthy producer failed`);
        const summary = JSON.parse(await Deno.readTextFile(`${directory}/consumers/summary.json`));
        equal(summary.selected, [kind], `${kind}: complete healthy selection`);
        assert(summary.outcomes.length === 1 && summary.outcomes[0].label === kind && summary.outcomes[0].completed, `${kind}: complete healthy records`);
        const consumer = JSON.parse(await Deno.readTextFile(`${summary.outcomes[0].directory}/consumers.json`));
        assert(consumer.status.status === 200 && consumer.pageErrors.length === 0, `${kind}: actual healthy API/browser consumer`);
      }
      else {
        assert(result.code !== 0 && new TextDecoder().decode(result.stderr).includes(`BACKUP_NATIVE_${kind}`), `${kind}: wrong producer failed outside named native consumer`);
        const negative = JSON.parse(await Deno.readTextFile(`${directory}/consumers/negative-consumer.json`));
        assert(negative.namedConsumer === `BACKUP_NATIVE_${kind}` && negative.observed && negative.ownedResourcesClosedAfterCustody, `${kind}: incomplete negative consumer records`);
      }
      outcomes.push({ kind, mode, code: result.code, timedOut: result.timedOut });
    }
  }
  equal(await Deno.readTextFile(`${ROOT}/plugins/globnotes-backup/backup.js`), original, "Original producer unchanged");
  await Deno.writeTextFile(`${artifacts}/controls.json`, JSON.stringify({ kinds, outcomes }, null, 2), { createNew: true });
  console.log("BACKUP PLUGIN CONTROLS OK", JSON.stringify(outcomes));
} else {
  const outcomes = [], fixtures = [];
  let current;
  async function api(route, method = "GET", body) {
    const response = await fetch(current.server.baseUrl + route, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json() };
  }
  const settings = () => api("/_/api/plugin-host/globnotes-backup/settings/backup");
  const status = () => api("/_/api/plugins/globnotes-backup/status");
  async function picture(name, session = current.session) {
    const { data } = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await Deno.writeFile(`${current.directory}/${name}.png`, Uint8Array.from(atob(data), c => c.charCodeAt(0)), { createNew: true });
  }
  async function launch(env) {
    const directory = `${current.directory}/backend-${++current.generation}`; await Deno.mkdir(directory);
    const NativeCommand = Deno.Command, admitted = Promise.withResolvers();
    const samples = []; let finished = false;
    Deno.Command = class extends NativeCommand {
      constructor(command, options) {
        super(command, options);
        if (options?.args?.some(argument => argument.replace(/\/+/g, "/") === `${ROOT}/server/main.ts`)) admitted.resolve({ baseUrl: `http://127.0.0.1:${options.env.GLOBNOTES_PORT}`, vault: options.env.GLOBNOTES_PATH });
      }
    };
    const boot = bootServer(current.vault, current.state, { env, logsDir: directory });
    Deno.Command = NativeCommand;
    const observe = (async () => {
      const owner = await admitted.promise;
      assert(owner.vault === current.vault, "Startup observation must own this fixture");
      if (!owner.baseUrl) return;
      while (!finished) {
        try {
          const response = await fetch(`${owner.baseUrl}/_/api/plugin-host`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) { const catalog = await response.json(); samples.push({ time: Date.now(), plugins: catalog.plugins.map(plugin => ({ id: plugin.id, status: plugin.status, diagnostics: plugin.diagnostics })) }); }
          else await response.body?.cancel();
        } catch (error) { samples.push({ time: Date.now(), unavailable: error.name }); }
        if (!finished) await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    try { current.server = await boot; }
    finally { finished = true; admitted.resolve({ baseUrl: null, vault: current.vault }); await observe; await Deno.writeTextFile(`${directory}/startup-catalogs.json`, JSON.stringify(samples, null, 2), { createNew: true }); }
    current.servers.push({ pid: current.server.pid, baseUrl: current.server.baseUrl, directory });
  }
  async function fixture(label, env = {}, seed = null) {
    assert(fixtures.every(item => item.closed), "A prior fixture still owns resources");
    const directory = `${artifacts}/${label}`; await Deno.mkdir(directory);
    current = { label, directory, vault: `${directory}/vault`, state: `${directory}/state`, generation: 0, servers: [], closed: false };
    fixtures.push(current);
    await Deno.mkdir(current.vault); await Deno.mkdir(current.state);
    await Deno.mkdir(`${current.vault}/misplaced`); await Deno.mkdir(`${current.vault}/dedicated`);
    await Deno.writeTextFile(`${current.vault}/Note.md`, "A");
    await Deno.writeTextFile(`${current.state}/config.json`, JSON.stringify({ auth_type: "none", ...(label === "settings-lock" ? { read_only_settings: true } : {}) }));
    if (seed) { await Deno.mkdir(`${current.state}/plugin-data/globnotes-backup`, { recursive: true }); await Deno.writeTextFile(`${current.state}/plugin-data/globnotes-backup/settings.json`, JSON.stringify({ schemaVersion: 1, revision: 1, values: { backup: seed } })); }
    if (["recovery", "cleanup", "retarget"].includes(label)) {
      const plugin = `${current.state}/plugins/globnotes-backup`; await copyTree(`${ROOT}/plugins/globnotes-backup`, plugin);
      const file = `${plugin}/backup.js`, text = await Deno.readTextFile(file), target = label !== "retarget" ? "metadata = await writeRecord(fs, metadataPath, next, metadata, options);" : "const completed = [];";
      equal(text.split(target).length - 1, 1, "fault/barrier seam");
      const injection = label !== "retarget" ? `${target}\n      if(!globalThis.__backupNativeInterrupted){globalThis.__backupNativeInterrupted=true;throw new BackupError('native_recorded_interruption');}`
        : `${target}\n      if((globalThis.__backupNativePublications=(globalThis.__backupNativePublications??0)+1)===2){
          await fs.writeFile(join(workspace.location,'retarget-ready'),new Uint8Array([1]),{...options,expect:{kind:'absent'}});
          await new Promise((resolve,reject)=>{const release=this.ctx.timers.setInterval(async()=>{try{if(await fs.stat(join(workspace.location,'retarget-release'),options)){release();resolve();}}catch(error){release();reject(error);}},10);});
        }`;
      const mutated = text.replace(target, injection);
      await Deno.writeTextFile(file, mutated);
      await Deno.writeTextFile(`${directory}/fault-source.json`, JSON.stringify({ file, before: text, after: mutated }), { createNew: true });
    }
    await launch(env);
    current.session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
    await current.session.goto(`${current.server.baseUrl}/Note`);
    await current.session.poll("!!document.querySelector('.toast-viewer')");
    await current.session.evaluate("document.fonts.ready.then(()=>true)");
    await Deno.writeTextFile(`${directory}/ownership.json`, JSON.stringify({ vault: current.vault, state: current.state, pid: current.server.pid, baseUrl: current.server.baseUrl, targetId: current.session.targetId, browserContextId: current.session.browserContextId }, null, 2), { createNew: true });
  }
  async function open() {
    const session = current.session;
    if (!await session.evaluate("!!document.querySelector('#settings-modal-title')")) {
      if (await session.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')")) await session.click('[title="Open sidebar"]');
      await session.click('[aria-label="Settings"]'); await session.poll("!!document.querySelector('#settings-modal-title')");
    }
    await session.button("Backups");
    await session.poll(`!!document.querySelector('#settings-field-retention') && document.querySelector('#settings-field-retention').value !== '' ${current.label === 'settings-lock' ? '' : "&& !document.querySelector('#settings-field-retention').disabled"}`);
    await session.evaluate("document.fonts.ready.then(()=>true)");
  }
  async function closeSettings() { await current.session.click('[aria-label="Close settings"]'); await current.session.poll("!document.querySelector('#settings-modal-title')"); }
  async function retention(count) {
    const session = current.session;
    await session.click("#settings-field-retention");
    await session.poll("document.activeElement === document.querySelector('#settings-field-retention')");
    await session.key("Home", { windowsVirtualKeyCode: 36 });
    for (let index = 1; index < count; index++) await session.key("ArrowRight", { windowsVirtualKeyCode: 39 });
    await session.poll(`document.querySelector('#settings-field-retention').value === '${count}'`);
    await session.key("Enter", { windowsVirtualKeyCode: 13 });
    await session.poll(`fetch('/_/api/plugin-host/globnotes-backup/settings/backup').then(r=>r.json()).then(v=>v.values.retention===${count})`);
  }
  async function base(value) {
    const session = current.session;
    await session.click("#settings-field-basePath"); await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    if (value) await session.type(value); else await session.key("Backspace", { windowsVirtualKeyCode: 8 });
    await session.key("Enter", { windowsVirtualKeyCode: 13 });
    await session.poll(`fetch('/_/api/plugin-host/globnotes-backup/settings/backup').then(r=>r.json()).then(v=>v.values.basePath===${JSON.stringify(value)})`);
  }
  async function save(path, value) {
    const ack = await api(`/_/api/notes/${path}`, "PATCH", { newContent: value });
    equal(ack.status, 200, "managed save acknowledgement");
    equal(await Deno.readTextFile(`${current.vault}/${path}.md`), value, "live saved bytes");
    const settled = await status(); equal(settled.status, 200, "actual plugin status endpoint"); return settled.body;
  }
  async function ring(root, path, expected, kind) {
    const observed = [];
    for (let index = 0; index < 10; index++) {
      try { observed.push(await Deno.readTextFile(`${root}/${path}.md.${index}.bak`)); }
      catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; observed.push(null); }
    }
    await Deno.writeTextFile(`${current.directory}/ring-${current.rings = (current.rings ?? 0) + 1}.json`, JSON.stringify({ root, path, observed, expected, status: await status() }, null, 2), { createNew: true });
    equal(observed, [...expected, ...Array(10 - expected.length).fill(null)], `BACKUP_NATIVE_${kind}: exact ordered owned physical slots`);
    return observed;
  }
  async function finish(label, consumers) {
    assert(current.session.errors.length === 0, "Unexpected browser runtime exception");
    const result = { label, consumers, settings: await settings(), status: await status(), servers: current.servers, pageErrors: current.session.errors, events: current.session.events };
    await Deno.writeTextFile(`${current.directory}/consumers.json`, JSON.stringify(result, null, 2), { createNew: true });
    await current.session.close(); await current.server.close(); current.closed = true;
    outcomes.push({ label, completed: true, directory: current.directory });
  }
  async function restart(env = {}) {
    await Deno.writeTextFile(`${current.directory}/restart-${current.generation}-before.json`, JSON.stringify({ settings: await settings(), status: await status(), live: await Deno.readTextFile(`${current.vault}/Note.md`) }, null, 2), { createNew: true });
    await current.server.close(); await launch(env);
    await current.session.goto(`${current.server.baseUrl}/Note`); await current.session.poll("!!document.querySelector('.toast-viewer')");
    await current.session.evaluate("document.fonts.ready.then(()=>true)");
  }
  try {
    const selected = options.case ? [options.case] : ["count", "aliases", "location", "pin", "recovery", "cleanup", "distinct", "retarget", "failure", "settings-lock"];
    for (const kind of selected) {
      if (["count", "order", "preimage"].includes(kind)) {
        await fixture(kind); await open();
        equal((await settings()).body.values.retention, 2, `BACKUP_NATIVE_${kind}: default2`);
        const rows = [];
        for (const count of options.case ? [2] : Array.from({ length: 10 }, (_, index) => index + 1)) {
          await retention(count); await closeSettings(); await open();
          equal(Number(await current.session.evaluate("document.querySelector('#settings-field-retention').value")), count, `BACKUP_NATIVE_${kind}: reopened slider`);
          if (count === 2) await picture("retention-slider");
          const path = options.case ? "Note" : `Count${count}`;
          if (!options.case) equal((await api("/_/api/notes", "POST", { path, content: "v0" })).status, 200, "native fixture note create");
          const history = [];
          if (options.case) { for (const value of ["B", "C", "D"]) await save(path, value); history.push("C", "B"); }
          else { for (let index = 1; index <= count + 2; index++) { history.unshift(`v${index - 1}`); await save(path, `v${index}`); } history.splice(count); }
          const observed = await ring(current.vault, path, history, kind); await closeSettings();
          await restart(); await open();
          equal((await settings()).body.values.retention, count, `BACKUP_NATIVE_${kind}: restarted persistence`);
          await ring(current.vault, path, history, kind);
          rows.push({ count, observed, numericPersistence: true, reopened: true, restarted: true });
          await closeSettings(); await open();
        }
        await finish(kind, rows);
      } else if (kind === "aliases") {
        await fixture(kind); await open(); await retention(5); await closeSettings();
        await save("Note", "B"); await Deno.symlink(current.vault, `${current.vault}/alias`);
        for (const [index, spelling] of [".", current.vault, "alias"].entries()) { await open(); await base(spelling); await closeSettings(); await save("Note", String.fromCharCode(67 + index)); }
        const observed = await ring(current.vault, "Note", ["D", "C", "B", "A"], kind);
        const families = [...Deno.readDirSync(`${current.vault}/.globnotes-backup`)].filter(entry => entry.name.startsWith("family-"));
        equal(families.length, 1, "BACKUP_NATIVE_aliases: one canonical family");
        await open(); await picture("canonical-location"); await finish(kind, { observed, families: families.map(row => row.name) });
      } else if (kind === "location") {
        await fixture(kind); await open();
        if (!options.case) await base("dedicated");
        await picture("base-location"); await closeSettings();
        const root = options.case ? current.vault : `${current.vault}/dedicated`;
        await save("Note", "B"); await save("Note", "C"); await save("Note", "D");
        const observed = await ring(root, "Note", ["C", "B"], kind);
        if (!options.case) {
          for (const [path, before, after] of [["a/雪", "A", "B"], ["b/雪", "X", "Y"]]) { equal((await api("/_/api/notes", "POST", { path, content: before })).status, 200, "nested fixture create"); await save(path, after); await ring(root, path, [before], kind); }
        }
        await finish(kind, { root, observed });
      } else if (kind === "pin") {
        const label = "pin", root = `${artifacts}/${label}/external`;
        const pin = { GLOBNOTES_PLUGIN_SETTINGS: JSON.stringify({ "globnotes-backup": { backup: { basePath: root } } }) };
        await fixture(label, pin, { retention: 2, basePath: "stored" }); await Deno.mkdir(root);
        await open();
        assert(await current.session.evaluate(`document.querySelector('#settings-field-basePath').readOnly && document.querySelector('#settings-field-basePath').value===${JSON.stringify(root)} && document.querySelector('[data-modal-top=true]').textContent.includes('Set by environment')`), "BACKUP_NATIVE_pin: effective readonly field");
        await picture("environment-pin"); await retention(3); await closeSettings();
        const raw = JSON.parse(await Deno.readTextFile(`${current.state}/plugin-data/globnotes-backup/settings.json`));
        equal(raw.values.backup.basePath, "stored", "BACKUP_NATIVE_pin: stored fallback preserved by sibling save");
        await save("Note", "B"); await ring(root, "Note", ["A"], kind);
        if (!options.case) {
          await restart({ GLOBNOTES_PLUGIN_SETTINGS: '{"globnotes-backup":{"backup":{"basePath":""}}}' });
          equal((await settings()).body.values.basePath, "", "BACKUP_NATIVE_pin: explicit empty override"); await save("Note", "C"); await ring(current.vault, "Note", ["B"], kind);
          await restart(); await open(); equal((await settings()).body.values.basePath, "stored", "BACKUP_NATIVE_pin: unpinned fallback restored");
          assert(!await current.session.evaluate("document.querySelector('#settings-field-basePath').readOnly"), "BACKUP_NATIVE_pin: unpinned field writable");
          await picture("restored-fallback"); await closeSettings(); await save("Note", "D"); await ring(`${current.vault}/stored`, "Note", ["C"], kind); await ring(root, "Note", ["A"], kind);
        }
        await finish(kind, { root, persistedFallback: raw.values.backup.basePath });
      } else if (["recovery", "cleanup"].includes(kind)) {
        await fixture(kind); const failed = await save("Note", "B");
        assert(failed.pendingRecovery, `BACKUP_NATIVE_${kind}: interruption recorded`);
        const active = `${current.vault}/.globnotes-backup/active.json`, journal = JSON.parse(await Deno.readTextFile(active));
        await Deno.writeTextFile(`${current.directory}/interrupted-journal.json`, JSON.stringify(journal, null, 2), { createNew: true });
        const live = await Deno.readTextFile(`${current.vault}/Note.md`); await restart();
        const recovered = (await status()).body;
        assert(!recovered.pendingRecovery, `BACKUP_NATIVE_${kind}: ring-committed cleanup completed without duplicate capture`);
        const cleanup = [];
        for (const file of [active, ...journal.stages.map(stage => stage.file)]) {
          let missing = false;
          try { await Deno.lstat(file); } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; missing = true; }
          cleanup.push({ file, missing });
        }
        await Deno.writeTextFile(`${current.directory}/physical-cleanup.json`, JSON.stringify(cleanup, null, 2), { createNew: true });
        assert(cleanup.every(item => item.missing), `BACKUP_NATIVE_${kind}: active journal and every recorded stage physically removed`);
        equal(await Deno.readTextFile(`${current.vault}/Note.md`), live, `BACKUP_NATIVE_${kind}: original note never replayed`);
        await ring(current.vault, "Note", ["A"], kind); await finish(kind, { failed, recovered, live });
      } else if (kind === "distinct") {
        await fixture(kind);
        const first = `${current.vault}/first`, second = `${current.vault}/second`;
        await Deno.mkdir(first); await Deno.mkdir(second);
        await open(); await base(first); await closeSettings(); await save("Note", "B"); await ring(first, "Note", ["A"], kind);
        await open(); await base(second); await closeSettings(); await Deno.writeTextFile(`${current.vault}/Note.md`, "A"); await save("Note", "B"); await ring(second, "Note", ["A"], kind);
        await open(); await base(first); await closeSettings(); await save("Note", "C"); await ring(first, "Note", ["B", "A"], kind); await ring(second, "Note", ["A"], kind);
        await finish(kind, { first, second, separateEqualByteHistories: true });
      } else if (kind === "retarget") {
        await fixture(kind);
        const first = `${current.vault}/first`, second = `${current.vault}/second`, alias = `${current.vault}/alias`;
        await Deno.mkdir(first); await Deno.mkdir(second); await Deno.symlink(first, alias);
        await open(); await base(alias); await closeSettings(); await save("Note", "B");
        const watcher = Deno.watchFs(`${current.vault}/.globnotes-backup`);
        const ready = (async () => { for await (const event of watcher) if (event.paths.some(path => path.endsWith("/retarget-ready"))) { const observed = await Deno.stat(`${current.vault}/.globnotes-backup/retarget-ready`).catch(error => { if (error instanceof Deno.errors.NotFound) return null; throw error; }); if (observed) return; } throw new Error("barrier watcher closed before observation"); })();
        try {
          equal((await api("/_/api/notes/Note", "PATCH", { newContent: "C" })).status, 200, "BACKUP_NATIVE_retarget: original ACK before deferred publication");
          await ready;
          Deno.removeSync(alias); Deno.symlinkSync(second, alias); Deno.writeTextFileSync(`${current.vault}/.globnotes-backup/retarget-release`, "release");
          const settled = (await status()).body;
          assert(!settled.pendingRecovery, "BACKUP_NATIVE_retarget: pinned transaction completes under surviving static authority");
          await ring(first, "Note", ["B", "A"], kind); await ring(second, "Note", [], kind);
          await finish(kind, { first, second, alias, settled, pinnedPlacement: true });
        } finally { watcher.close(); }
      } else if (kind === "failure") {
        await fixture(kind); await Deno.writeTextFile(`${current.vault}/Note.md.0.bak`, "alien");
        const session = current.session;
        await session.button("Edit", ".content-column"); await session.button("Source", ".content-column"); await session.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
        await session.evaluate("document.fonts.ready.then(()=>true)"); await session.click(".cm-content"); await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }); await session.type("successful saved text\n");
        await session.poll("document.querySelector('.cm-content')?.textContent.includes('successful saved text')");
        await session.evaluate("window.__backupEditor=document.querySelector('.cm-content');window.__backupUrl=location.href;true");
        await session.button("Save", ".content-column"); await session.poll("fetch('/_/api/notes/Note').then(r=>r.json()).then(v=>v.content==='successful saved text\\n')");
        const failed = (await status()).body; assert(failed.failed > 0 && failed.lastError.code === "backup_alien_slot", "BACKUP_NATIVE_failure: failed backup is visible");
        equal(await Deno.readTextFile(`${current.vault}/Note.md`), "successful saved text\n", "BACKUP_NATIVE_failure: successful ACK and bytes survive");
        equal(await Deno.readTextFile(`${current.vault}/Note.md.0.bak`), "alien", "BACKUP_NATIVE_failure: alien unchanged");
        await session.click(".cm-content"); await session.key("End", { windowsVirtualKeyCode: 35 }); await session.type("dirty retained");
        await session.poll("document.querySelector('.cm-content')?.textContent.includes('dirty retained')");
        await session.evaluate("window.__backupUrl=location.href;true");
        await open();
        assert(await session.evaluate("document.querySelector('.cm-content')===window.__backupEditor && document.querySelector('.cm-content').textContent.includes('dirty retained') && location.href===window.__backupUrl"), "BACKUP_NATIVE_failure: literal editor and URL retained");
        await picture("failure-retained-editor");
        const observer = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
        try { await observer.goto(`${current.server.baseUrl}/_/api/plugins/globnotes-backup/status`); await observer.poll("document.body.textContent.includes('backup_alien_slot')"); await picture("failure-status", observer); }
        finally { await observer.close(); }
        await closeSettings(); assert(await session.evaluate("document.querySelector('.cm-content')===window.__backupEditor && document.querySelector('.cm-content').textContent.includes('dirty retained')"), "BACKUP_NATIVE_failure: modal close retains newer draft");
        await finish(kind, { failed, editorRetained: true, draftRetained: true, urlRetained: true });
      } else {
        await fixture("settings-lock"); await open(); assert(await current.session.evaluate("document.querySelector('#settings-field-retention').disabled && document.querySelector('#settings-field-basePath').readOnly"), "BACKUP_NATIVE_settings-lock: settings readonly");
        const before = (await settings()).body;
        equal((await api("/_/api/plugin-host/globnotes-backup/settings/backup", "PUT", { revision: before.revision, sourceKey: before.sourceKey, values: { retention: 3, basePath: "" } })).status, 403, "BACKUP_NATIVE_settings-lock: API rejects settings mutation");
        await closeSettings(); await save("Note", "B"); await ring(current.vault, "Note", ["A"], "settings-lock"); await finish("settings-lock", { noteWritable: true, settingsWritable: false });
      }
    }
    equal(outcomes.length, selected.length, "Complete required native records");
    await Deno.writeTextFile(`${artifacts}/summary.json`, JSON.stringify({ selected, outcomes, productionAssets: true, allConsumersCompleted: true }, null, 2), { createNew: true });
    console.log("BACKUP PLUGIN OK", JSON.stringify(outcomes));
  } catch (error) {
    await Deno.writeTextFile(`${artifacts}/failure.json`, JSON.stringify({ detail: error.message, outcomes, fixtures: fixtures.map(({ label, directory, vault, state, servers, closed }) => ({ label, directory, vault, state, servers, closed })) }, null, 2), { createNew: true });
    if (options.negative && error.message.includes(`BACKUP_NATIVE_${options.case}`) && current?.session.errors.length === 0) {
      // The deliberately broken consumer is a successful negative-control
      // observation. Preserve evidence first and close only its exact new owners.
      await Deno.writeTextFile(`${current.directory}/negative-state.json`, JSON.stringify({ settings: await settings(), status: await status(), targetId: current.session.targetId, browserContextId: current.session.browserContextId, servers: current.servers }, null, 2), { createNew: true });
      await current.session.close(); await current.server.close(); current.closed = true;
      await Deno.writeTextFile(`${artifacts}/negative-consumer.json`, JSON.stringify({ namedConsumer: `BACKUP_NATIVE_${options.case}`, observed: true, detail: error.message, ownedResourcesClosedAfterCustody: true }, null, 2), { createNew: true });
    }
    // Failed owned contexts/server/fixtures stay available for diagnosis.
    throw error;
  }
}
