// Feature-owned real server/files and native input. No browser-only conflict state.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { applicationServer } from "./http-origin.mjs";
import { nativeSession } from "./native-cdp-session.mjs";
import { assert } from "./test-outcomes.mjs";
import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";
export { assert };
export const until = (predicate, label) => waitUntil(async () => await predicate() ? done() : pending({ label }), { label, intervalMs: 50 });

export async function conflictCase(name, run, { prefix = "", env = {} } = {}) {
  const parent = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "m3-native-" });
  const directory = `${parent}/${name}`, vault = `${directory}/vault`, state = `${directory}/state/globnotes`;
  await Deno.mkdir(vault, { recursive: true });
  let server, session;
  const writes = [], results = [], peers = [];
  async function api(path, method = "GET", body) {
    const token = session ? await session.evaluate("location.protocol==='http:' ? sessionStorage.getItem('token') || localStorage.getItem('token') : null") : null;
    const response = await fetch(`${server.baseUrl}${prefix}/_/api/${path}`, { method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const result = await response.json(); assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`); return result;
  }
  async function create(label) {
    const base = "first\n\nmiddle\n\nlast\n", outside = `outside ${label}\n\nmiddle\n\nlast\n`, mine = `mine ${label}\n\nmiddle\n\nlast\n`;
    await Deno.writeTextFile(`${vault}/${label}.md`, base);
    await api(`notes/${encodeURIComponent(label)}`);
    await Deno.writeTextFile(`${vault}/${label}.md`, outside);
    const saved = await api(`notes/${encodeURIComponent(label)}`, "PATCH", { newPath: label, newContent: mine, baseContent: base });
    assert(saved.saveResult?.status === "conflict", `Fixture ${label} did not create a real overlapping save`);
    const row = (await api("conflicts")).conflicts.find(row => row.copyPath === saved.path + ".md");
    assert(row, `Conflict record missing for ${saved.path}`);
    return { ...row, outside, mine, base };
  }
  async function capture(label) {
    await session.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const { data } = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await Deno.writeFile(`${directory}/${label}.png`, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
    const regions = await session.evaluate(`(() => {
      const selected = { shell: 'nav', sidebar: '[title="Open sidebar"]', main: '.conflicts-page', original: '.conflict-version:first-child', copy: '.conflict-version:last-child', merge: '.conflicts-page__merge', actions: '.conflicts-page__actions' };
      const regions = {};
      for (const [name, selector] of Object.entries(selected)) {
        const r = document.querySelector(selector)?.getBoundingClientRect(); if (!r || r.width < 1 || r.height < 1) continue;
        const x = Math.max(0,r.left), y = Math.max(0,r.top), right = Math.min(innerWidth,r.right), bottom = Math.min(innerHeight,r.bottom);
        if (right > x && bottom > y) regions[name] = { x, y, width: right-x, height: bottom-y, scale: 1 };
      }
      return regions;
    })()`);
    await Deno.mkdir(`${directory}/review`, { recursive: true });
    await Deno.writeTextFile(`${directory}/review/${label}-regions.json`, JSON.stringify(regions, null, 2));
    for (const [name, clip] of Object.entries(regions)) {
      const crop = await session.send("Page.captureScreenshot", { format: "png", clip });
      await Deno.writeFile(`${directory}/review/${label}-${name}.png`, Uint8Array.from(atob(crop.data), c => c.charCodeAt(0)));
    }
  }
  try {
    server = await bootServer({ GLOBNOTES_GLOBNOTES_PATH: vault, GLOBNOTES_METADATA_PATH: `${directory}/state`, fixtureAuth: { auth_type: "none" }, GLOBNOTES__SERVER_PATHPREFIX: prefix, ...env }, applicationServer());
    session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335), height: 1100 });
    session.page.onEvent(event => {
      if (event.method === "Network.requestWillBeSent" && /\/conflicts\/[^/]+\/resolve$/.test(event.params.request.url)) {
        writes.push(JSON.parse(event.params.request.postData));
      }
    });
    const f = { directory, vault, state, prefix, api, create, capture, session, writes, results,
      url: path => `${server.baseUrl}${prefix}${path}`,
      server: () => server,
      async restart(extra = {}) { await server.close(); server = await bootServer({ GLOBNOTES_GLOBNOTES_PATH: vault, GLOBNOTES_METADATA_PATH: `${directory}/state`, fixtureAuth: { auth_type: "none" }, GLOBNOTES__SERVER_PATHPREFIX: prefix, ...env, ...extra }, applicationServer()); },
      async peer() { const peer = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) }); peers.push(peer); return peer; },
      async holdResolutionResponse(row) {
        let response;
        const endpoint = `${server.baseUrl}${prefix}/_/api/conflicts/${row.id}`;
        const release = session.page.onEvent(event => {
          if (event.method === "Fetch.requestPaused" && event.params.request.url === `${endpoint}/resolve`) response = event.params.requestId;
        });
        // The wire and background authoritative reads race independently. Hold
        // the real detail responses until the explicit review intent, so unknown
        // authority cannot disappear between observing its status and clicking.
        try {
          await session.send("Fetch.enable", { patterns: [endpoint, `${endpoint}/resolve`].map(urlPattern => ({ urlPattern, requestStage: "Response" })) });
        } catch (error) { release(); throw error; }
        return {
          async wait(label) { await until(() => !!response, label); return response; },
          async review() { await session.button("Review current versions"); await session.send("Fetch.disable"); },
          async dispose() { release(); await session.send("Fetch.disable"); },
        };
      },
      async login(username, password) {
        await session.poll("!!document.querySelector('#username')");
        await session.click("#username"); await session.type(username); await session.click("#password"); await session.type(password); await session.button("Log In");
        await session.poll("!document.querySelector('#username')");
      },
      async compare(row) {
        await session.goto(f.url(`/_/conflicts/${row.id}`));
        await session.poll(`document.querySelector('[aria-label="Original source"]')?.textContent===${JSON.stringify(row.outside)} && document.querySelector('[aria-label="Conflict copy source"]')?.textContent===${JSON.stringify(row.mine)}`);
      },
      async fill(text) {
        await session.poll("!!document.querySelector('#conflict-merge') && !document.querySelector('#conflict-merge').readOnly");
        await session.click("#conflict-merge"); await session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 }); await session.type(text);
        await session.poll(`document.querySelector('#conflict-merge')?.value===${JSON.stringify(text)}`);
      },
      async absent(path) { return await Deno.stat(`${vault}/${path}`).then(() => false, error => { if (error instanceof Deno.errors.NotFound) return true; throw error; }); },
      async inboxCount(n) { await session.poll(`document.querySelector('.conflicts-page')?.textContent.includes(${JSON.stringify(`${n} unresolved`)}) && document.querySelector('.conflict-badge')?.getAttribute('aria-label')===${JSON.stringify(n ? `Conflicts: ${n} unresolved` : "Conflicts")}`); },
      async detailCount(n) { await session.poll(`document.querySelector('.conflict-badge')?.getAttribute('aria-label')===${JSON.stringify(n ? `Conflicts: ${n} unresolved` : "Conflicts")}`); },
    };
    await run(f);
    assert(session.errors.length === 0, `Browser exceptions: ${JSON.stringify(session.errors)}`);
    await Deno.writeTextFile(`${directory}/results.json`, JSON.stringify({ results, writes, events: session.events }, null, 2));
    console.log(JSON.stringify({ case: name, results, artifacts: directory }));
  } catch (error) {
    if (session) {
      await capture("failure").catch(() => {});
      const observed = await session.evaluate("({href:location.href,text:document.body.innerText,active:document.activeElement?.outerHTML})").catch(() => null);
      await Deno.writeTextFile(`${directory}/failure.json`, JSON.stringify({ error: String(error), observed, results, writes, events: session.events, errors: session.errors, server: server?.logs() }, null, 2));
    }
    throw error;
  } finally { for (const peer of peers) await peer.close(); await session?.close(); await server?.close(); }
}
