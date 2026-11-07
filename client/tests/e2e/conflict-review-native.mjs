import { conflictCase, assert, until } from "./conflict-native-fixture.mjs";

await conflictCase("conflict-review-native", async f => {
  const s = f.session;
  for (const side of ["path", "copyPath"]) {
    const row = await f.create(`Stale-${side}`); await f.compare(row); await s.button("Edit a merge"); await f.fill(`retained ${side}\n`);
    let paused;
    const release = s.page.onEvent(event => { if (event.method === "Fetch.requestPaused") paused = event.params.requestId; });
    try {
      await s.send("Fetch.enable", { patterns: [{ urlPattern: "*/conflicts/*/resolve", requestStage: "Request" }] });
      await s.button("Save merge", ".conflicts-page"); await s.button("Save merge", "[role=dialog]"); await until(() => !!paused, "resolution dispatch held");
      const changed = `outside changed ${side}\n`; await Deno.writeTextFile(`${f.vault}/${row[side]}`, changed);
      await s.send("Fetch.continueRequest", { requestId: paused }); await s.send("Fetch.disable");
      await s.poll("document.querySelector('.conflicts-page')?.textContent.includes('These files changed. Review current versions before resolving.') && !document.querySelector('[aria-busy=true]')");
      assert(await s.evaluate("document.querySelector('.conflicts-page').textContent.split('These files changed. Review current versions before resolving.').length-1") === 1, "Stale review status is duplicated");
      assert(await s.evaluate("document.querySelector('#conflict-merge').value") === `retained ${side}\n`, "Stale result replaced merge draft");
      assert(await Deno.readTextFile(`${f.vault}/${row[side]}`) === changed && !await f.absent(row.copyPath), "Stale choice had destructive effects");
      await f.capture("stale-review");
      const before = f.writes.length;
      await s.button("Review current versions"); await s.poll("[...document.querySelectorAll('.conflicts-page button')].some(b=>b.textContent==='Save merge')");
      assert(!await s.evaluate("document.querySelector('.conflicts-page').textContent.includes('These files changed. Review current versions before resolving.')"), "Accepted review kept stale instructions");
      assert(f.writes.length === before, "Review resent resolution");
      await s.button("Postpone"); await s.poll("!!document.querySelector('[role=dialog]')"); await s.button("Cancel", "[role=dialog]");
      assert(await s.evaluate("location.pathname.includes('/_/conflicts/') && document.querySelector('#conflict-merge').value") === `retained ${side}\n`, "Cancelled Postpone lost draft/URL");
      // A second browser resolves the record. Local text stays selectable and
      // its stored draft is not acknowledged by somebody else's choice.
      const peer = await f.peer(); await peer.goto(f.url(`/_/conflicts/${row.id}`)); await peer.button("Keep both");
      await s.poll("document.body.textContent.includes('This conflict was resolved elsewhere.') && !!document.querySelector('#conflict-merge')");
      assert(await s.evaluate("Object.keys(sessionStorage).some(key=>key.startsWith('globnotes:conflict-draft:'))"), "Outside resolution erased browser draft");
      await s.click('.conflicts-page > a'); await s.poll("!!document.querySelector('[role=dialog]')"); await s.button("Cancel", "[role=dialog]");
      assert(await s.evaluate("document.querySelector('#conflict-merge').value") === `retained ${side}\n`, "Closed Cancel lost text");
      await s.click('.conflicts-page > a'); await s.button("Discard draft", "[role=dialog]"); await f.inboxCount(0);
      assert(!await s.evaluate("Object.keys(sessionStorage).some(key=>key.startsWith('globnotes:conflict-draft:'))"), "Explicit discard retained owned draft");
      assert(await Deno.readTextFile(`${f.vault}/${row[side]}`) === changed, "Local discard changed vault file");
      f.results.push({ side, staleNoEffects: true, draftRetained: true, peerClosure: true, explicitDiscardLocalOnly: true });
    } finally { release(); await s.send("Fetch.disable"); }
  }
  // A lost successful server reply is still an unknown client outcome until a
  // closed authoritative review. This models transport loss after actual effects.
  const row = await f.create("Unknown"); await f.compare(row); await s.button("Edit a merge"); await f.fill("unacknowledged merge\n");
  let paused;
  const release = s.page.onEvent(event => { if (event.method === "Fetch.requestPaused") paused = event.params.requestId; });
  try {
    await s.send("Fetch.enable", { patterns: [{ urlPattern: "*/conflicts/*/resolve", requestStage: "Response" }] });
    await s.button("Save merge", ".conflicts-page"); await s.button("Save merge", "[role=dialog]"); await until(() => !!paused, "successful response held");
    assert(await Deno.readTextFile(`${f.vault}/${row.path}`) === "unacknowledged merge\n" && await f.absent(row.copyPath), "Unknown fixture was not admitted to real effects");
    await s.send("Fetch.failRequest", { requestId: paused, errorReason: "Failed" }); await s.send("Fetch.disable");
    await s.poll("document.body.textContent.includes('The resolution outcome is unknown.')");
    await s.button("Review current versions"); await s.poll("document.body.textContent.includes('This conflict was resolved elsewhere.')");
    assert(await s.evaluate("document.querySelector('#conflict-merge').value") === "unacknowledged merge\n", "Unknown closed read falsely acknowledged draft");
    await s.click('.conflicts-page > a'); await s.button("Cancel", "[role=dialog]");
    assert(f.writes.filter(request => request.content === "unacknowledged merge\n").length === 1, "Unknown outcome replayed");
    f.results.push({ unknownActualEffects: true, noReplay: true, closedReviewRetainsDraft: true });
  } finally { release(); await s.send("Fetch.disable"); }
  await s.click('.conflicts-page > a'); await s.button("Discard draft", "[role=dialog]"); await f.inboxCount(0);
  const partial = await f.create("Partial-response"); await f.compare(partial); await s.button("Edit a merge"); await f.fill("partial response retained\n");
  let partialResponse;
  const releasePartial = s.page.onEvent(event => { if (event.method === "Fetch.requestPaused") partialResponse = event.params.requestId; });
  try {
    await s.send("Fetch.enable", { patterns: [{ urlPattern: "*/conflicts/*/resolve", requestStage: "Response" }] });
    await s.button("Save merge", ".conflicts-page"); await s.button("Save merge", "[role=dialog]"); await until(() => !!partialResponse, "actual effects before partial response");
    await s.send("Fetch.fulfillRequest", { requestId: partialResponse, responseCode: 500, responseHeaders: [{ name: "content-type", value: "application/json" }],
      body: btoa(JSON.stringify({ code: "operation_partial", detail: "Fixture partial response after actual effects", partial: { completedPaths: [partial.path, partial.copyPath] } })) });
    await s.send("Fetch.disable"); await s.poll("document.body.textContent.includes('The resolution outcome is unknown.')");
    await s.button("Review current versions"); await s.poll("document.body.textContent.includes('This conflict was resolved elsewhere.')");
    assert(await s.evaluate("document.querySelector('#conflict-merge').value") === "partial response retained\n", "Partial response lost the browser draft");
    await s.click('.conflicts-page > a'); await s.button("Discard draft", "[role=dialog]"); await f.inboxCount(0);
    assert(f.writes.filter(request => request.content === "partial response retained\n").length === 1, "Partial response authorized a replay");
    assert(await Deno.readTextFile(`${f.vault}/${partial.path}`) === "partial response retained\n" && await f.absent(partial.copyPath), "Partial-response fixture did not retain actual effects");
    f.results.push({ injectedPartialResponseAfterActualEffects: true, draftRetained: true, noReplay: true });
  } finally { releasePartial(); await s.send("Fetch.disable"); }
  await f.restart({ GLOBNOTES_AUTH_TYPE: "password", GLOBNOTES_USERNAME: "m3-fixture", GLOBNOTES_PASSWORD: "m3-fixture-password", GLOBNOTES_SECRET_KEY: "m3-native-fixture-only-secret-key" });
  await s.goto(f.url("/_/conflicts")); await f.login("m3-fixture", "m3-fixture-password");
  const guarded = await f.create("Departure");
  await s.goto(f.url("/_/conflicts")); await f.inboxCount(1); await s.click(".conflicts-page__row"); await s.button("Edit a merge"); await f.fill("departure draft\n");
  // CDP's history command drives browser history itself. Renderer key injection
  // does not invoke Chrome's window-level Alt+Left/Right accelerator headlessly.
  const historyMove = async delta => { const history = await s.send("Page.getNavigationHistory"); await s.send("Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex + delta].id }); };
  await historyMove(-1);
  await s.poll("!!document.querySelector('[role=dialog]')"); await s.button("Cancel", "[role=dialog]");
  assert(await s.evaluate("location.pathname.endsWith('/" + guarded.id + "') && document.querySelector('#conflict-merge').value") === "departure draft\n", "Browser Back Cancel lost URL or draft");
  await s.click('[title="Open sidebar"]'); await s.click('[aria-label="Settings"]'); await s.button("Account"); await s.button("Log out");
  await s.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Merge draft')"); await s.button("Cancel", "[data-modal-top=true]");
  assert(await s.evaluate("!!sessionStorage.getItem('token') && document.querySelector('#conflict-merge').value") === "departure draft\n", "Logout Cancel retired credentials or merge draft");
  await s.click('[aria-label="Close settings"]');
  if (await s.evaluate("document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width>0")) await s.click('[title="Close sidebar"]');
  await historyMove(-1); await s.button("Discard draft", "[role=dialog]"); await f.inboxCount(1);
  await historyMove(1); await s.poll("!!document.querySelector('.conflict-comparison')");
  assert(await s.evaluate("location.pathname.endsWith('/" + guarded.id + "') && !document.querySelector('#conflict-merge')"), "Browser Forward selected the wrong record or revived a discarded draft");
  assert(await Deno.readTextFile(`${f.vault}/${guarded.path}`) === guarded.outside && await Deno.readTextFile(`${f.vault}/${guarded.copyPath}`) === guarded.mine, "Departure modified vault files");
  f.results.push({ browserBackCancel: true, browserForward: true, logoutCancelRetainsCredentialsAndDraft: true });
  const late = await f.create("Late-logout"); await f.compare(late); await s.button("Edit a merge"); await f.fill("late acknowledged merge\n");
  let lateResponse;
  const releaseLate = s.page.onEvent(event => { if (event.method === "Fetch.requestPaused") lateResponse = event.params.requestId; });
  try {
    await s.send("Fetch.enable", { patterns: [{ urlPattern: "*/conflicts/*/resolve", requestStage: "Response" }] });
    await s.button("Save merge", ".conflicts-page"); await s.button("Save merge", "[role=dialog]"); await until(() => !!lateResponse, "late response after actual effects");
    await s.click('[title="Open sidebar"]'); await s.click('[aria-label="Settings"]'); await s.button("Account"); await s.button("Log out");
    // Exercise the production 60-second bound, without changing any budget or
    // aborting the admitted wire. The suite's existing 120-second child cap stays.
    await new Promise(resolve => setTimeout(resolve, 61_000));
    assert(await s.evaluate("!!sessionStorage.getItem('token') && location.pathname.endsWith('/" + late.id + "')"), "Unknown observation let logout clear credentials");
    await s.send("Fetch.continueResponse", { requestId: lateResponse }); await s.send("Fetch.disable");
    await s.poll("document.body.textContent.includes('Kept Late-logout.md.')");
    assert(!await s.evaluate("document.querySelector('.conflicts-page').textContent.includes('This conflict was resolved elsewhere.')"), "Own acknowledged result is labelled as outside resolution");
    assert(await s.evaluate("!!sessionStorage.getItem('token') && location.pathname.endsWith('/" + late.id + "') && !!document.querySelector('#settings-modal-title')"), "Late acknowledgement revived aborted logout/navigation");
    assert(f.writes.filter(request => request.content === "late acknowledged merge\n").length === 1 && await Deno.readTextFile(`${f.vault}/${late.path}`) === "late acknowledged merge\n" && await f.absent(late.copyPath), "Late outcome replayed or lost actual effects");
    f.results.push({ productionObservationBoundMs: 60_000, lateAcknowledgementDoesNotReviveLogout: true, actualMergeEffects: true });
  } finally { releaseLate(); await s.send("Fetch.disable"); }
});
