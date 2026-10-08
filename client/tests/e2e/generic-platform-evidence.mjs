// Feature-owned acceptance projection from actual native consumer records.
export async function collectProductionRows(read) {
  const require = (condition, message) => { if (!condition) throw Error(message); };
  const item = (rows, name) => { const found = rows.find(row => row.name === name); require(found, `Missing consumer: ${name}`); return found; };
  const rows = [];
  const record = (number, marker, evidence) => rows.push({ number, marker, passed: true, evidence });
  const settings = await read("settings/diagnostics.json");
  require(!settings.failure && settings.outcomes.length === 16 && settings.outcomes.every(row => row.passed), "Full native Settings matrix incomplete");
  const inline = await read("settings/inline-core/consumers.json");
  const actions = item(inline, "native-palette-sdk-settings-actions"), remap = item(inline, "native-remapped-settings-action");
  require(actions.builtInPalette && actions.sameEditor && remap.sameEditor && remap.instances === 1 && remap.repeatedOpenSameDialog, "Settings opening paths do not retain their one owner");
  record(1, "GPS-01 SETTINGS ACTIONS OK", { actions, remap });
  const menu = await read("settings/menu-parity/consumers.json");
  const brand = item(inline, "inline-branding-disk-and-cancel"), theme = item(inline, "inline-appearance-effect");
  const access = await read("access/diagnostics.json");
  require(!access.failure && access.outcomes.length >= 15 && access.outcomes.every(row => row.passed), "Native Access/TOTP matrix incomplete");
  require(menu.renderedLineNumberGutter && menu.debugDisabledPersisted && menu.existingParticipationRetained && menu.floatingMenuAbsent && menu.nativeSearchSort === "Last Modified" && theme.theme === "globnotes-dark" && brand.persisted === "Native inline brand", "Menu parity lacks real effects");
  require(access.outcomes.some(row => row.name.includes("confirmed-login")) && access.outcomes.some(row => row.name.includes("pinned Access")), "Menu auth/TOTP consumers absent");
  record(2, "GPS-02 MENU PARITY OK", { menu, brand, theme, accessOutcomes: access.outcomes });
  const peers = await read("settings/cross-browser/consumers.json");
  const persistence = item(peers, "native-settings-persistence-command-and-hook-matrix");
  const stages = ["native-text-enter", "native-text-blur", "settings-reopen", "fresh-document-reload", "native-toggle", "backend-restart"];
  require(persistence.stages.length === 6 && stages.every((name, index) => {
    const row = persistence.stages[index];
    return row.name === name && row.hookRuns === index + 1 && row.exactNoteApiAndDisk && row.privateDataDisk && row.independentPeer && row.originalDirtyEditorAndUrlRetained && ["message", "limit", "protect"].every(key => row.command[key] === row.values[key] && row.hook[key] === row.values[key]);
  }), "Settings persistence did not reach command/hook/API/disk consumers at every stage");
  record(3, "GPS-03 SETTINGS PERSISTENCE OK", persistence);
  const reconciliation = item(peers, "remote-disable-reenable-owned-contributions");
  require(reconciliation.disabledCommand === 404 && reconciliation.disabledEndpoint === 404 && reconciliation.disabledGuardRemoved === 200 && reconciliation.reenabledEndpoint === 200 && reconciliation.reenabledGuard === 409 && reconciliation.enabledSubscriptionDelta === 1 && reconciliation.dirtyEditorRetained, "Reconciliation consumers incomplete");
  record(4, "GPS-04 RECONCILIATION OK", reconciliation);
  const guards = await read("guards/diagnostics.json");
  require(!guards.failure && guards.outcomes.length === 2 && guards.outcomes.every(row => row.passed), "Save/Delete guard matrix incomplete");
  const protection = [];
  for (const name of ["save", "delete"]) {
    const consumer = await read(`guards/${name}/consumers.json`), retained = await read(`guards/${name}/retention.json`);
    require(consumer.nativeReasonVisible && consumer.exactRetention && consumer.onlyPreBlockingBadges && !consumer.pageErrors.length && retained.exactNoteApiDiskIndexAndAttachmentsRetained && retained.noDestinationDirectory && retained.observer.saves === 0 && retained.guard[name === "save" ? "saves" : "deletes"] === 1, "Native guard preservation consumer missing");
    protection.push({ name, consumer, retained });
  }
  record(5, "GPS-05 GUARD PRESERVATION OK", protection);
  const palette = item(inline, "native-palette-settings-consumer");
  require(palette.rendered === "native committed message" && palette.sdkSettingsRead && palette.sameEditor, "Palette did not reach the intended UI consumer");
  record(6, "GPS-06 PALETTE CONSUMER OK", palette);
  const pending = await read("settings/pending-recovery/consumers.json");
  const draft = item(peers, "actual-cas-conflict-invalid-draft-recovery");
  const late = item(pending, "native-pending-wire-late-acknowledgement"), recovered = item(pending, "native-lost-acknowledgement-read-back");
  require(draft.topmostEscapeKeptDraft && late.newerInvalidDraftRetained && late.departureBlockedWhileUnresolved && late.duplicateWrites === 0 && late.topmostEscapeKeptDraft && recovered.noReplayAfterExplicitReview && recovered.dirtyEditorRetained, "Draft/uncertain wire outcomes incomplete");
  record(7, "GPS-07 DRAFT SAFETY OK", { draft, late, recovered });
  const prefixes = await read("prefix/diagnostics.json");
  require(!prefixes.failure && prefixes.outcomes.length === 8 && prefixes.outcomes.every(row => row.passed), "Prefix/auth matrix incomplete");
  const auth = [];
  for (const prefix of ["empty", "notes"]) for (const mode of ["password", "none", "read_only", "setup"]) {
    const name = `${prefix}-${mode}`, consumer = await read(`prefix/${name}/consumers.json`), assets = await read(`prefix/${name}/asset-consumers.json`);
    require(!consumer.pageErrors.length && assets.allObservedAssets200AtPrefix, "Prefix asset/auth consumer failed");
    if (mode === "password" || mode === "none") require(consumer.actualEditorSdkIdentity && consumer.actualRuntimeSdk && consumer.privateHookConsumer.content === consumer.exactApiDiskContent, "Prefix SDK/private hook consumer absent");
    if (mode === "password") {
      const stream = await read(`prefix/${name}/stream-consumers.json`);
      require(stream.expiredReconnectStatus === 401 && stream.oldCredentialRejections === 3 && stream.bothNativeBrowserOwnersDisposed && stream.freshNativeLogin && stream.signedExpiryFrames.includes("unauthorized") && !stream.signedExpiryFrames.includes("event: invalidate") && stream.securityTransitionFrames.includes("policy-change"), "Current-auth stream outcomes missing");
    }
    if (mode === "read_only") require(consumer.readonlyAdmissions === 3 && consumer.readonlyBrowserSdkConsumer, "Read-only boundary consumer missing");
    if (mode === "setup") require(consumer.setupRejections === 5 && consumer.noWorkerActivation && consumer.noBrowserRuntime, "Setup boundary consumer missing");
    auth.push({ name, consumer, assetResponses: assets.assets.length });
  }
  record(8, "GPS-08 PREFIX AUTH OK", auth);
  const editors = [];
  for (const mode of ["source", "wysiwyg"]) {
    const row = await read(`settings/editor-${mode}/consumers.json`);
    require(row.sameEditorAcrossCommandUpdates && row.bufferRetainedAcrossFactoryChanges && row.sameNoteUrl && row.actualBrowserSaveAcknowledged && row.apiStatus === 200 && row.apiDiskContent.includes(`status: native-${mode}`), "Editor/Properties consumer incomplete");
    editors.push(row);
  }
  record(9, "GPS-09 EDITOR PROPERTIES OK", editors);
  const geometry = await read("settings/geometry/consumers.json");
  require(geometry.length === 8 && new Set(geometry.map(row => row.label)).size === 8 && geometry.every(row => row.footer.centerDelta < 0.5 && row.footer.contained && row.footer.gearHit && row.footer.recentHit && row.dialog.contained && row.dialog.overflowX <= 1 && row.dialog.editorRetained && row.nativeFocusWrap && row.openerRestored), "Geometry/focus matrix incomplete");
  record(10, "GPS-10 GEOMETRY OK", { geometry, spatialReviewRequired: true });
  const handoffs = ["optional-wizard-open-dismiss", ...["wizard", "logout"].flatMap(kind => ["cancel", "discard", "save", "blocked-save"].map(choice => `${kind}-${choice}`))];
  require(handoffs.every(name => settings.outcomes.some(row => row.name === name && row.passed)), "Missing native session handoff outcome");
  record(11, "GPS-11 SESSION HANDOFF OK", { handoffs });
  require(rows.length === 11, "Missing production acceptance row");
  return rows;
}
