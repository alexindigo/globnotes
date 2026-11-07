import { conflictCase, assert } from "./conflict-native-fixture.mjs";

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
      assert(await s.evaluate(`document.querySelector('[role=dialog]').textContent.includes(${JSON.stringify(row.path)}) && document.querySelector('[role=dialog]').textContent.includes(${JSON.stringify(row.copyPath)})`), "Confirmation omitted actual filenames");
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
