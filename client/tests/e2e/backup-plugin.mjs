// Production-assets native consumers. Every target, server, variant and artifact is owned.
import { nativeSession } from "./native-cdp-session.mjs";
import { showSidebar } from './sidebar-navigation-native.mjs';
import { fileURLToPath } from "node:url";
import { bootServer, nativeFixtureAdmin } from "./harness-helpers.mjs";
import { executeChild } from "./legacy-native-suite.mjs";
import { BACKUP_CASES } from "./native-fixture-cases.mjs";
import { openBackupWork, recordBackupNegative, requireBackupNegative } from "../helpers/backup-controls.js";
import { publishRecord, readRecord, waitForRecord } from "../../../tests/helpers/process_records.ts";
import { copyRepositorySources } from "../../../tests/helpers/repository_sources.ts";
import { repositoryBuild } from "../../../tests/helpers/completed_build.ts";
import { finalizeNativeCase } from "./native-case-finalization.mjs";
import { nativeAccountScenario, nativeFixtureInput } from "./config-fixture.mjs";
import { storedScenario } from "../../../tests/helpers/fixture_scenarios.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const retargetPreload = `${ROOT}/tests/helpers/backup_retarget_preload.ts`;
const kinds = ["count", "order", "location", "preimage", "pin", "recovery", "aliases", "distinct", "retarget", "cleanup"];
const options = { artifacts: null, controls: false, case: null, negative: false, variant: null }, seen = new Set();
for (let index = 0; index < Deno.args.length; index++) {
  const flag = Deno.args[index];
  if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
  seen.add(flag);
  if (flag === "--artifacts") options.artifacts = Deno.args[++index];
  else if (flag === "--controls") options.controls = true;
  else if (flag === "--case") options.case = Deno.args[++index];
  else if (flag === "--negative") options.negative = true;
  else if (flag === "--variant") options.variant = Deno.args[++index];
  else throw new Error(`Unknown argument: ${flag}`);
}
if (!options.artifacts?.startsWith("/") || options.controls && options.case || options.case && ![...kinds, "failure", "settings-lock"].includes(options.case) || options.negative && !options.case) throw new Error("A fresh absolute artifact directory and valid mode are required");
const variant = options.variant && BACKUP_CASES.find(item => item.label === options.variant);
if (seen.has("--variant") && (!variant || options.controls || options.case || options.negative)) throw Error("--variant requires one known independent backup fixture");
await Deno.mkdir(options.artifacts, { mode: 0o700 });
const artifacts = options.artifacts, assert = (value, message) => { if (!value) throw new Error(message); };
const settingsRoute = "/_/api/plugin-host/globnotes-backup/settings/backup";
const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}; actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
const deltas = {
  count: [["const planned = stages.slice(0, config.count)", "const planned = stages.slice(0, Math.min(3, config.count + 1))"], ["Math.min(journal.count, journal.old.length + 1)", "Math.min(Math.min(3, journal.count + 1), journal.old.length + 1)"]],
  order: [["const planned = stages.slice(0, config.count)", "const planned = stages.slice(0, config.count).reverse()"], ["slot.hash !== journal.stages[index].hash", "slot.hash !== journal.stages[journal.planned.length - index - 1].hash"], ["this.#verifiedFile(state.stages[index].file, slot.hash, config)", "this.#verifiedFile(state.stages[state.planned.length - index - 1].file, slot.hash, config)"]],
  location: [["root = workspace.vault;", "root = join(workspace.vault, 'misplaced');"]],
  preimage: [["content: new TextDecoder().decode(offer.bytes)", 'content: ""']],
  pin: [["base: values.basePath", "base: ''"]],
  recovery: [["if (metadata?.value.operationKey === state.operationKey)", "if (false && metadata?.value.operationKey === state.operationKey)"]],
  cleanup: [["this.#remember(state.operationKey);", "this.#remember(state.operationKey); this.#status.pendingRecovery=false; return {completed:true};"]],
  aliases: [["JSON.stringify([root, captured.path])", "JSON.stringify([config.base, captured.path])"], ["JSON.stringify([state.root, state.path])", "JSON.stringify([state.base, state.path])"]],
  distinct: [["const canonical = await fs.stat(root, options);", "root = workspace.vault; const canonical = await fs.stat(root, options);"]],
  // Re-resolve at publication, not during family construction: the first save
  // must succeed so this control actually exercises a later symlink retarget.
  retarget: [["const slot = state.planned[index];\n        await fs.mkdir(parent(slot.path)", "const slot = { ...state.planned[index], path: this.#slot(await fs.realPath(config.base, options), state.path, index) };\n        await fs.mkdir(parent(slot.path)"]],
};
if (options.controls) {
  const outcomes = [], original = await Deno.readTextFile(`${ROOT}/plugins/globnotes-backup/backup.js`);
  for (const kind of kinds) {
    for (const mode of ["healthy", "broken"]) {
      const directory = `${artifacts}/${kind}-${mode}`; await Deno.mkdir(directory);
      const source = `${directory}/source`; await copyRepositorySources("backup-control", source);
      for (const name of ["deno.json", "deno.lock"]) equal(await Deno.readTextFile(`${source}/${name}`), await Deno.readTextFile(`${ROOT}/${name}`), "Locked dependency inputs must match before cache reuse");
      assert((await Deno.stat(`${ROOT}/node_modules`)).isDirectory, "Installed dependency reference unavailable");
      await Deno.symlink(`${ROOT}/node_modules`, `${source}/node_modules`);
      await publishRecord(`${directory}/dependency-custody.json`, JSON.stringify({ reference: `${ROOT}/node_modules`, selected: `${source}/node_modules`, configAndLockBytesMatch: true, sourceOnlyVariant: true }, null, 2), { createNew: true });
      let text = original;
      if (mode === "broken") for (const [before, after] of deltas[kind]) { equal(text.split(before).length - 1, 1, "variant match count"); text = text.replace(before, after); }
      await publishRecord(`${source}/plugins/globnotes-backup/backup.js`, text);
      await publishRecord(`${directory}/variant.json`, JSON.stringify({ kind, mode, source, delta: mode === "broken" ? deltas[kind] : [], originalSource: original, variantSource: text }, null, 2), { createNew: true });
      const result = await executeChild(["run", "--cached-only", "--frozen", `--config=${source}/deno.json`, "--unstable-worker-options", "--allow-read", "--allow-write", "--allow-env", "--allow-run", "--allow-net", "--allow-sys", `${source}/client/tests/e2e/backup-plugin.mjs`, "--case", kind, ...(mode === "broken" ? ["--negative"] : []), "--artifacts", `${directory}/consumers`], { artifacts: directory, label: "child", timeout: 120000 });
      assert(!result.timedOut, `${kind}: timeout is not intended consumer failure`);
      if (mode === "healthy") {
        assert(result.code === 0, `${kind}: healthy producer failed`);
        const summary = readRecord(`${directory}/consumers/summary.json`);
        equal(summary.selected, [kind], `${kind}: complete healthy selection`);
        assert(summary.outcomes.length === 1 && summary.outcomes[0].label === kind && summary.outcomes[0].completed, `${kind}: complete healthy records`);
        const consumer = readRecord(`${summary.outcomes[0].directory}/consumers.json`);
        assert(consumer.status.status === 200 && consumer.pageErrors.length === 0, `${kind}: actual healthy API/browser consumer`);
      }
      const negative = mode === "broken" ? await requireBackupNegative(kind, result, async () =>
        readRecord(`${directory}/consumers/negative-consumer.json`)) : null;
      outcomes.push({ kind, mode, code: result.code, timedOut: result.timedOut, reason: negative?.reason ?? null });
    }
  }
  equal(await Deno.readTextFile(`${ROOT}/plugins/globnotes-backup/backup.js`), original, "Original producer unchanged");
  await publishRecord(`${artifacts}/controls.json`, JSON.stringify({ kinds, outcomes }, null, 2), { createNew: true });
  console.log("BACKUP PLUGIN CONTROLS OK", JSON.stringify(outcomes));
} else {
  // Control copies have source only; do not use client/dist as a build signal.
  const build = await repositoryBuild(undefined, { required: true });
  const outcomes = [], fixtures = [];
  let current;
  async function api(route, method = "GET", body, headers = {}) {
    const response = await fetch(current.server.baseUrl + route, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json() };
  }
  const settings = () => api(settingsRoute, "GET", undefined, current.adminHeaders);
  const readCatalog = () => api("/_/api/plugin-host", "GET", undefined, current.adminHeaders);
  const readStatus = () => api("/_/api/plugins/globnotes-backup/status");
  const status = () => current.work.status();
  async function picture(name, session = current.session) {
    const { data } = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await publishRecord(`${current.directory}/${name}.png`, Uint8Array.from(atob(data), c => c.charCodeAt(0)), { createNew: true });
  }
  async function closeSession(fixture) {
    if (!fixture?.session || fixture.sessionClosed) return;
    fixture.sessionClosed = true;
    await fixture.session.close();
  }
  async function closeServer(fixture) {
    if (!fixture?.server || fixture.serverClosed) return;
    fixture.serverClosed = true;
    await fixture.server.close();
  }
  async function closeFixture(fixture) {
    await finalizeNativeCase({ cleanup: [() => closeSession(fixture), () => closeServer(fixture)] });
    fixture.closed = true;
  }
  async function launch(env) {
    const directory = `${current.directory}/backend-${++current.generation}`; await Deno.mkdir(directory);
    const admitted = Promise.withResolvers(), observation = new AbortController();
    const samples = []; let finished = false;
    const fixtureScenario = current.generation === 1 ? current.fixtureScenario : storedScenario(current.fixtureScenario);
    const boot = bootServer(current.vault, current.state, { fixtureScenario, build, env:{...env,TMPDIR:Deno.env.get('TMPDIR')}, logsDir: directory, onServer: server => admitted.resolve(server), denoArgs: current.label === "retarget" ? ["--preload", retargetPreload] : [] });
    const observe = (async () => {
      const owner = await admitted.promise;
      assert(owner.vault === current.vault, "Startup observation must own this fixture");
      if (!owner.baseUrl) return;
      owner.exited.then(() => observation.abort());
      let headers;
      while (!finished) {
        try {
          const signal = AbortSignal.any([AbortSignal.timeout(1000), observation.signal]);
          headers ??= (await nativeFixtureAdmin(owner, { signal })).headers;
          const response = await fetch(`${owner.baseUrl}/_/api/plugin-host`, { headers, signal });
          if (response.ok) { const catalog = await response.json(); samples.push({ time: Date.now(), plugins: catalog.plugins.map(plugin => ({ id: plugin.id, status: plugin.status, diagnostics: plugin.diagnostics })) }); }
          else await response.body?.cancel();
        } catch (error) { samples.push({ time: Date.now(), unavailable: error.name }); }
        if (!finished) await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    try {
      current.server = await boot;
      current.serverClosed = false;
      current.servers.push({ pid: current.server.pid, baseUrl: current.server.baseUrl, directory });
      ({ headers: current.adminHeaders } = await nativeFixtureAdmin(current.server));
      current.work = await openBackupWork(current.server, { kind: current.label, negative: options.negative, restarted: current.generation > 1, readStatus });
    }
    finally { finished = true; observation.abort(); admitted.resolve({ baseUrl: null, vault: current.vault }); await observe; await publishRecord(`${directory}/startup-catalogs.json`, JSON.stringify(samples, null, 2), { createNew: true }); }
  }
  async function fixture(label, env = {}, seed = null) {
    assert(fixtures.every(item => item.closed), "A prior fixture still owns resources");
    const directory = `${artifacts}/${label}`; await Deno.mkdir(directory);
    current = { label, directory, vault: `${directory}/vault`, state: `${directory}/state/globnotes`, generation: 0, servers: [], closed: false };
    fixtures.push(current);
    await Deno.mkdir(current.vault); await Deno.mkdir(current.state, { recursive: true });
    await Deno.mkdir(`${current.vault}/misplaced`); await Deno.mkdir(`${current.vault}/dedicated`);
    await Deno.writeTextFile(`${current.vault}/Note.md`, "A");
    ({ fixtureScenario: current.fixtureScenario } = await nativeFixtureInput(nativeAccountScenario()));
    if (seed) { await Deno.mkdir(`${current.state}/plugin-data/globnotes-backup`, { recursive: true }); await publishRecord(`${current.state}/plugin-data/globnotes-backup/settings.json`, JSON.stringify({ schemaVersion: 1, revision: 1, values: { backup: seed } })); }
    if (["recovery", "cleanup", "retarget"].includes(label)) {
      const plugin = `${current.state}/plugins/globnotes-backup`; await copyRepositorySources("backup-plugin", plugin);
      const file = `${plugin}/backup.js`, text = await Deno.readTextFile(file), target = label !== "retarget" ? "metadata = await writeRecord(fs, metadataPath, next, metadata, options);" : "const completed = [];";
      equal(text.split(target).length - 1, 1, "fault/barrier seam");
      if (label === "retarget") await publishRecord(`${plugin}/native-record-publication.ts`, await Deno.readFile(new URL("../../../tests/helpers/record_publication.ts", import.meta.url)), { createNew: true });
      const injection = label !== "retarget" ? `${target}\n      if(!globalThis.__backupNativeInterrupted){globalThis.__backupNativeInterrupted=true;throw new BackupError('native_recorded_interruption');}`
        : `${target}\n      if((globalThis.__backupNativePublications=(globalThis.__backupNativePublications??0)+1)===2){
          await publishNativeRecord(join(workspace.location,'retarget-ready'),'{"ready":true}',{}, {
            unique:()=>this.ctx.createUuid(),
            write:async(path,text)=>{await fs.writeFile(path,new TextEncoder().encode(text),{...options,expect:{kind:'absent'}});},
            rename:async(from,to)=>{const stat=await fs.stat(from,options);await fs.rename(from,to,{...options,sourceToken:stat.token,destination:{kind:'absent'}});},
            remove:async(path)=>{const stat=await fs.stat(path,options);if(stat)await fs.remove(path,{...options,token:stat.token});}
          });
          const release=await fs.stat(join(workspace.location,'retarget-release'),options);
          if(release?.kind!=='file')throw new BackupError('native_retarget_release_missing');
        }`;
      const mutated = (label === "retarget" ? 'import { publishRecord as publishNativeRecord } from "./native-record-publication.ts";\n' : '') + text.replace(target, injection);
      await publishRecord(file, mutated);
      await publishRecord(`${directory}/fault-source.json`, JSON.stringify({ file, before: text, after: mutated }), { createNew: true });
    }
    await launch(env);
    current.session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
    current.sessionClosed = false;
    await openNote();
    await current.session.evaluate("document.fonts.ready.then(()=>true)");
    await publishRecord(`${directory}/ownership.json`, JSON.stringify({ vault: current.vault, state: current.state, pid: current.server.pid, baseUrl: current.server.baseUrl, targetId: current.session.targetId, browserContextId: current.session.browserContextId }, null, 2), { createNew: true });
  }
  async function openNote() {
    const { session, server, label } = current;
    if (label === "settings-lock") await session.goto(`${server.baseUrl}/Note`);
    else {
      const { login, password } = nativeAccountScenario().identity.people[0];
      await session.goto(`${server.baseUrl}/_/login?redirect=/Note`);
      await session.click("#identity-login-name"); await session.type(login);
      await session.click("#identity-login-password"); await session.type(password);
      await session.button("Continue", ".identity-login");
    }
    await session.poll("location.pathname==='/Note' && !!document.querySelector('.toast-viewer')");
    const proof = await session.evaluate("fetch('/_/api/auth-check').then(r=>r.json())");
    assert(proof.capabilities.canEdit && (label === "settings-lock" ? proof.principal.kind === "guest" && !proof.capabilities.canManageVault : proof.capabilities.canManageVault), "Wrong browser authority for backup fixture");
  }
  async function openSettingsFrame() {
    const session = current.session;
    if (!await session.evaluate("!!document.querySelector('#settings-modal-title')")) {
      await showSidebar(session);
      await session.click('[aria-label="Settings"]'); await session.poll("!!document.querySelector('#settings-modal-title')");
    }
  }
  async function open() {
    const session = current.session;
    await openSettingsFrame();
    await session.click('[data-settings-nav-id="plugin:globnotes-backup"]');
    await session.poll("document.querySelector('#settings-field-retention')?.matches('input[type=range]:not([disabled]):not([readonly])') && document.querySelector('#settings-field-retention').value !== ''");
    await session.evaluate("document.fonts.ready.then(()=>true)");
  }
  async function closeSettings() { await current.session.click('[aria-label="Close settings"]'); await current.session.poll("!document.querySelector('#settings-modal-title')"); }
  async function retention(count) {
    const session = current.session;
    await session.click("#settings-field-retention");
    await session.poll("document.activeElement === document.querySelector('#settings-field-retention')");
    await session.key("Home", { windowsVirtualKeyCode: 36 });
    for (let index = 1; index < count; index++) await session.key("ArrowRight", { windowsVirtualKeyCode: 39 });
     await session.poll(`document.querySelector('#settings-field-retention')?.value === '${count}'`);
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
  async function save(path, value, during) {
    const read = await api(`/_/api/notes/${path}`);
    const ack = await api(`/_/api/notes/${path}`, "PATCH", { newContent: value, base: { kind: "version", version: read.body.version } });
    equal(ack.status, 200, "managed save acknowledgement");
    equal(await Deno.readTextFile(`${current.vault}/${path}.md`), value, "live saved bytes");
    return (await current.work.afterCapture(during)).body;
  }
  async function ring(root, path, expected, kind) {
    const observed = [];
    for (let index = 0; index < 10; index++) {
      try { observed.push(await Deno.readTextFile(`${root}/${path}.md.${index}.bak`)); }
      catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; observed.push(null); }
    }
    await publishRecord(`${current.directory}/ring-${current.rings = (current.rings ?? 0) + 1}.json`, JSON.stringify({ root, path, observed, expected, status: await status() }, null, 2), { createNew: true });
    equal(observed, [...expected, ...Array(10 - expected.length).fill(null)], `BACKUP_NATIVE_${kind}: exact ordered owned physical slots`);
    return observed;
  }
  async function finish(label, consumers) {
    assert(current.session.errors.length === 0, "Unexpected browser runtime exception");
    const result = { label, consumers, settings: await settings(), status: await status(), servers: current.servers, pageErrors: current.session.errors, events: current.session.events };
    await publishRecord(`${current.directory}/consumers.json`, JSON.stringify(result, null, 2), { createNew: true });
    await closeFixture(current);
    outcomes.push({ label, completed: true, directory: current.directory });
  }
  async function restart(env = {}) {
    await publishRecord(`${current.directory}/restart-${current.generation}-before.json`, JSON.stringify({ settings: await settings(), status: await status(), live: await Deno.readTextFile(`${current.vault}/Note.md`) }, null, 2), { createNew: true });
    await closeServer(current); await launch(env);
    await openNote();
    await current.session.evaluate("document.fonts.ready.then(()=>true)");
  }
  try {
    const selected = variant ? [variant.kind] : options.case ? [options.case] : ["count", "aliases", "location", "pin", "recovery", "cleanup", "distinct", "retarget", "failure", "settings-lock"];
    for (const kind of selected) {
      if (["count", "order", "preimage"].includes(kind)) {
        await fixture(kind); await open();
        equal((await settings()).body.values.retention, 2, `BACKUP_NATIVE_${kind}: default2`);
        const rows = [];
        for (const count of variant ? [variant.count] : options.case ? [2] : Array.from({ length: 10 }, (_, index) => index + 1)) {
          await retention(count); await closeSettings(); await open();
           equal(Number(await current.session.read('#settings-field-retention', "document.querySelector('#settings-field-retention').value")), count, `BACKUP_NATIVE_${kind}: reopened slider`);
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
        const pin = { GLOBNOTES_GLOBNOTES_PLUGINS_SETTINGS: JSON.stringify({ "globnotes-backup": { backup: { basePath: root } } }) };
        await fixture(label, pin, { retention: 2, basePath: "stored" }); await Deno.mkdir(root);
        await open();
         assert(await current.session.read(['#settings-field-basePath', '#settings-field-retention'], `(()=>{const values=[...document.querySelectorAll('#settings-field-basePath')],slider=document.querySelector('#settings-field-retention');if(values.length!==1)return false;const value=values[0],reason=(value.getAttribute('aria-describedby')??'').split(' ').map(id=>document.getElementById(id)?.textContent??'').join(' ');return value.matches('span[aria-labelledby]') && value.textContent===${JSON.stringify(root)} && reason.includes('Set by the server configuration') && value.closest('.setting-row').querySelectorAll('input,button,select,textarea').length===0 && slider?.matches('input[type=range]:not([disabled]):not([readonly])');})()`), "BACKUP_NATIVE_pin: retained value row, reason and editable sibling");
        await picture("environment-pin"); await retention(3); await closeSettings();
        const raw = JSON.parse(await Deno.readTextFile(`${current.state}/plugin-data/globnotes-backup/settings.json`));
        equal(raw.values.backup.basePath, "stored", "BACKUP_NATIVE_pin: stored fallback preserved by sibling save");
        await save("Note", "B"); await ring(root, "Note", ["A"], kind);
        if (!options.case) {
          await restart({ GLOBNOTES_GLOBNOTES_PLUGINS_SETTINGS: '{"globnotes-backup":{"backup":{"basePath":""}}}' });
          equal((await settings()).body.values.basePath, "", "BACKUP_NATIVE_pin: explicit empty override"); await save("Note", "C"); await ring(current.vault, "Note", ["B"], kind);
          await restart(); await open(); equal((await settings()).body.values.basePath, "stored", "BACKUP_NATIVE_pin: unpinned fallback restored");
           assert(await current.session.read('#settings-field-basePath', "document.querySelector('#settings-field-basePath')?.matches('input:not([readonly]):not([disabled])')"), "BACKUP_NATIVE_pin: unpinned field writable");
          await picture("restored-fallback"); await closeSettings(); await save("Note", "D"); await ring(`${current.vault}/stored`, "Note", ["C"], kind); await ring(root, "Note", ["A"], kind);
        }
        await finish(kind, { root, persistedFallback: raw.values.backup.basePath });
      } else if (["recovery", "cleanup"].includes(kind)) {
        await fixture(kind); const failed = await save("Note", "B");
        assert(failed.pendingRecovery, `BACKUP_NATIVE_${kind}: interruption recorded`);
        const active = `${current.vault}/.globnotes-backup/active.json`, journal = JSON.parse(await Deno.readTextFile(active));
        await publishRecord(`${current.directory}/interrupted-journal.json`, JSON.stringify(journal, null, 2), { createNew: true });
        const live = await Deno.readTextFile(`${current.vault}/Note.md`); await restart();
        const recovered = (await status()).body;
        assert(!recovered.pendingRecovery, `BACKUP_NATIVE_${kind}: ring-committed cleanup completed without duplicate capture`);
        const cleanup = [];
        for (const file of [active, ...journal.stages.map(stage => stage.file)]) {
          let missing = false;
          try { await Deno.lstat(file); } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; missing = true; }
          cleanup.push({ file, missing });
        }
        await publishRecord(`${current.directory}/physical-cleanup.json`, JSON.stringify(cleanup, null, 2), { createNew: true });
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
        const settled = await save("Note", "C", async owner => {
          const workspace = `${current.vault}/.globnotes-backup`;
          await waitForRecord(workspace, "retarget-ready", () => { const value = readRecord(`${workspace}/retarget-ready`); return value?.ready === true ? value : null; }, [
            { label: "backup server", exit: current.server.exited },
            owner,
          ]);
          const held = (await readCatalog()).body.plugins.find(plugin => plugin.id === "globnotes-backup").work;
          equal(held.versioning, { admitted: 2, settled: 1, pending: 1, failures: 0, lastFailure: null },
            "BACKUP_NATIVE_retarget: second capture held before publication");
          Deno.removeSync(alias); Deno.symlinkSync(second, alias);
          await publishRecord(`${workspace}/retarget-release`, '{"release":true}');
          await publishRecord(`${current.directory}/retarget-at-release.json`, JSON.stringify(held, null, 2), { createNew: true });
        });
        assert(!settled.pendingRecovery, "BACKUP_NATIVE_retarget: pinned transaction completes under surviving static authority");
        await ring(first, "Note", ["B", "A"], kind); await ring(second, "Note", [], kind);
        await finish(kind, { first, second, alias, settled, pinnedPlacement: true });
      } else if (kind === "failure") {
        await fixture(kind); await Deno.writeTextFile(`${current.vault}/Note.md.0.bak`, "alien");
        const session = current.session;
        await session.button("Edit", ".content-column"); await session.button("Source", ".content-column"); await session.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
        await session.evaluate("document.fonts.ready.then(()=>true)"); await session.click(".cm-content"); await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }); await session.type("successful saved text\n");
        await session.poll("document.querySelector('.cm-content')?.textContent.includes('successful saved text')");
        await session.evaluate("window.__backupEditor=document.querySelector('.cm-content');window.__backupUrl=location.href;true");
        await session.button("Save", ".content-column"); await session.poll("fetch('/_/api/notes/Note').then(r=>r.json()).then(v=>v.content==='successful saved text\\n')");
        const failed = (await current.work.afterCapture()).body;
        equal(await Deno.readTextFile(`${current.vault}/Note.md`), "successful saved text\n", "BACKUP_NATIVE_failure: successful ACK and bytes survive");
        equal(await Deno.readTextFile(`${current.vault}/Note.md.0.bak`), "alien", "BACKUP_NATIVE_failure: alien unchanged");
        await session.click(".cm-content"); await session.key("End", { windowsVirtualKeyCode: 35 }); await session.type("dirty retained");
        await session.poll("document.querySelector('.cm-content')?.textContent.includes('dirty retained')");
        await session.evaluate("window.__backupUrl=location.href;true");
        await open();
         assert(await session.evaluate("document.querySelector('.cm-content')===window.__backupEditor && document.querySelector('.cm-content')?.textContent.includes('dirty retained') && location.href===window.__backupUrl"), "BACKUP_NATIVE_failure: literal editor and URL retained");
        await picture("failure-retained-editor");
        const observer = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
        try { await observer.goto(`${current.server.baseUrl}/_/api/plugins/globnotes-backup/status`); await observer.poll("document.body.textContent.includes('backup_alien_slot')"); await picture("failure-status", observer); }
        finally { await observer.close(); }
         await closeSettings(); assert(await session.evaluate("document.querySelector('.cm-content')===window.__backupEditor && document.querySelector('.cm-content')?.textContent.includes('dirty retained')"), "BACKUP_NATIVE_failure: modal close retains newer draft");
        await finish(kind, { failed, editorRetained: true, draftRetained: true, urlRetained: true });
      } else {
        await fixture("settings-lock"); await openSettingsFrame();
        assert(await current.session.read('#settings-modal-title', "!document.querySelector('[data-settings-nav-id=\"plugin:globnotes-backup\"], #settings-field-retention, #settings-field-basePath')"), "BACKUP_NATIVE_settings-lock: Guest Edit has no Admin settings page or mutation controls");
        const admin = await settings(), before = admin.body;
        equal([admin.status, before.values], [200, { retention: 2, basePath: "" }], "BACKUP_NATIVE_settings-lock: both retained values are available to Admin");
        // Backup has no browser contribution, so it has no guest values projection.
        equal(await api(settingsRoute), { status: 403, body: { detail: "This account cannot perform that operation.", code: "operation_not_permitted" } }, "BACKUP_NATIVE_settings-lock: Guest Edit cannot disclose server-only settings");
        equal((await api(settingsRoute, "PUT", { revision: before.revision, sourceKey: before.sourceKey, values: { retention: 3, basePath: "" } })).status, 403, "BACKUP_NATIVE_settings-lock: API rejects settings mutation");
        equal((await settings()).body, before, "BACKUP_NATIVE_settings-lock: denied mutation did not change Admin settings");
        await closeSettings(); await save("Note", "B"); await ring(current.vault, "Note", ["A"], "settings-lock"); await finish("settings-lock", { noteWritable: true, settingsWritable: false });
      }
    }
    equal(outcomes.length, selected.length, "Complete required native records");
    await publishRecord(`${artifacts}/summary.json`, JSON.stringify({ selected, outcomes, productionAssets: true, allConsumersCompleted: true }, null, 2), { createNew: true });
    console.log("BACKUP PLUGIN OK", JSON.stringify(outcomes));
  } catch (error) {
    const failureRecord = () => publishRecord(`${artifacts}/failure.json`, JSON.stringify({ detail: error.message, outcomes, fixtures: fixtures.map(({ label, directory, vault, state, servers, closed }) => ({ label, directory, vault, state, servers, closed })) }, null, 2), { createNew: true });
    try { if (options.negative) {
      await recordBackupNegative({ kind: options.case, error, pageErrors: current?.session?.errors ?? [],
        diagnostics: async () => {
          await failureRecord();
          // Raw reads retain the original failed fence instead of re-entering it.
          const catalog = (await readCatalog()).body.plugins.find(plugin => plugin.id === "globnotes-backup");
          const readSlot = path => Deno.readTextFile(path).catch(error => { if (error instanceof Deno.errors.NotFound) return null; throw error; });
          const state = { catalog, settings: await settings(), status: await readStatus(), vault: current.vault,
            live: await Deno.readTextFile(`${current.vault}/Note.md`), firstSlot: await Deno.readTextFile(`${current.vault}/Note.md.0.bak`).catch(error => { if (error instanceof Deno.errors.NotFound) return null; throw error; }),
            targetId: current.session?.targetId, browserContextId: current.session?.browserContextId, servers: current.servers };
          if (options.case === "retarget") state.retarget = {
            aliasTarget: await Deno.readLink(`${current.vault}/alias`),
            firstSlot: await readSlot(`${current.vault}/first/Note.md.0.bak`), secondSlot: await readSlot(`${current.vault}/second/Note.md.0.bak`),
            ready: readRecord(`${current.vault}/.globnotes-backup/retarget-ready`)?.ready === true,
            released: readRecord(`${current.vault}/.globnotes-backup/retarget-release`)?.release === true,
          };
          await publishRecord(`${current.directory}/negative-state.json`, JSON.stringify(state, null, 2), { createNew: true });
          return state;
        },
        cleanup: [() => closeSession(current), () => closeServer(current)],
        write: record => publishRecord(`${artifacts}/negative-consumer.json`, JSON.stringify(record, null, 2), { createNew: true }),
      });
    } else await failureRecord();
    } finally { await finalizeNativeCase({ error, cleanup: fixtures.map(fixture => () => closeFixture(fixture)) }); }
    throw error;
  }
}
