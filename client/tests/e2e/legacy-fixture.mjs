// Explicit caller-owned native fixtures; no home-vault reset or external server.
import { bootServer } from "./harness-helpers.mjs";
import { nativeSession } from "./native-cdp-session.mjs";
import { clickReady } from "./native-actions.mjs";
import { assert } from "./test-outcomes.mjs";

const ROOT = new URL("../../..", import.meta.url).pathname;
export const CHAIN = ["readme", "rendering/code-blocks", "rendering/math", "rendering/callouts", "rendering/highlights", "rendering/mermaid", "rendering/frontmatter", "links/wiki-links", "links/embeds", "folders/dad/recipes/soup", "folders/mom/ideas", "rename-me/moving-note"];
export const CODE = 'def greet(name):\n    print(f"Hello {name}")\n';
export const MOVING = "# Moving note\n\n![pic](assets/pic.png)\n";

export async function createFixture(name, directory, { empty = false } = {}) {
  await Deno.mkdir(directory, { mode: 0o700 });
  const vault = directory + "/vault", state = directory + "/state";
  await Deno.mkdir(vault); await Deno.mkdir(state);
  await Deno.writeTextFile(state + "/config.json", JSON.stringify({ auth_type: "none", brand_name: "Native Test Notes" }), { createNew: true });
  const image = await Deno.readFile(ROOT + "/client/assets/apple-touch-icon.png");
  const special = {
    "rendering/code-blocks": `# code-blocks\n\n\`\`\`python\n${CODE}\`\`\`\n`,
    "rendering/math": "# math\n\n$$x^2 + y^2 = z^2$$\n",
    "rendering/callouts": "# callouts\n\n> [!WARNING]\n> Be careful.\n",
    "rendering/highlights": "# highlights\n\nA ==highlighted== word.\n",
    "rendering/mermaid": "# mermaid\n\n```mermaid\ngraph TD; A[Start] --> B[Finish];\n```\n",
    "rendering/frontmatter": "---\nstatus: seed\ntags: [native]\n---\n\n# frontmatter\n",
    "links/wiki-links": "# wiki-links\n\n[[rendering/math]]\n",
    "links/embeds": "# embeds\n\n![icon](assets/glob-icon.png)\n",
    "rename-me/moving-note": MOVING,
  };
  if (!empty) {
    for (const [index, path] of CHAIN.entries()) {
      const file = vault + "/" + path + ".md";
      await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      const next = CHAIN[index + 1];
      const links = ["readme", "folders/mom/ideas"].includes(path) ? "\n[[rename-me/moving-note]]\n" : "";
      await Deno.writeTextFile(file, (special[path] ?? `# ${path.split("/").at(-1)}\n`) + `\nFixture ${path}. #inbox\n` + links + (next ? `\n[Next](/${next})\n` : ""), { createNew: true });
      // Distinct fixture times make the recent-order consumer unambiguous.
      await Deno.utime(file, new Date("2025-01-01T00:00:00Z"), new Date(Date.UTC(2025, 0, 1, 0, 0, index)));
    }
    for (const path of ["links/assets/glob-icon.png", "rename-me/assets/pic.png"]) {
      await Deno.mkdir((vault + "/" + path).slice(0, (vault + "/" + path).lastIndexOf("/")), { recursive: true });
      await Deno.writeFile(vault + "/" + path, image, { createNew: true });
    }
  }
  let server, session;
  try {
    server = await bootServer(vault, state, { logsDir: directory });
    session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
    const baseUrl = server.baseUrl;
    const writes = [];
    const releaseWire = session.page.onEvent(event => {
      const data = event.params;
      if (event.method === "Network.requestWillBeSent" && data.request.method === "PATCH" && data.request.url.startsWith(baseUrl + "/_/api/notes/")) {
        writes.push({ id: data.requestId, url: data.request.url, body: JSON.parse(data.request.postData) });
      } else if (event.method === "Network.responseReceived") {
        const write = writes.find(row => row.id === data.requestId);
        if (write) write.status = data.response.status;
      } else if (event.method === "Network.loadingFinished") {
        const write = writes.find(row => row.id === data.requestId);
        if (write) write.finished = true;
      }
    });
    const api = async (path, method = "GET", body) => {
      const response = await fetch(baseUrl + "/_/api/" + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const page = {
      ...session, pageErrors: session.errors,
      onEvent: session.page.onEvent,
      click: selector => clickReady(session, selector),
      async button(text, scope = "body") {
        await session.poll(`(()=>{document.querySelector('[data-legacy-click]')?.removeAttribute('data-legacy-click');const root=document.querySelector(${JSON.stringify(scope)});const button=[...(root?.querySelectorAll('button')??[])].find(el=>el.getBoundingClientRect().width&&(el.textContent.trim()===${JSON.stringify(text)}||[...el.querySelectorAll('*')].some(child=>child.textContent.trim()===${JSON.stringify(text)})));button?.setAttribute('data-legacy-click','1');return !!button;})()`);
        await clickReady(session, '[data-legacy-click]');
      },
      async clickText(text) { return this.button(text); },
      async fill(selector, value) { await session.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing input');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`); },
      addInitScript: source => session.send("Page.addScriptToEvaluateOnNewDocument", { source }),
      async reload() { await session.send("Page.reload"); await session.poll("document.readyState==='complete'"); },
      waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
      async screenshot(path) { const { data } = await session.send("Page.captureScreenshot", { format: "png" }); await Deno.writeFile(path, Uint8Array.from(atob(data), char => char.charCodeAt(0)), { createNew: true }); },
      async grantClipboard() { await session.browser.send("Browser.grantPermissions", { browserContextId: session.browserContextId, origin: baseUrl, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }); },
      readClipboard: () => session.evaluate("navigator.clipboard.readText()"),
    };
    await page.addInitScript('for(const [key,value] of [["sidebarVisible","false"],["sidebarRecent","false"]])if(localStorage.getItem(key)===null)localStorage.setItem(key,value);');
    await Deno.writeTextFile(directory + "/ownership.json", JSON.stringify({ name, vault, state, baseUrl, pid: server.pid, targetId: session.targetId, browserContextId: session.browserContextId }, null, 2), { createNew: true });
    let closing;
    return { name, directory, vault, state, server, page, session, baseUrl, api, image, writes,
      close() { return closing ??= (async()=>{ releaseWire(); try { await session.close(); } finally { await server.close(); } })(); } };
  } catch (error) {
    if (session) await session.close();
    if (server) await server.close();
    throw error;
  }
}

export async function runCase(name, exercise, options = {}) {
  const parent = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "globnotes-native-" });
  await Deno.mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = parent + "/" + name;
  let fixture, failure, interrupted = false;
  const terminate = () => {
    interrupted = true;
    if (fixture) void fixture.close().finally(() => Deno.exit(1));
  };
  Deno.addSignalListener("SIGTERM", terminate);
  try {
    fixture = await createFixture(name, directory, options);
    assert(!interrupted, "Native case interrupted before admission");
    const consumer = await exercise(fixture);
    assert(fixture.page.pageErrors.length === 0, "Unexpected native page exception");
    await Deno.writeTextFile(directory + "/result.json", JSON.stringify({ name, passed: true, consumer }, null, 2), { createNew: true });
  } catch (error) {
    failure = error;
    if (fixture) {
      let observed;
      try { observed = await fixture.page.evaluate("({url:location.href,body:document.body.innerText,selection:getSelection().toString()})"); }
      catch (captureError) { observed = { error: String(captureError) }; }
      await Deno.writeTextFile(directory + "/failure.json", JSON.stringify({ name, error: String(error), pageErrors: fixture.page.pageErrors, writes: fixture.writes, observed }, null, 2), { createNew: true });
    }
  } finally {
    if (fixture) await fixture.close();
    Deno.removeSignalListener("SIGTERM", terminate);
  }
  if (failure) throw failure;
}
