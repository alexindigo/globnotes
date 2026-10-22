// SPDX-License-Identifier: LGPL-3.0-only

// Real settings, native input, PATCH receipts and disk consumers on plain HTTP.
import { runCase } from "./legacy-fixture.mjs";
import { assert } from "./test-outcomes.mjs";

const settingsRoute = "plugin-host/globnotes-autosave-timer/settings/autosave";
const editor = ".cm-content[contenteditable=true]";
const clean = `(()=>{const button=[...document.querySelectorAll('.content-column button')].find(el=>el.textContent.trim()==='Save');return !!document.querySelector('${editor},.milkdown-frame .ProseMirror') && button?.getAttribute('aria-busy')==='false' && !button.querySelector('.text-theme-brand,.animate-spin');})()`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function disk(f, path, expected, timeout = 5000) {
  const start = Date.now();
  do {
    try {
      const content = await Deno.readTextFile(`${f.vault}/${path}.md`);
      if (content === expected) return { path, content, elapsed: Date.now() - start };
    } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
    await sleep(50);
  } while (Date.now() - start < timeout);
  throw Error(`${path}: exact autosaved text did not reach disk within ${timeout}ms`);
}

async function replace(f, selector, text) {
  await f.page.click(selector);
  await f.page.key("a", { code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await f.page.type(text);
}

async function enter(f) {
  await f.page.button("Edit", ".content-column");
  await f.page.button("Source", ".content-column");
  await f.page.poll(`!!document.querySelector('${editor}')`);
}

async function exit(f) {
  await f.page.poll(clean);
  await f.page.button("Edit", ".content-column");
  await f.page.poll("!!document.querySelector('.toast-viewer') && !document.querySelector('.cm-content')");
}

async function configure(f, values) {
  const before = await f.api(settingsRoute);
  assert(before.status === 200, "Autosave settings read failed");
  const saved = await f.api(settingsRoute, "PUT", {
    revision: before.body.revision, sourceKey: before.body.sourceKey,
    values: { ...before.body.values, ...values },
  });
  assert(saved.status === 200, `Autosave settings commit failed: ${JSON.stringify(saved)}`);
  const after = await f.api(settingsRoute);
  assert(JSON.stringify(after.body.values) === JSON.stringify(saved.body.values), "Settings acknowledgement differs from read-back");
}

async function lateActivation(f) {
  let held;
  const release = f.page.onEvent(event => {
    if (event.method === "Fetch.requestPaused") held = event.params.requestId;
  });
  const text = "# Late activation\n\nTyped before the Autosave timer module loaded.\n";
  try {
    await f.page.send("Fetch.enable", { patterns: [{ urlPattern: "*/_/plugins/globnotes-autosave-timer/app.js*", requestStage: "Request" }] });
    await f.page.goto(f.baseUrl + "/_/new");
    await f.page.button("Source", ".content-column");
    await f.page.poll(`!!document.querySelector('${editor}')`);
    // Editor mounting and the asynchronous module request have no ordering.
    // Wait for the interception itself, while keeping activation blocked.
    const waiting = Date.now();
    while (!held && Date.now() - waiting < 5000) await sleep(25);
    const moduleRequestWaitMs = Date.now() - waiting;
    assert(held, "Late-activation scenario did not hold the browser plugin module");
    await replace(f, editor, text);
    await f.page.poll("document.querySelector('.cm-content')?.innerText.includes('Typed before the Autosave timer module loaded.')");
    // The session and its edits already exist before the plugin can subscribe.
    await sleep(400);
    await f.page.send("Fetch.continueRequest", { requestId: held });
    await f.page.send("Fetch.disable");
    const saved = await disk(f, "Late activation", text);
    await f.page.poll(clean);
    assert(await f.page.evaluate("decodeURIComponent(location.pathname)") === "/Late activation", "Late activation did not retain the created identity");
    await exit(f);
    return { case: "late-activation", typedBeforeModuleLoad: true, noNewEditSession: true, moduleRequestWaitMs, ...saved };
  } finally { release(); await f.page.send("Fetch.disable"); }
}

async function capture(f, name, selectors) {
  const directory = Deno.env.get("GLOBNOTES_AUTOSAVE_SCREENSHOTS");
  if (!directory) return;
  await Deno.mkdir(directory, { recursive: true });
  await f.page.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
  await f.page.screenshot(`${directory}/${name}.png`);
  // Review clips are working evidence in the guest, never user deliverables.
  for (const [label, selector] of Object.entries(selectors)) {
    const clip = await f.page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();const x=Math.max(0,r.x),y=Math.max(0,r.y);return {x,y,width:Math.min(innerWidth,r.right)-x,height:Math.min(innerHeight,r.bottom)-y,scale:1};})()`);
    const { data } = await f.page.send("Page.captureScreenshot", { format: "png", clip });
    await Deno.writeFile(`${directory}/review-${name}-${label}.png`, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
  }
}

export async function wysiwygBaseline(f) {
  await configure(f, { enabled: true, mode: "pause", pauseSeconds: 2 });
  const path = "Wysiwyg baseline", original = "A note without a trailing newline";
  await Deno.writeTextFile(`${f.vault}/${path}.md`, original);
  await f.page.goto(f.baseUrl + "/" + encodeURIComponent(path));
  await f.page.button("Edit", ".content-column");
  await f.page.button("WYSIWYG", ".content-column");
  await f.page.poll("!!document.querySelector('.milkdown-frame .ProseMirror')");
  const count = f.writes.length;
  await sleep(3500);
  const observed = await f.page.evaluate(clean);
  assert(observed && f.writes.length === count && await Deno.readTextFile(`${f.vault}/${path}.md`) === original,
    "Entering WYSIWYG without edits became unsaved or rewrote normalized markdown");
  await f.page.button("Edit", ".content-column");
  await f.page.poll("!!document.querySelector('.toast-viewer,[data-modal-top=true]')");
  assert(await f.page.evaluate("!!document.querySelector('.toast-viewer') && !document.querySelector('[data-modal-top=true]')"),
    "No-edit WYSIWYG exit prompted to save serializer normalization");
  await f.page.button("Edit", ".content-column");
  await f.page.poll("!!document.querySelector('.milkdown-frame .ProseMirror > p')");
  await f.page.click(".milkdown-frame .ProseMirror > p");
  await f.page.key("End", { windowsVirtualKeyCode: 35, modifiers: 2 });
  await f.page.type(" edited");
  await disk(f, path, original + " edited\n");
  await f.page.poll(clean);
  assert(f.writes.length === count + 1, "Real WYSIWYG edit did not autosave exactly once");
  await exit(f);
  return { case: "wysiwyg-no-edit-baseline", noEditPatches: 0, realEditPatches: 1 };
}

export async function renameReconciliation(f, scenarios = [
  ["WYSIWYG", false, false, false],
  ["Source", true, false, false], ["Source", true, true, false],
  ["Source", true, false, true], ["Source", true, true, true],
  ["Source", true, false, false, "repeated"], ["Source", true, true, false, "repeated"],
  ["Source", true, false, false, "copy"], ["Source", true, true, false, "copy"],
]) {
  await configure(f, { enabled: true, mode: "pause", pauseSeconds: 2 });
  const results = [];
  for (const [mode, delayed, queued, overlap, kind = "prose"] of scenarios) {
    const id = `review-${results.length}`, oldPath = `review-old/${id}`, folder = kind === "repeated" ? "review-old/a" : `review-new-${results.length}`;
    const path = `${folder}/${id}`, original = kind === "repeated" ? "![pic](a/a/p.png)\n\nBody\n" : "![pic](assets/pic.png)\n\nBody\n";
    await Deno.mkdir(`${f.vault}/review-old/assets`, { recursive: true });
    await Deno.writeFile(`${f.vault}/review-old/assets/pic.png`, f.image);
    for (const directory of ["a/a", "b/a"]) {
      await Deno.mkdir(`${f.vault}/review-old/${directory}`, { recursive: true });
      await Deno.writeFile(`${f.vault}/review-old/${directory}/p.png`, f.image);
    }
    await Deno.mkdir(`${f.vault}/${folder}/uploads`, { recursive: true });
    await Deno.writeFile(`${f.vault}/${folder}/uploads/other.png`, f.image);
    await Deno.writeTextFile(`${f.vault}/${oldPath}.md`, original);
    await f.page.goto(f.baseUrl + "/" + oldPath);
    await f.page.button("Edit", ".content-column"); await f.page.button(mode, ".content-column");
    await f.page.poll(mode === "Source" ? `!!document.querySelector('${editor}')` : "!!document.querySelector('.ProseMirror > p')");
    let held;
    const release = f.page.onEvent(event => {
      if (event.method === "Fetch.requestPaused") held = event.params.requestId;
    });
    try {
      if (delayed) await f.page.send("Fetch.enable", { patterns: [{ urlPattern: `*/_/api/notes/${encodeURIComponent(oldPath)}?*`, requestStage: "Response" }] });
      await replace(f, 'input[placeholder="Folder (root)"]', folder);
      await f.page.key("Enter", { windowsVirtualKeyCode: 13 });
      await f.page.button("Keep files, fix the links");
      const rewritten = kind === "repeated" ? original.replace("a/a/", "a/") : original.replace("assets/", "../review-old/assets/");
      let mine, expected;
      if (delayed) {
        const deadline = Date.now() + 5000;
        while (!held && Date.now() < deadline) await sleep(25);
        assert(held, "Rename response was not held");
        mine = kind === "repeated" ? original.replace("a/a/", "b/a/") : kind === "copy" ? original + "![copy](assets/pic.png)\n" : overlap ? original.replace("assets/pic.png", "uploads/other.png") : original + "New paragraph\n";
        expected = overlap ? mine : rewritten;
        await replace(f, editor, mine);
        if (queued) await f.page.button("Save", ".content-column");
        await f.page.send("Fetch.continueResponse", { requestId: held });
        await f.page.send("Fetch.disable");
      } else {
        await f.page.poll(`decodeURIComponent(location.pathname)===${JSON.stringify('/' + path)}`);
        await f.page.poll(clean);
        // A later real edit forces an autosave through the real WYSIWYG port.
        await f.page.click(".ProseMirror > p:last-of-type");
        await f.page.key("End", { windowsVirtualKeyCode: 35, modifiers: 2 });
        await f.page.type(" edited");
        expected = rewritten.replace("Body\n", "Body edited\n");
      }
      await f.page.poll(`decodeURIComponent(location.pathname)===${JSON.stringify('/' + path)}`);
      let discarded = false;
      if (delayed) {
        await f.page.poll("document.body.textContent.includes('Autosave is stopped')");
        const count = f.writes.length; await sleep(3000);
        assert(f.writes.length === count && await Deno.readTextFile(`${f.vault}/${path}.md`) === rewritten,
          "Transformed rename with newer text automatically wrote references");
        assert(await f.page.evaluate("Array.from(document.querySelectorAll('.cm-content .cm-line'),el=>el.textContent).join('\\n')") === mine,
          "Barrier changed the user's retained text");
        if (overlap) await f.page.button("Save", ".content-column");
        else {
          await f.page.button("Edit", ".content-column");
          await f.page.button("Discard", '[data-modal-top="true"]');
          await f.page.poll("!!document.querySelector('.toast-viewer') && !document.querySelector('.cm-content')");
          discarded = true;
        }
      }
      await disk(f, path, expected); if (!discarded) await f.page.poll(clean);
      const writes = f.writes.filter(row => decodeURIComponent(new URL(row.url).pathname) === "/_/api/notes/" + path);
      assert(discarded ? writes.length === 0 : writes.length === 1 && writes[0].body.newContent === expected, "Decision wrote unexpected text or duplicated the write");
      const reference = expected.match(/!\[pic\]\(([^)]+)\)/)[1];
      assert((await Deno.stat(`${f.vault}/${folder}/${reference}`)).isFile, "Final attachment reference does not resolve on disk");
      if (!discarded) await exit(f);
      await f.page.poll("(()=>{const image=document.querySelector('.toast-viewer img');return image?.complete && image.naturalWidth>0;})()");
      results.push({ mode, delayed, queued, overlap, kind, discarded, content: expected, reference, attachmentLoaded: true });
    } finally { release(); await f.page.send("Fetch.disable"); }
  }
  return results;
}

export async function autosaveTimer(f) {
  const results = [], times = new Map();
  const release = f.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent" && event.params.request.method === "PATCH") times.set(event.params.requestId, Date.now());
  });
  const mutations = path => f.writes.filter(row => decodeURIComponent(new URL(row.url).pathname) === "/_/api/notes/" + path);
  try {
    await f.page.addInitScript('localStorage.setItem("globnotes-theme","globnotes-light");');
    await f.page.goto(f.baseUrl + "/readme");
    await f.page.poll("!!document.querySelector('.toast-viewer')");
    const defaults = await f.api(settingsRoute);
    assert(defaults.status === 200 && defaults.body.values.enabled === false, "Shipped toggle is not off by default");
    await enter(f);
    const original = await Deno.readTextFile(f.vault + "/readme.md"), before = f.writes.length;
    const offText = "# Timer note\n\nTyped with Autosave off.\n";
    await replace(f, editor, offText);
    await f.page.poll("!!document.querySelector('.content-column button .text-theme-brand')");
    await sleep(4000);
    assert(await Deno.readTextFile(f.vault + "/readme.md") === original && f.writes.length === before, "Off toggle wrote text or sent a PATCH");
    results.push({ case: "off", waited: 4000, bytesUnchanged: true, patches: 0 });
    // Explicit normal save resolves this fixture's unsaved work before settings.
    await f.page.button("Save", ".content-column"); await disk(f, "readme", offText); await exit(f);

    await f.page.click('[title="Open sidebar"]');
    await f.page.click('[aria-label="Settings"]');
    await f.page.click('[data-settings-nav-id="plugin:globnotes-autosave-timer"]');
    await f.page.poll("document.querySelector('[data-settings-content]')?.dataset.settingsCurrentPage==='plugin:globnotes-autosave-timer:autosave' && document.querySelector('#settings-field-enabled')?.disabled===false");
    for (const theme of ["globnotes-dark", "globnotes-light"]) {
      await f.page.click('[data-settings-nav-id="core:appearance"]');
      await f.page.click(`[data-theme-id="${theme}"]`);
      await f.page.click('[data-settings-nav-id="plugin:globnotes-autosave-timer"]');
      await f.page.poll("!!document.querySelector('.settings-section-warning #settings-field-enabled')");
      const banner = await f.page.evaluate(`(()=>{const section=document.querySelector('.settings-section-warning'),toggle=section.querySelector('[role=switch]'),r=section.getBoundingClientRect(),t=toggle.getBoundingClientRect();return {theme:localStorage.getItem('globnotes-theme'),heading:section.querySelector('h3').textContent,paragraphs:section.querySelectorAll('.settings-section-prose p').length,toggleInside:r.left<t.left&&r.right>t.right&&r.top<t.top&&r.bottom>t.bottom,checked:toggle.getAttribute('aria-checked'),pause:document.querySelector('#settings-field-pauseSeconds')?.value,interval:!!document.querySelector('#settings-field-intervalSeconds'),secure:isSecureContext};})()`);
      assert(banner.theme === theme && banner.heading === "Before you turn this on" && banner.paragraphs === 3 && banner.toggleInside && banner.checked === "false" && banner.pause === "2" && !banner.interval && banner.secure === false, `Banner/defaults contract: ${JSON.stringify(banner)}`);
      results.push({ case: "settings-banner", ...banner });
    }
    await f.page.click('.settings-section-warning [role=switch]');
    await f.page.poll("document.querySelector('.settings-section-warning [role=switch]')?.getAttribute('aria-checked')==='true' && !document.querySelector('[data-declarative-settings] [role=status]')");
    assert((await f.api(settingsRoute)).body.values.enabled === true, "Native warning-banner toggle did not persist");
    await capture(f, "settings-light", {
      frame: '[role="dialog"]', navigation: '[aria-label="Settings pages"]',
      content: '[data-settings-content]', warning: '.settings-section-warning', timing: '.settings-section:not(.settings-section-warning)',
    });
    await f.page.click('[aria-label="Close settings"]');
    await f.page.click('aside button[title="Close sidebar"]');
    await enter(f);

    const pauseText = "# Autosave timer\n\nThis note was saved automatically after typing stopped.\n\nThe editor stays open, ready for the next thought.\n";
    const pauseCount = mutations("readme").length, pauseStart = Date.now();
    await replace(f, editor, pauseText);
    const pause = await disk(f, "readme", pauseText);
    await f.page.poll(clean, { timeout: 5000 });
    assert(mutations("readme").length === pauseCount + 1 && Date.now() - pauseStart < 5000, "Pause autosave did not complete once within 5s");
    await capture(f, "note-after-autosave-light", { header: ".content-column > div", editor: ".cm-editor", navigation: "nav" });
    results.push({ case: "pause", ...pause, clean: true, patches: 1 });

    await f.page.click(editor); await f.page.key("End", { windowsVirtualKeyCode: 35, modifiers: 2 });
    const continuousStart = Date.now(), continuousCount = mutations("readme").length;
    let suffix = "";
    while (Date.now() - continuousStart < 6000) {
      const text = "typing "; suffix += text;
      await f.page.type(text); await sleep(650);
      assert(mutations("readme").length === continuousCount, "Pause autosave wrote during continuous typing");
      assert(await Deno.readTextFile(f.vault + "/readme.md") === pauseText, "Pause mode changed disk while typing");
    }
    const continuous = await disk(f, "readme", pauseText + suffix);
    await f.page.poll(clean);
    assert(mutations("readme").length === continuousCount + 1, "Pause stop produced duplicate writes");
    results.push({ case: "continuous-pause", typingMs: Date.now() - continuousStart - continuous.elapsed, ...continuous });
    await exit(f);

    await configure(f, { mode: "interval", intervalSeconds: 5 });
    const intervalCount = mutations("readme").length, intervalStart = Date.now();
    await enter(f); await f.page.click(editor); await f.page.key("End", { windowsVirtualKeyCode: 35, modifiers: 2 });
    let intervalText = pauseText + suffix;
    const diskSnapshots = [];
    while (Date.now() - intervalStart < 11500) {
      intervalText += "tick "; await f.page.type("tick "); await sleep(650);
      const writes = mutations("readme").slice(intervalCount);
      for (const write of writes.filter(row => row.finished && !diskSnapshots.some(snapshot => snapshot.id === row.id))) {
        const content = await Deno.readTextFile(f.vault + "/readme.md");
        assert(content === write.body.newContent, "Interval tick did not write its actual snapshot to disk");
        diskSnapshots.push({ id: write.id, ms: times.get(write.id) - intervalStart, content });
      }
    }
    assert(diskSnapshots.length === 2, `Continuous interval typing did not produce two disk writes: ${JSON.stringify(diskSnapshots)}`);
    assert(diskSnapshots[0].ms >= 3500 && diskSnapshots[0].ms <= 7000 && diskSnapshots[1].ms - diskSnapshots[0].ms >= 4000 && diskSnapshots[1].ms - diskSnapshots[0].ms <= 6500, "Interval disk writes were not about 5 seconds apart");
    await disk(f, "readme", intervalText, 7000); await f.page.poll(clean); await exit(f);
    results.push({ case: "continuous-interval", snapshots: diskSnapshots });
    await configure(f, { mode: "pause", pauseSeconds: 2 });

    results.push(await wysiwygBaseline(f));
    results.push({ case: "rename-reconciliation", scenarios: await renameReconciliation(f) });
    results.push(await lateActivation(f));

    for (const [path, text] of [["Heading", "# Heading\n\nCreated without clicking Save.\n"], ["Untitled", "A new note without a heading.\n"]]) {
      await f.page.goto(f.baseUrl + "/_/new");
      await f.page.button("Source", ".content-column"); await f.page.poll(`!!document.querySelector('${editor}')`);
      const actualPath = path === "Untitled" ? await f.page.evaluate("document.querySelector('input[placeholder=Title]').value") : path;
      assert(path !== "Untitled" || /^Untitled(?: \d+)?$/.test(actualPath), "Unexpected no-heading name");
      await replace(f, editor, text);
      const created = await disk(f, actualPath, text); await f.page.poll(clean);
      assert(await f.page.evaluate("decodeURIComponent(location.pathname)") === "/" + actualPath, "Autosave created a different browser identity");
      results.push({ case: "new-note", ...created, clean: true });
      await exit(f);
    }

    await enter(f);
    let current = await f.page.evaluate("location.pathname.slice(1)");
    for (const action of ["enter", "blur"]) {
      const target = action === "enter" ? "Renamed on Enter" : "Renamed on blur";
      const count = f.writes.length;
      await replace(f, 'input[placeholder="Title"]', target);
      await sleep(2500);
      assert(f.writes.length === count && await f.page.evaluate("decodeURIComponent(location.pathname)") === "/" + current, "Title typing renamed before Enter/blur");
      assert(await Deno.readTextFile(`${f.vault}/${current}.md`) === "A new note without a heading.\n", "Title typing changed note bytes");
      if (action === "enter") await f.page.key("Enter", { windowsVirtualKeyCode: 13 });
      else await f.page.click(editor);
      await f.page.poll(`decodeURIComponent(location.pathname)===${JSON.stringify('/' + target)}`);
      await disk(f, target, "A new note without a heading.\n"); await f.page.poll(clean);
      // Enter followed by blur must not submit the same rename again.
      await f.page.click(editor); await sleep(2500);
      const writes = f.writes.slice(count);
      assert(writes.length === 1 && writes[0].body.newPath === target && writes[0].status === 200, `Rename ${action} did not send exactly one mutation`);
      try { await Deno.stat(`${f.vault}/${current}.md`); throw Error("Old filename survived rename"); }
      catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
      results.push({ case: "rename", action, patches: writes.length, path: target });
      current = target;
    }
    await exit(f);
    assert(!f.session.events.some(event => event.type === "error"), `Browser console errors: ${JSON.stringify(f.session.events)}`);
    return { results, patches: f.writes, origins: f.session.events.filter(event => event.type === "application-origin") };
  } finally { release(); }
}

if (import.meta.main) await runCase("autosave-timer", autosaveTimer);
