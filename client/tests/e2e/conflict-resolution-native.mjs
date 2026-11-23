import { conflictCase, assert, until } from "./conflict-native-fixture.mjs";
import { assertEquals } from "@std/assert";

// A real stream can replay the fixture's file changes after its comparison is
// already visible. Complete that reread across native geometry sampling: source
// presence alone used to admit Postpone at the temporary one-button position.
await conflictCase("conflict-readiness", async f => {
  const s = f.session, row = await f.create("Replay-readiness");
  let stream, reread, reads = 0, holding = true, boundary;
  const continuations = [];
  const release = s.page.onEvent(event => {
    if (event.method !== "Fetch.requestPaused") return;
    const { requestId, request } = event.params;
    if (request.url.includes("/_/api/changes")) stream = requestId;
    else if (++reads === 1 || !holding) {
      const work = s.send("Fetch.continueResponse", { requestId });
      continuations.push(work); work.catch(() => {});
    } else reread = requestId;
  });
  const geometry = `(()=>{const page=document.querySelector('.conflicts-page'),actions=page.querySelector('[aria-label="Conflict actions"]');const button=[...actions.querySelectorAll('button')].find(el=>el.textContent.trim()==='Postpone');return {rect:button.getBoundingClientRect().toJSON(),actions:[...actions.querySelectorAll('button')].map(el=>el.textContent.trim()),notice:page.querySelector('[role=status]')?.textContent??null,busy:actions.closest('[aria-busy]')?.getAttribute('aria-busy')??null};})()`;
  const send = s.page.send;
  try {
    await s.send("Fetch.enable", { patterns: [
      { urlPattern: "*/_/api/changes*", requestStage: "Request" },
      { urlPattern: `*/_/api/conflicts/${row.id}`, requestStage: "Response" },
    ] });
    await f.compare(row);
    await until(() => !!stream, "initial real changes stream held");
    await s.send("Fetch.continueRequest", { requestId: stream });
    await until(() => !!reread, "comparison reread from replayed file changes");
    await s.poll("document.querySelector('.conflicts-page')?.textContent.includes('These files changed. Review current versions before resolving.')");
    const before = await s.evaluate(geometry);
    assertEquals(before.actions, ["Postpone"]);
    s.page.send = async (method, params) => {
      const result = await send(method, params);
      const sampling = method === "Runtime.evaluate" && params.expression.includes("const before=el.getBoundingClientRect()");
      // Release at the first refused sample, or (on the broken baseline) at
      // the final admitted sample. Never retry or replay a pointer gesture.
      if (!boundary && sampling && (!result.result?.value || params.expression.includes("const el=window.__globnotesNativeClick.el"))) {
        boundary = { before, sample: result.result?.value };
        holding = false;
        await s.send("Fetch.continueResponse", { requestId: reread });
        await s.poll("[...document.querySelectorAll('[aria-label=\"Conflict actions\"] button')].map(el=>el.textContent.trim()).join('|')==='Keep original|Keep conflict copy|Keep both|Edit a merge|Postpone'");
        boundary.after = await s.evaluate(geometry);
        await Deno.writeTextFile(`${f.directory}/readiness-boundary.json`, JSON.stringify(boundary, null, 2));
      }
      return result;
    };
    await s.button("Postpone");
    s.page.send = send;
    await f.inboxCount(1);
    await Promise.all(continuations);
    assertEquals([boundary.before.busy, boundary.sample, boundary.after.busy, boundary.after.notice], ["true", false, "false", null]);
    assertEquals([await Deno.readTextFile(`${f.vault}/${row.path}`), await Deno.readTextFile(`${f.vault}/${row.copyPath}`), f.writes], [row.outside, row.mine, []]);
    f.results.push({ postponedAfterRealReplay: true, boundary });
  } finally { s.page.send = send; release(); await s.send("Fetch.disable"); }
});

await conflictCase("conflict-resolution-native", async f => {
  const s = f.session;
  for (const action of ["original", "copy", "both", "merge", "postpone"]) {
    const row = await f.create(`Choice-${action}`); await f.compare(row);
    if (action === "postpone") {
      await s.button("Postpone"); await f.inboxCount(1);
      assert(await Deno.readTextFile(`${f.vault}/${row.path}`) === row.outside && await Deno.readTextFile(`${f.vault}/${row.copyPath}`) === row.mine, "Postpone changed files");
      f.results.push({ action, open: (await f.api("conflicts")).total });
      // Explicitly resolve the fixture after proving Postpone, so later counts
      // remain per-choice. Keep both itself is also verified below.
      await f.compare(row); await s.button("Keep both"); await f.inboxCount(0); continue;
    }
    let content;
    const label = { original: "Keep original", copy: "Keep conflict copy", both: "Keep both", merge: "Save merge" }[action];
    const shown = await f.api(`conflicts/${row.id}`);
    if (action === "merge") {
      await s.button("Edit a merge"); content = "\uFEFF# A different heading\n\nLiteral <script>source</script>\n"; await f.fill(content);
      assert(!await s.evaluate("[...document.querySelectorAll('.conflicts-page button')].some(b=>b.textContent.startsWith('Keep '))"), "Merge exposes competing keep actions");
      await f.capture("manual-merge");
    }
    await s.button(label, ".conflicts-page");
    if (action !== "both") {
      await s.poll("!!document.querySelector('[role=dialog]')");
       assert(await s.read('[role=dialog]', `document.querySelector('[role=dialog]').textContent.includes(${JSON.stringify(row.path)}) && document.querySelector('[role=dialog]').textContent.includes(${JSON.stringify(row.copyPath)})`), "Confirmation omitted actual filenames");
      await s.key("Tab", { windowsVirtualKeyCode: 9 }); assert(await s.evaluate("!!document.activeElement.closest('[role=dialog]')"), "Confirmation leaked focus");
      await s.button("Cancel", "[role=dialog]");
      assert(f.writes.length === (action === "merge" ? 3 : action === "copy" ? 1 : 0), "Cancelled confirmation dispatched a resolution");
      await s.poll("!document.querySelector('[role=dialog]')");
      assert(await s.evaluate("document.activeElement?.textContent.trim()") === label, "Confirmation did not restore opener focus");
      await s.button(label, ".conflicts-page"); await s.button(label, "[role=dialog]");
    }
    await f.inboxCount(0);
    const request = f.writes.at(-1);
    assert(request.action === action && request.revision === shown.revision && request.base.original.version === shown.original.version && request.base.copy.version === shown.copy.version, "Resolution did not send the two displayed bases");
    const expected = action === "copy" ? row.mine : action === "merge" ? content : row.outside;
    assert(await Deno.readTextFile(`${f.vault}/${row.path}`) === expected, `${action}: wrong kept bytes`);
    assert(action === "both" ? await Deno.readTextFile(`${f.vault}/${row.copyPath}`) === row.mine : await f.absent(row.copyPath), `${action}: wrong copy removal`);
    assert((await f.api(`conflicts/${row.id}`)).state === "resolved", `${action}: metadata not closed`);
    const note = await f.api(`notes/${row.path.slice(0, -3)}`); assert(note.content === expected, `${action}: ordinary reader did not see kept content`);
    f.results.push({ action, original: row.path, copy: row.copyPath, diskAndOrdinaryReader: true, request });
    if (action === "both") {
      await f.restart(); await s.goto(f.url("/_/conflicts")); await f.inboxCount(0);
      assert((await f.api(`conflicts/${row.id}`)).state === "resolved", "Keep both reopened after restart");
    }
  }
  await f.capture("empty-inbox");
});
