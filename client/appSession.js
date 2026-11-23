// SPDX-License-Identifier: LGPL-3.0-only
import { reactive, readonly, ref } from "vue";
import { apiErrorHandler, createIdentityApi, getConfig } from "./api.js";
import { applyBrandToDocument } from "./brand.js";
import { authTypes } from "./constants.js";
import { getToastOptions } from "./helpers.js";
import { refreshNoteIndex } from "./noteIndex.js";
import { refreshPluginRuntimeCatalog, stopPluginRuntime } from "./pluginRuntime.js";
import { resolveParticipants, retainUnsavedWork } from "./sessionActions.js";
import { clearStoredToken, createIdentityTokenStorage } from "./tokenStorage.js";
import { identitySessionKey } from "./appSessionPolicy.js";
import { createOperationOwner } from "./operationOwner.js";

/** Prepared capability session. Draft/wire participants outlive live access.
 * Recovery reads belong to the credential attempt, not its retired stream key. */
export function createIdentityAppSession({ config, setConfig, tokens = createIdentityTokenStorage(),
  transport, http, resolve = resolveParticipants, startRuntime = () => {}, stopRuntime = stopPluginRuntime,
  setChangesSession = () => {}, setBrowseSession = () => {}, clearBrowseData = () => {}, refreshNotes = () => {},
  applyBrand = applyBrandToDocument, navigate = () => {}, failed = () => {} } = {}) {
  const ready = ref(false), valid = ref(false);
  let epoch = 0, credential = 0, ticket = 0, transitionPending = null, disposed = false;
  const key = () => valid.value ? identitySessionKey(config()) : null;
  const stamp = () => ({ epoch, credential, token: tokens.getStoredToken() });
  const credentialCurrent = captured => !disposed && captured.credential === credential && captured.token === tokens.getStoredToken();
  const current = captured => captured.epoch === epoch && credentialCurrent(captured);
  const capture = () => { const captured = stamp(); return () => current(captured); };
  const captureCredential = () => { const captured = stamp(); return () => credentialCurrent(captured); };
  const io = transport ?? createIdentityApi({ tokens, http, sessionKey: key, captureLive: capture, captureCredential, onAuthorityFailure(error) {
    retainUnsavedWork(); retire();
    if ((error.response?.status ?? error.status) === 403) void refresh();
  } });
  function createAttempt() {
    let owner;
    const guarded = deliver => ({
      prepare(value) {
        // Capture caller data/getters before the last G5 fence. Releasing this
        // exact operation cannot retire a newer independent refresh.
        const prepared = { ...value };
        if (!current(prepared.stamp) || prepared.ticket !== undefined && prepared.ticket !== ticket) void owner.release(prepared.operation);
        return { value: prepared };
      }, deliver,
    });
    owner = createOperationOwner({ owner: Object.freeze({}),
      dispatch: intent => intent === "logout" ? resolve("logout") : intent === "login" ? resolve("login") : io.getConfig(),
      channels: {
        config: guarded(value => { value.receipt.accepted = adopt(value.fresh); }),
        failed: guarded(value => failed(value.error)),
        navigate: guarded(value => navigate(value.target)),
      },
    });
    return owner;
  }
  // One G5 custody owner observes every original wire, including reads from
  // replaced credentials. Domain stamps fence disclosure without abandoning
  // those wires or inventing another all-attempt disposal collector.
  const attempt = createAttempt();
  function retire() {
    const retiring = ++epoch; ticket++; valid.value = false;
    // Every external callback may replace the credential or projection.
    stopRuntime(); if (retiring !== epoch) return false;
    setChangesSession(null); if (retiring !== epoch) return false;
    setBrowseSession(null); if (retiring !== epoch) return false;
    clearBrowseData(); return retiring === epoch;
  }
  function adopt(fresh) {
    if (disposed) return false;
    if (!fresh?.capabilities || !fresh.principal || !fresh.sessionGeneration) throw new Error("Invalid identity projection.");
    const changed = !valid.value || identitySessionKey(fresh) !== key();
    if (changed && !retire()) return false;
    const adopting = epoch;
    setConfig(fresh); if (adopting !== epoch) return false;
    valid.value = true; ready.value = true;
    if (fresh.capabilities.canRead) {
      applyBrand(fresh.brand); if (adopting !== epoch) return false;
      if (changed) {
        setBrowseSession(key()); if (adopting !== epoch) return false;
        startRuntime(key()); if (adopting !== epoch) return false;
        setChangesSession(key()); if (adopting !== epoch) return false;
        refreshNotes();
      }
    }
    return adopting === epoch;
  }
  async function refresh() {
    if (disposed) return false;
    const owner = attempt, operation = owner.operation("recovery"), captured = stamp(), own = ++ticket;
    try {
      const response = await owner.dispatch(operation, "config");
      const receipt = { accepted: false };
      const payload = { operation, stamp: captured, ticket: own, fresh: response.value, receipt };
      // The config channel performs the adoption synchronously at its last fence.
      return owner.deliver(operation, "config", payload) && receipt.accepted;
    } catch (error) {
      if (!current(captured) || own !== ticket || owner !== attempt) return false;
      if ((error.response?.status ?? error.status) === 401 && valid.value) retire();
      // A loaded outage retires disclosure, not the initial-load error screen.
      // Logout/recovery already retired it; do not invalidate that original
      // completion merely because its anonymous revalidation is unavailable.
      if (ready.value) { retainUnsavedWork(); if (valid.value) retire(); }
      else owner.deliver(operation, "failed", { operation, stamp: stamp(), ticket, error });
      return false;
    } finally { await owner.release(operation); }
  }
  async function beforeSignIn() {
    const owner = attempt, operation = owner.operation(), captured = stamp();
    try { return (await owner.dispatch(operation, "login")).value === "proceed" && current(captured) && owner === attempt; }
    finally { await owner.release(operation); }
  }
  function acceptToken(token, persist) {
    if (disposed || !retire()) return false;
    credential++;
    tokens.storeToken(token, persist);
    return true;
  }
  function logout() {
    if (transitionPending) return transitionPending;
    const owner = attempt, operation = owner.operation("retained"), captured = stamp();
    transitionPending = (async () => {
      try {
        const decision = await owner.dispatch(operation, "logout");
        if (decision.value !== "proceed" || !current(captured) || owner !== attempt || !retire()) return false;
        credential++; tokens.clearStoredToken();
        const completing = stamp();
        const refreshed = await refresh();
        if (completing.credential !== credential || completing.token !== tokens.getStoredToken() || !refreshed && !current(completing)) return false;
        return owner.deliver(operation, "navigate", { operation, stamp: refreshed ? stamp() : completing, target: { name: "login" } });
      } finally { await owner.release(operation); }
    })().finally(() => { transitionPending = null; });
    return transitionPending;
  }
  return Object.freeze({ state: readonly(reactive({ ready, valid })), key, capture,
    load: refresh, refresh, adopt, invalidate: retire, beforeSignIn, acceptToken, logout, transport: io, tokens,
    hasWork: () => attempt.hasWork(), settle: () => attempt.settle(),
    dispose() { disposed = true; retire(); return attempt.dispose(); },
  });
}

/** Configuration acknowledgements and session handoffs retain their original order. */
export function createAppSession({
  config, setConfig, setSetupRequested, setSettingsVisible, navigate, toast, loaded, failed,
  readConfig = getConfig, applyBrand = applyBrandToDocument, reportError = apiErrorHandler,
  refreshNotes = refreshNoteIndex, refreshCatalog = refreshPluginRuntimeCatalog,
  stopRuntime = stopPluginRuntime, resolve = resolveParticipants, clearToken = clearStoredToken,
  loadTokenStorage = () => import("./tokenStorage.js"),
}) {
  const configReady = ref(false);
  let configRefreshTicket = 0, logoutPending = null;
  function load() {
    return readConfig().then(data => {
      setConfig(data); configReady.value = true; applyBrand(data.brand); loaded(); refreshNotes();
    }).catch(error => { reportError(error, toast); failed(); });
  }
  function refreshConfig() {
    const ticket = ++configRefreshTicket;
    return readConfig().then(fresh => {
      if (ticket !== configRefreshTicket || fresh.accessRevision === undefined || fresh.accessRevision < (config().accessRevision ?? 0)) return;
      setConfig(fresh);
    }).catch(() => {});
  }
  function openAccessFromSettings() { setSettingsVisible(false); setSetupRequested(true); }
  function beforeSetupCommit() { return resolve("access").then(result => result === "proceed"); }
  function logoutFromSettings() {
    if (logoutPending) return logoutPending;
    logoutPending = (async () => {
      if (await resolve("logout") !== "proceed") return;
      stopRuntime();
      const { clearStoredToken } = await loadTokenStorage();
      clearStoredToken(); setSettingsVisible(false); await navigate({ name: "login" });
    })().finally(() => { logoutPending = null; });
    return logoutPending;
  }
  function setupCompleted(result) {
    if (result) {
      const view = result.view;
      const acknowledged = result.config ?? {
        ...config(), setupRequired: false,
        authType: view.mode === 'password' ? view.totpEnabled ? authTypes.totp : authTypes.password : view.mode,
        settingsWritable: view.settingsWritable, readOnlySettings: view.readOnlySettings, accessRevision: view.revision,
      };
      setConfig({ ...config(), ...acknowledged }); setSetupRequested(false); configRefreshTicket++;
      if (result.requiresLogin) {
        stopRuntime(); clearToken();
        toast.add(getToastOptions("Access updated — sign in with your confirmed credentials.", "Access updated", "success"));
        navigate({ name: "login" });
      } else if ([authTypes.none, authTypes.readOnly].includes(acknowledged.authType)) {
        clearToken();
        if (acknowledged.authType === authTypes.readOnly) navigate({ name: "home" });
        else { refreshNotes(); refreshCatalog(); }
      } else refreshCatalog();
      // A follow-up read cannot strand or replay the acknowledged transition.
      readConfig().then(fresh => {
        if ((fresh.accessRevision ?? -1) >= (config().accessRevision ?? 0)) setConfig(fresh);
      }).catch(() => {});
      return;
    }
    setSetupRequested(false);
    // First-run setup flipped auth server-side: re-fetch config and route.
    readConfig().then(data => {
      setConfig(data); applyBrand(data.brand);
      if ([authTypes.none, authTypes.readOnly].includes(data.authType)) {
        loadTokenStorage().then(({ clearStoredToken }) => clearStoredToken());
        refreshNotes(); navigate({ name: "home" });
      } else {
        stopRuntime();
        loadTokenStorage().then(async ({ clearStoredToken }) => { clearStoredToken(); await navigate({ name: "login" }); });
        toast.add(getToastOptions("Password created — sign in with your new credentials.", "Setup complete", "success"));
      }
    });
  }
  return { state: readonly(reactive({ configReady })), load, refreshConfig,
    openAccessFromSettings, beforeSetupCommit, logoutFromSettings, setupCompleted };
}
