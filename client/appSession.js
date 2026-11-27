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
import { createSessionContext } from "./sessionContext.js";

/** Prepared capability session. Draft/wire participants outlive live access.
 * Recovery reads belong to the credential attempt, not its retired stream key. */
export function createIdentityAppSession({ config, setConfig, tokens = createIdentityTokenStorage(),
  transport, http, resolve = resolveParticipants, startRuntime = () => {}, stopRuntime = stopPluginRuntime,
  setChangesSession = () => {}, setBrowseSession = () => {}, clearBrowseData = () => {}, refreshNotes = () => {},
  applyBrand = applyBrandToDocument, navigate = () => {}, failed = () => {},
  reloadPage = () => window.location.reload() } = {}) {
  const ready = ref(false), valid = ref(false), reloadRequired = ref(null);
  let latestRead, transitionPending = null, activeAccount = null, locking = false;
  const key = () => valid.value ? identitySessionKey(config()) : null;
  const context = createSessionContext({ key, tokens, isOpen: () => !reloadRequired.value });
  const unavailable = () => context.disposed || locking || !!reloadRequired.value;
  const { capture } = context;
  const io = transport ?? createIdentityApi({ http, context, onAuthorityFailure(error, current) {
    retainUnsavedWork();
    if (!current() || !retire()) return;
    if ((error.response?.status ?? error.status) === 403) void refresh();
  } });
  const attempt = createOperationOwner({ owner: Object.freeze({}),
      dispatch: intent => intent === "logout" ? resolve("logout") : intent === "login" ? resolve("login") : io.getConfig(),
      channels: {
        config: { deliver: value => { value.accepted = adopt(value.fresh, value.onTransition); } },
        failed: { deliver: failed },
        navigate: { deliver: value => { value.navigation = navigate(value.target); } },
      },
    });
  function retire(onTransition = () => {}, closing = false) {
    const current = closing ? () => true : context.advanceProjection();
    onTransition(current);
    valid.value = false;
    // Every external callback may replace the credential or projection.
    if (!current()) return false;
    stopRuntime(); if (!current()) return false;
    setChangesSession(null); if (!current()) return false;
    setBrowseSession(null); if (!current()) return false;
    clearBrowseData(); return current();
  }
  function adopt(fresh, onTransition = () => {}) {
    if (unavailable()) return false;
    if (!fresh?.capabilities || !fresh.principal || !fresh.sessionGeneration) throw new Error("Invalid identity projection.");
    const account = fresh.principal.kind === "account" ? fresh.accountId ?? fresh.principal.id : null;
    if (activeAccount !== null && account !== null && account !== activeAccount) {
      // The next account never receives a live projection in this document.
      // Flush while the outgoing editor still owns its original storage scope.
      locking = true;
      try { if (valid.value) retainUnsavedWork(); retire(); }
      finally {
        const login = fresh.principal.login;
        reloadRequired.value = Object.freeze({ detail: `You're now signed in as ${login}. Reload to continue.`, actionLabel: "Reload", action: reload });
        locking = false;
      }
      return false;
    }
    const changed = !valid.value || identitySessionKey(fresh) !== key();
    let adopting = context.captureTransition();
    if (changed && !retire(current => { adopting = current; onTransition(current); })) return false;
    setConfig(fresh); if (!adopting()) return false;
    valid.value = true; if (!adopting()) return false;
    ready.value = true; if (!adopting()) return false;
    activeAccount = account;
    if (fresh.capabilities.canRead) {
      applyBrand(fresh.brand); if (!adopting()) return false;
      if (changed) {
        setBrowseSession(key()); if (!adopting()) return false;
        startRuntime(key()); if (!adopting()) return false;
        setChangesSession(key()); if (!adopting()) return false;
        refreshNotes();
      }
    }
    return adopting();
  }
  async function refresh(onAccepted) {
    if (unavailable()) return false;
    latestRead = {};
    const current = context.captureTransition().bind(() => latestRead);
    const owner = attempt, operation = owner.operation("recovery", current);
    let failureCurrent = current;
    try {
      const response = await owner.dispatch(operation, "config");
      const receipt = { fresh: response.value, onTransition: next => { failureCurrent = next.bind(() => latestRead); } };
      if (!owner.deliver(operation, "config", receipt) || !receipt.accepted) return false;
      onAccepted?.(capture());
      return true;
    } catch (error) {
      if (!failureCurrent()) return false;
      if (ready.value) {
        retainUnsavedWork();
        if (failureCurrent() && valid.value) retire();
      } else owner.deliver(operation, "failed", error, failureCurrent);
      return false;
    } finally { await owner.release(operation); }
  }
  async function beforeSignIn() {
    if (unavailable()) return false;
    // A named account can obtain new proof without asking the old editor to
    // save/discard; its actual account id is verified by the config response.
    if (activeAccount !== null) return true;
    const current = capture(), owner = attempt, operation = owner.operation("live", current);
    try { return (await owner.dispatch(operation, "login")).value === "proceed" && current(); }
    finally { await owner.release(operation); }
  }
  function replaceCredential(write) {
    if (unavailable()) return false;
    const current = context.captureTransition();
    if (valid.value) retainUnsavedWork();
    if (!current() || !retire()) return false;
    const installing = context.advanceCredential();
    return write() !== false && installing();
  }
  const acceptToken = (token, persist) => replaceCredential(() => tokens.storeToken(token, persist));
  const stopSharedSignIn = tokens.subscribeSharedSignIn?.(token => {
    if (replaceCredential(() => tokens.acceptSharedSignIn(token))) void refresh();
  });
  function logout() {
    if (unavailable()) return Promise.resolve(false);
    if (transitionPending?.current()) return transitionPending.pending;
    const current = capture(), owner = attempt, operation = owner.operation("retained", current);
    const transition = { current };
    transitionPending = transition;
    transition.pending = Promise.resolve().then(async () => {
      try {
        const decision = await owner.dispatch(operation, "logout");
        if (decision.value !== "proceed" || !current() || !retire()) return false;
        const clearing = context.advanceCredential();
        const signedOut = transition.current = () => clearing() && !tokens.getStoredToken();
        tokens.clearStoredToken();
        const delivery = { target: { name: "login" } };
        if (!owner.deliver(operation, "navigate", delivery, signedOut)) return false;
        if (signedOut()) void refresh().catch(error => { if (signedOut()) failed(error); });
        await delivery.navigation;
        return true;
      } finally { await owner.release(operation); }
    }).finally(() => { if (transitionPending === transition) transitionPending = null; });
    return transition.pending;
  }
  function reload() { if (reloadRequired.value) reloadPage(); }
  return Object.freeze({ state: readonly(reactive({ ready, valid, reloadRequired })), key, capture,
    load: refresh, refresh, adopt, invalidate: () => !unavailable() && retire(), beforeSignIn, acceptToken, logout, transport: io, tokens,
    hasWork: () => attempt.hasWork(), settle: () => attempt.settle(),
    dispose() { if (!context.disposed) { stopSharedSignIn?.(); context.dispose(); retire(undefined, true); } return attempt.dispose(); },
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
