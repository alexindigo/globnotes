// VM-only port of main's preview-save regression. Use native Chromium on CDP_PORT.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { connect } from "./cdp.mjs";

const port = Number(Deno.env.get("CDP_PORT") || 9333);
const vault = await Deno.makeTempDir({ prefix: "save-preview-vault-" });
const artifacts = await Deno.makeTempDir({ prefix: "save-preview-artifacts-" });
const destination = "SaveDestination";
const events = [];
let server, page, targetId, failure, pending;
let phase = "setup";
let completed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`${phase}: ${message}`);
}

async function bounded(operation, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${phase}: CDP timeout`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function ownPage() {
  page = await bounded(() => connect({ port }));
  targetId = page.targetId;
  for (const name of ["send", "evaluate", "poll", "goto", "click"]) {
    const method = page[name].bind(page);
    page[name] = (...args) => bounded(() => method(...args),
      Math.max(15000, (name === "poll" ? args[1]?.timeout ?? 0 : 0) + 2000));
  }
  page.onEvent((event) => {
    if (event.method === "Runtime.consoleAPICalled") {
      events.push({ phase, level: event.params.type,
        text: event.params.args.map((a) => a.value ?? a.description ?? "").join(" ") });
    }
  });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
}

async function button(label, scope = ".content-column") {
  const expression = `(() => {
    document.querySelector('[data-save-preview-click]')?.removeAttribute('data-save-preview-click');
    const el = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})]
      .find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getBoundingClientRect().width > 0);
    el?.setAttribute('data-save-preview-click', '1');
    return !!el;
  })()`;
  await page.poll(expression);
  await page.click("[data-save-preview-click]");
}

async function persisted() {
  const { title, marker, seed } = pending;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const response = await fetch(`${server.baseUrl}/_/api/notes/${encodeURIComponent(title)}`, {
      cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    const note = response.ok ? await response.json() : null;
    if (!response.ok) await response.body?.cancel();
    if (note?.content.includes(marker)) {
      assert(!seed || note.content.includes(seed), "existing content survives the save");
      const disk = await Deno.readTextFile(`${vault}/${title}.md`);
      assert(disk === note.content, "API and disk carry the same saved buffer");
      console.log(`ok: ${phase}: API + disk include ${marker}`);
      return;
    }
    assert(response.ok || response.status === 404, `note GET returned ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${phase}: typed buffer never reached saved-note API`);
}

try {
  await Deno.writeTextFile(`${vault}/${destination}.md`, "# Destination\n\nNavigation landed here.\n");
  for (const mode of ["Source", "WYSIWYG"]) {
    for (const action of ["toolbar", "navigation"]) {
      const title = `Existing-${mode}-${action}`;
      await Deno.writeTextFile(`${vault}/${title}.md`, `Original ${title} content.\n`);
    }
  }
  server = await bootServer({
    GLOBNOTES_PATH: vault, GLOBNOTES_INDEX_PATH: `${vault}/.globnotes`,
    GLOBNOTES_AUTH_TYPE: "none", GLOBNOTES_PATH_PREFIX: "",
  });
  await ownPage();
  console.log(JSON.stringify({ source: import.meta.url, vault, artifacts,
    baseUrl: server.baseUrl, cdpPort: port, targetId }));
  for (const mode of ["Source", "WYSIWYG"]) {
    for (const kind of ["new", "existing"]) {
      for (const action of kind === "new" ? ["toolbar", "close", "navigation"] : ["toolbar", "navigation"]) {
        phase = `${kind}-${mode}-${action}`;
        console.log(`start: ${phase}`);
        const title = kind === "new" ? `New-${mode}-${action}` : `Existing-${mode}-${action}`;
        const seed = kind === "existing" ? `Original ${title} content.` : "";
        const marker = `saved-preview-${phase}`;
        const errorStart = events.length;
        await page.goto(`${server.baseUrl}/${kind === "new" ? "_/new" : title}`);
        await page.poll(kind === "new" ? "!!document.querySelector('.cm-content, .ProseMirror')"
          : "!!document.querySelector('.toast-viewer')", { timeout: 20000 });
        if (await page.evaluate("!!document.querySelector('aside button[title=\"Close sidebar\"]')?.getBoundingClientRect().width")) {
          await page.click('aside button[title="Close sidebar"]');
          await page.poll("!document.querySelector('aside button[title=\"Close sidebar\"]')?.getBoundingClientRect().width");
        }
        if (kind === "existing") await button("Edit");
        await button(mode);
        const editor = mode === "Source" ? ".cm-content[contenteditable=true]" : ".ProseMirror[contenteditable=true]";
        await page.poll(`!!document.querySelector(${JSON.stringify(editor)})`);
        if (kind === "new") {
          await page.click('input[placeholder="Title"]');
          for (const type of ["keyDown", "keyUp"]) {
            await page.send("Input.dispatchKeyEvent", { type, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
          }
          await page.send("Input.insertText", { text: title });
          await page.poll(`document.querySelector('input[placeholder="Title"]').value === ${JSON.stringify(title)}`);
        }
        // WYSIWYG includes noneditable property widgets; click its paragraph,
        // not the container center, so native input reaches editable content.
        const inputTarget = mode === "Source" ? editor : `${editor} > p`;
        await page.poll(`!!document.querySelector(${JSON.stringify(inputTarget)})`);
        await page.click(inputTarget);
        pending = { title, marker, seed, mode, action };
        await page.send("Input.insertText", { text: `${marker}\n\n` });
        await page.poll(`document.querySelector(${JSON.stringify(editor)})?.textContent.includes(${JSON.stringify(marker)})`);
        await button("Preview");
        await page.poll(`document.querySelector('.preview-buffer')?.textContent.includes(${JSON.stringify(marker)})`);
        assert(await page.evaluate("!document.querySelector('.cm-editor, .ProseMirror')"), "preview unmounts both editors");
        const preference = await page.evaluate("localStorage.getItem('defaultEditorMode')");
        if (action === "toolbar") {
          await button("Save");
        } else {
          const heldUrl = await page.evaluate("location.href");
          if (action === "close") await button("Edit");
          else {
            await page.click('button[title="Open sidebar"]');
            await page.poll(`!!document.querySelector('aside a[href="/${destination}"]')`);
            await page.click(`aside a[href="/${destination}"]`);
          }
          await page.poll("[...document.querySelectorAll('.fixed.z-50')].some(e => e.textContent.includes('Save Changes'))");
          assert(await page.evaluate("location.href") === heldUrl, "dirty modal holds the current URL");
          await button("Save", ".fixed.z-50");
        }
        await persisted();
        const path = action === "navigation" ? destination : title;
        await page.poll(`location.pathname === ${JSON.stringify(`/${path}`)}`, { timeout: 10000 });
        // Main's new-note save commits its route and opens view mode;
        // existing-note toolbar saves keep the current preview session.
        await page.poll(action === "toolbar" && kind === "existing" ? "!!document.querySelector('.preview-buffer')"
          : "!!document.querySelector('.toast-viewer') && !document.querySelector('.preview-buffer, .cm-editor, .ProseMirror')");
        if (action !== "toolbar") assert(await page.evaluate("location.hash === ''"), "modal Save exits edit mode in the URL");
        assert(await page.evaluate("localStorage.getItem('defaultEditorMode')") === preference, "preview Save preserves the editor preference");
        assert(page.pageErrors.length === 0, `page errors: ${JSON.stringify(page.pageErrors)}`);
        assert(!events.slice(errorStart).some(e => e.level === "error"), "no browser console errors during Save");
        // API/disk persistence can precede the browser's acknowledgement. The
        // next scenario must not navigate while the prior Save still owns work.
        if (action === "toolbar" && kind === "existing") {
          await page.poll("(() => { const button = [...document.querySelectorAll('.content-column button')].find(button => button.textContent.trim() === 'Save'); return button?.getAttribute('aria-busy') === 'false' && !document.querySelector('.content-column .animate-spin'); })()", { timeout: 10000 });
        }
        pending = null;
        completed++;
        console.log(`ok: ${phase}: persisted and routed`);
      }
    }
  }
  assert(completed === 10, `all ten cases ran, got ${completed}`);
} catch (error) {
  failure = error;
  console.error(`FAIL: ${error.message}`);
} finally {
  await Deno.writeTextFile(`${artifacts}/diagnostics.json`, JSON.stringify({
    phase, completed, failure: failure?.message, pending, vault,
    baseUrl: server?.baseUrl, targetId, events, pageErrors: page?.pageErrors ?? [],
    preview: page ? await page.evaluate("document.querySelector('.preview-buffer')?.textContent").catch(String) : null,
  }, null, 2));
  console.log(`save-preview diagnostics: ${artifacts}/diagnostics.json`);
  if (failure) {
    // Retain the dirty page and caller-owned vault; never discard to clean up.
    console.error(`Retained failed probe: ${server?.baseUrl}; vault ${vault}; target ${targetId}`);
    console.error(JSON.stringify({ events, pageErrors: page?.pageErrors ?? [] }));
  } else {
    await page?.close();
    await server?.close();
  }
  if (failure) { page?.page.close(); page?.browser.close(); }
}
if (failure) throw failure;
console.log("SAVE-PREVIEW OK (10 cases)");
