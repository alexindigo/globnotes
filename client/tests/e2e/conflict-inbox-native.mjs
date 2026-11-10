import { conflictCase, assert, until } from "./conflict-native-fixture.mjs";

await conflictCase("conflict-inbox-native", async f => {
  const s = f.session;
  const statusWidth = Deno.args.includes("narrow-status") ? 480 : 1280;
  await s.send("Emulation.setDeviceMetricsOverride", { width: statusWidth, height: 1100, deviceScaleFactor: 1, mobile: false });
  // Real editor overlap proves M2 banner/URL -> M3 badge/Review integration.
  await Deno.writeTextFile(`${f.vault}/Editor.md`, "first\n\nlast\n");
  await s.goto(f.url("/Editor")); await s.poll("document.querySelector('.toast-viewer')?.textContent.includes('first')");
  await s.button("Edit", ".content-column"); await s.button("Source", ".content-column"); await s.click(".cm-content");
  await s.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 }); await s.type("mine\n\nlast\n");
  await s.click(".conflict-badge"); await s.poll("!!document.querySelector('[role=dialog]')"); await s.button("Cancel", "[role=dialog]");
   assert(await s.evaluate("location.pathname.endsWith('/Editor') && document.querySelector('.cm-content')?.textContent.includes('mine')"), "Dirty note badge departure lost text/URL");
  // Deliver the real external-change notice during a held Save gesture. A
  // background update must not move the header out from under native input.
  const send = s.page.send;
  let saveGesture;
  const gestureGeometry = "(()=>{const save=[...document.querySelectorAll('.content-column button')].find(el=>el.textContent.trim()==='Save');const status=document.querySelector('[data-note-save-status]'),style=getComputedStyle(status);return {save:save.getBoundingClientRect().toJSON(),body:document.querySelector('.cm-editor').getBoundingClientRect().toJSON(),content:document.querySelector('.cm-content').getBoundingClientRect().toJSON(),status:status.getBoundingClientRect().toJSON(),message:status.textContent,title:status.title,whiteSpace:style.whiteSpace,textOverflow:style.textOverflow,overflow:style.overflow,clipped:status.scrollWidth>status.clientWidth};})()";
  s.page.send = async (method, params) => {
    const pressed = method === "Input.dispatchMouseEvent" && params.type === "mousePressed";
    const before = pressed ? await s.read(['.cm-editor', '[data-note-save-status]'], gestureGeometry) : null;
    const result = await send(method, params);
    if (pressed) {
      await Deno.writeTextFile(`${f.vault}/Editor.md`, "outside\n\nlast\n");
      await s.poll("document.querySelector('[data-note-save-status]')?.textContent.includes('This note changed elsewhere.')");
      const after = await s.read(['.cm-editor', '[data-note-save-status]'], gestureGeometry);
      saveGesture = { width: statusWidth, before, after, point: { x: params.x, y: params.y } };
      await f.capture("external-notice-during-save");
    }
    return result;
  };
  try { await s.button("Save", ".content-column"); }
  finally { s.page.send = send; }
  assert(saveGesture && ["save", "body", "content", "status"].every(region => ["x", "y", "width", "height"].every(key => saveGesture.before[region][key] === saveGesture.after[region][key])), `External state displaced Save, note body/content or status during native input: ${JSON.stringify(saveGesture)}`);
  assert(saveGesture.before.message === "" && saveGesture.after.message === "This note changed elsewhere. Your changes will be merged when you save." && saveGesture.after.title === saveGesture.after.message, "Header status lost its full accessible state message");
  assert(saveGesture.after.whiteSpace === "nowrap" && saveGesture.after.textOverflow === "ellipsis" && saveGesture.after.overflow === "hidden" && (statusWidth !== 480 || saveGesture.after.clipped), "Header state is not a single reserved, truncating line");
  f.results.push({ externalNoticeDuringSave: saveGesture });
  await s.poll("location.pathname.includes('.conflict-') && !!document.querySelector('[data-conflict-banner]')"); await f.detailCount(1);
  if (statusWidth !== 1280) await s.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await s.button("Review conflict"); await s.poll("location.pathname.includes('/_/conflicts/') && !!document.querySelector('[aria-label=\"Conflict copy source\"]')");
  const row = (await f.api("conflicts")).conflicts[0];
   assert(await s.read(['[aria-label="Original source"]', '[aria-label="Conflict copy source"]'], "document.querySelector('[aria-label=\"Original source\"]').textContent==='outside\\n\\nlast\\n' && document.querySelector('[aria-label=\"Conflict copy source\"]').textContent==='mine\\n\\nlast\\n'"), "Review did not render actual conflict members");
  await s.click('.conflicts-page > a'); await f.inboxCount(1); await f.capture("populated-inbox");
  await s.click(".conflicts-page__row"); await s.poll("!!document.querySelector('.conflict-comparison')"); await f.capture("desktop-comparison");
   const geometry = await s.read(['.conflict-comparison', '.conflict-badge__icon svg'], "(()=>{const headers=[...document.querySelectorAll('[data-conflict-version-header]')].map(el=>el.getBoundingClientRect().toJSON()),actions=[...document.querySelectorAll('.conflicts-page__actions button')].map(el=>el.getBoundingClientRect().toJSON()),page=document.querySelector('.conflicts-page').getBoundingClientRect().toJSON(),slot=document.querySelector('.conflict-badge__icon').getBoundingClientRect(),icon=document.querySelector('.conflict-badge__icon svg').getBoundingClientRect(),iconGaps={left:icon.left-slot.left,top:icon.top-slot.top,bottom:slot.bottom-icon.bottom,right:slot.right-icon.right},sourceColors=[...document.querySelectorAll('.conflict-version__source')].map(el=>getComputedStyle(el).color);return {headers,actions,page,iconGaps,sourceColors};})()");
  assert(Math.abs(geometry.headers[0].top - geometry.headers[1].top) <= 1 && Math.abs(geometry.headers[0].bottom - geometry.headers[1].bottom) <= 1, "Panel header boundaries differ");
  assert(geometry.actions.every(rect => rect.left >= geometry.page.left - 1 && rect.right <= geometry.page.right + 1), "Actions overflow column");
  assert(Math.max(...Object.values(geometry.iconGaps)) - Math.min(...Object.values(geometry.iconGaps)) <= 1, "Conflict icon has unequal facing-edge gaps");
  assert(geometry.sourceColors[0] === geometry.sourceColors[1], "Conflict copy source is muted differently from original");
  await s.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 1200, deviceScaleFactor: 1, mobile: false }); await f.capture("narrow-comparison");
   const narrow = await s.read('.conflict-comparison', "[...document.querySelectorAll('.conflict-version')].map(el=>el.getBoundingClientRect().toJSON())");
  assert(narrow[1].top >= narrow[0].bottom, "Narrow panels did not stack");
  await s.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await s.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await s.poll("document.body.classList.contains('dark')"); await f.capture("dark-comparison");
  const began = performance.now(); await Deno.remove(`${f.vault}/${row.copyPath}`);
  await s.poll("document.querySelector('.conflicts-page')?.textContent.includes('This conflict was resolved elsewhere.')"); await f.detailCount(0);
  assert(await Deno.readTextFile(`${f.vault}/${row.path}`) === "outside\n\nlast\n", "Outside closure changed original");
  f.results.push({ editorOverlap: true, nativeReview: true, prefix: f.prefix, geometry, narrow, outsideClosureMs: performance.now() - began });
  const long = await f.create("A deliberately long original filename whose conflict copy is longer still for a readable full title"); await f.compare(long);
  await s.click('[title="Open sidebar"]'); await s.click('[title="Pin sidebar"]');
   const pinned = await s.read('.conflict-comparison', "(()=>{const headers=[...document.querySelectorAll('[data-conflict-version-header]')].map(el=>el.getBoundingClientRect().toJSON()),paths=[...document.querySelectorAll('.conflict-version__path')].map(el=>({title:el.title,text:el.textContent,wrap:getComputedStyle(el).whiteSpace}));return {headers,paths,overflow:document.querySelector('.conflicts-page').scrollWidth>document.querySelector('.conflicts-page').clientWidth};})()");
  assert(!pinned.overflow && pinned.paths.every(path => path.title === path.text && path.wrap === "nowrap"), "Pinned long paths wrap, lose their full title or overflow");
  assert(Math.abs(pinned.headers[0].bottom - pinned.headers[1].bottom) <= 1, "Pinned panel header boundaries differ");
  f.results.push({ pinnedLongPaths: pinned }); await s.button("Keep both"); await f.inboxCount(0);
  await s.click('[title="Unpin sidebar"]'); await s.click('[title="Close sidebar"]');
  // Metadata-only Both must converge in poll fallback without a file event.
  const pollRow = await f.create("Poll");
  let blocked = 0, polls = 0;
  const pendingPolls = new Set();
  const reads = { list: 0, detail: 0 };
  const release = s.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent") {
      const url = new URL(event.params.request.url), path = url.pathname;
      if (path === `${f.prefix}/_/api/changes` && url.searchParams.has("poll")) pendingPolls.add(event.params.requestId);
      if (path === `${f.prefix}/_/api/conflicts`) reads.list++;
      if (path === `${f.prefix}/_/api/conflicts/${pollRow.id}`) reads.detail++;
    }
    if (event.method === "Network.loadingFinished" && pendingPolls.delete(event.params.requestId)) polls++;
    if (event.method !== "Fetch.requestPaused") return;
    if (new URL(event.params.request.url).searchParams.has("poll")) s.send("Fetch.continueRequest", { requestId: event.params.requestId });
    else { blocked++; s.send("Fetch.failRequest", { requestId: event.params.requestId, errorReason: "Failed" }); }
  });
  try {
    await s.send("Fetch.enable", { patterns: [{ urlPattern: "*/_/api/changes*", requestStage: "Request" }] });
    await f.compare(pollRow); await f.detailCount(1);
    await until(() => blocked > 0 && polls >= 2, "SSE failure and continuing poll fallback observed");
    const baseline = { ...reads }, firstPolls = polls;
    await until(() => polls >= firstPolls + 3, "three unchanged revision polls completed with comparison open");
    assert(reads.list === baseline.list && reads.detail === baseline.detail, `Unchanged polling repeated conflict reads: ${JSON.stringify({ baseline, reads })}`);
    const detail = await f.api(`conflicts/${pollRow.id}`);
    await f.api(`conflicts/${pollRow.id}/resolve`, "POST", { action: "both", revision: detail.revision, base: { original: { kind: "version", version: detail.original.version }, copy: { kind: "version", version: detail.copy.version } } });
    await s.poll("document.querySelector('.conflicts-page')?.textContent.includes('This conflict was resolved elsewhere.')");
    await f.detailCount(0); await s.click('.conflicts-page > a'); await f.inboxCount(0);
    f.results.push({ pollingMetadataOnlyClosure: true, unchangedPollingReads: baseline, quietPolls: polls - firstPolls, sseBlocked: blocked });
  } finally { release(); await s.send("Fetch.disable"); }
  await f.restart(); const readonly = await f.create("ReadOnly"); await f.restart({ GLOBNOTES_AUTH_TYPE: "read_only" });
  await s.goto(f.url(`/_/conflicts/${readonly.id}`)); await s.poll("!!document.querySelector('.conflict-comparison')");
  assert(!await s.evaluate("[...document.querySelectorAll('.conflicts-page button')].some(b=>/^(Keep |Edit a merge|Save merge)/.test(b.textContent))"), "Read-only shows mutation controls");
  f.results.push({ readOnlyComparison: true });
}, { prefix: "/prefix" });
