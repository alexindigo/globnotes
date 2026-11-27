// SPDX-License-Identifier: LGPL-3.0-only
import { reactive, readonly, ref } from "vue";
import { apiErrorHandler, createIdentityApi, getConfig } from "./api.js";
import { applyBrandToDocument } from "./brand.js";
import { authTypes } from "./constants.js";
import { getToastOptions } from "./helpers.js";
import { refreshNoteIndex } from "./noteIndex.js";
import { refreshPluginRuntimeCatalog, stopPluginRuntime } from "./pluginRuntime.js";
import { hasUnsavedWork, resolveParticipants, retainUnsavedWork } from "./sessionActions.js";
import { requestIdentityReauthentication } from "./reauthentication.js";
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
  reloadPage = () => window.location.reload(),
  recover, outage = () => {}, retainedWork = hasUnsavedWork, reauthenticate = requestIdentityReauthentication, currentRoute = () => null } = {}) {
  const ready = ref(false), valid = ref(false), reloadRequired = ref(null);
  let latestRead, transitionPending = null, documentAccount = null, locking = false, loginProof = null;
  let acceptedSignIn = null, releaseRecovery = null, authorityRead = null, credentialHandoff = null;
  function cancelSignIn() { const previous = acceptedSignIn; acceptedSignIn = null; previous?.resolve(null); }
  function matchesSignIn(fresh) {
    const own = acceptedSignIn;
    return !!own && own.current() &&
      fresh.principal?.kind === "account" && fresh.principal.login === own.login &&
      (!own.accepted || own.accepted.id === fresh.principal.id && own.accepted.generation === fresh.sessionGeneration);
  }
  function completeSignIn() {
    const own = acceptedSignIn, fresh = config();
    if (!valid.value || !matchesSignIn(fresh)) return;
    own.accepted = { id: fresh.principal.id, generation: fresh.sessionGeneration };
    const current = own.current.bind(() => acceptedSignIn, () => config().principal?.id, () => config().sessionGeneration);
    own.resolve(Object.freeze({ principal: Object.freeze({ ...fresh.principal }), current: () => valid.value && current() }));
  }
  const key = () => valid.value ? identitySessionKey(config()) : null;
  const context = createSessionContext({ key, tokens, isOpen: () => !reloadRequired.value });
  const unavailable = () => context.disposed || locking || !!reloadRequired.value;
  const { capture, captureCredential } = context;
  const io = transport ?? createIdentityApi({ http, context, onAuthorityFailure: authorityChanged });
  const attempt = createOperationOwner({ owner: Object.freeze({}),
      dispatch: intent => intent === "logout" ? resolve("logout") : intent === "login" ? resolve("login") :
        intent?.kind === "accepted-sign-in" ? intent.accepted : io.getConfig(intent?.options),
      cancel: cancelSignIn,
      channels: {
        config: { deliver: value => { value.accepted = adopt(value.fresh, value.onTransition); } },
        failed: { deliver: failed },
        navigate: { deliver: value => { value.navigation = navigate(value.target); } },
      },
    });
  function withdrawCapabilities(current) {
    if (!current()) return false;
    const previous = config(), names = Object.keys(previous?.capabilities ?? {});
    if (ready.value && names.some(name => previous.capabilities[name] === true)) {
      setConfig({ ...previous, capabilities: Object.fromEntries(names.map(name => [name, false])) });
    }
    return current();
  }
  function retire({ preserveSignIn = false, onTransition = () => {}, closing = false, withdraw = false } = {}) {
    if (context.disposed && !closing) return false;
    const current = closing ? () => true : context.advanceProjection();
    onTransition(current);
    if (!preserveSignIn) cancelSignIn();
    const release = releaseRecovery; releaseRecovery = null;
    loginProof = null;
    valid.value = false;
    // Every external callback may replace the credential or projection.
    if (!current()) return false;
    release?.(); if (!current()) return false;
    stopRuntime(); if (!current()) return false;
    setChangesSession(null); if (!current()) return false;
    setBrowseSession(null); if (!current()) return false;
    clearBrowseData(); if (!current()) return false;
    // Retiring live operations does not replace the retained document's config.
    // Only authority loss or sign-out withdraws its published capabilities.
    return withdraw ? withdrawCapabilities(current) : current();
  }
  function adopt(fresh, onTransition = () => {}) {
    if (unavailable()) return false;
    if (!fresh?.capabilities || !fresh.principal || !fresh.sessionGeneration) throw new Error("Invalid identity projection.");
    const account = fresh.principal.kind === "account" ? fresh.accountId ?? fresh.principal.id : null;
    if (documentAccount !== null && account !== null && account !== documentAccount) {
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
    if (changed && !retire({ preserveSignIn: matchesSignIn(fresh), onTransition: current => { adopting = current; onTransition(current); } })) return false;
    if (acceptedSignIn && !matchesSignIn(fresh)) cancelSignIn();
    setConfig(fresh); if (!adopting()) return false;
    valid.value = true; if (!adopting()) return false;
    ready.value = true; if (!adopting()) return false;
    // Guest recovery retires the live principal, not this document's named owner.
    if (account !== null) documentAccount = account;
    if (fresh.capabilities.canRead) {
      applyBrand(fresh.brand); if (!adopting()) return false;
      if (changed) {
        setBrowseSession(key()); if (!adopting()) return false;
        startRuntime(key()); if (!adopting()) return false;
        setChangesSession(key()); if (!adopting()) return false;
        refreshNotes();
      }
    }
    if (adopting()) completeSignIn();
    return adopting();
  }
  function retainAndRetire(current, options) {
    retainUnsavedWork();
    return current() && retire({ ...options, withdraw: true });
  }
  function beginRecovery() {
    if (!recover || releaseRecovery || context.disposed) return;
    if (valid.value && !retainAndRetire(capture(), { preserveSignIn: true })) return;
    const current = context.captureTransition();
    // Reserve before an injected reconnect owner can immediately revalidate.
    const slot = { release: null }; releaseRecovery = () => slot.release?.();
    const release = recover({ current, async revalidate(signal) {
      if (await refresh({ recovery: true, signal })) return "accepted";
      return current() ? "retry" : "retired";
    } });
    if (current() && releaseRecovery) slot.release = release;
    else release();
  }
  async function refresh({ accepted = false, recovery = false, signal } = {}) {
    if (unavailable()) return false;
    latestRead = {};
    const current = context.captureTransition().bind(() => latestRead);
    const owner = attempt, operation = owner.operation("recovery", current);
    let failureCurrent = current;
    try {
      const response = await owner.dispatch(operation, { kind: "config", options: { signal } });
      const receipt = { fresh: response.value, onTransition: next => { failureCurrent = next.bind(() => latestRead); } };
      if (!owner.deliver(operation, "config", receipt) || !receipt.accepted) return false;
      return accepted ? Object.freeze({ current: capture(), principal: Object.freeze({ ...receipt.fresh.principal }) }) : true;
    } catch (error) {
      if (!failureCurrent()) return false;
      const status = error.response?.status ?? error.status;
      if (status === 401 || recovery && status === 403) {
        if (!retainAndRetire(failureCurrent)) return false;
        if (!credentialHandoff?.current() && status === 401) {
          const completing = context.captureTransition();
          if (retainedWork()) { if (completing()) reauthenticate(); }
          else {
            if (!completing()) return false;
            ready.value = true;
            if (currentRoute()?.name !== "login") owner.deliver(operation, "navigate", { target: { name: "login" } }, completing);
          }
        }
        return false;
      }
      // A loaded outage retires disclosure, not the initial-load error screen.
      // Logout/recovery already retired it; do not invalidate that original
      // completion merely because its anonymous revalidation is unavailable.
      if (ready.value) {
        if (valid.value ? !retainAndRetire(failureCurrent, { preserveSignIn: true }) : !withdrawCapabilities(failureCurrent)) return false;
        const recovering = context.captureTransition();
        if (!recovery) { outage(error); if (recovering()) beginRecovery(); }
      }
      else owner.deliver(operation, "failed", error, failureCurrent);
      if (recovery) throw error;
      if (!releaseRecovery) cancelSignIn();
      return false;
    } finally { await owner.release(operation); }
  }
  async function beforeSignIn() {
    if (unavailable()) return false;
    // A named account can obtain new proof without asking the old editor to
    // save/discard; its actual account id is verified by the config response.
    if (documentAccount !== null && config().principal?.kind === "account") return true;
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
  function signIn(token, { persist = false, login } = {}) {
    if (unavailable() || token !== tokens.getStoredToken() && !acceptToken(token, persist)) return Promise.resolve(null);
    cancelSignIn();
    let resolve;
    const accepted = new Promise(done => { resolve = done; });
    const own = { current: captureCredential(), login: login.trim().toLowerCase(), resolve, accepted: null };
    acceptedSignIn = own;
    const operation = attempt.operation("recovery");
    const pending = attempt.dispatch(operation, { kind: "accepted-sign-in", accepted })
      .then(handle => handle.value).finally(() => attempt.release(operation));
    void refresh();
    return pending;
  }
  function authorityChanged(error, originating = capture()) {
    if (!originating()) return Promise.resolve(false);
    if (credentialHandoff?.current()) { credentialHandoff.deferred = true; return Promise.resolve(false); }
    if (authorityRead?.current()) return authorityRead.pending;
    retainUnsavedWork();
    if (!originating()) return Promise.resolve(false);
    if ((error?.response?.status ?? error?.status) !== 403 && !retire({ preserveSignIn: !error, withdraw: true })) return Promise.resolve(false);
    const read = { current: capture() };
    authorityRead = read;
    read.pending = refresh().finally(() => { if (authorityRead === read) authorityRead = null; });
    return read.pending;
  }
  function beginCredentialHandoff() {
    const handoff = credentialHandoff?.current() ? credentialHandoff : { current: captureCredential(), count: 0, deferred: false };
    credentialHandoff = handoff; handoff.count++;
    let ended = false;
    return () => {
      if (ended) return; ended = true;
      if (--handoff.count || credentialHandoff !== handoff) return;
      credentialHandoff = null;
      if (handoff.deferred && handoff.current()) void authorityChanged();
    };
  }
  function logout() {
    if (unavailable()) return Promise.resolve(false);
    if (transitionPending?.current()) return transitionPending.pending;
    const current = capture(), owner = attempt, operation = owner.operation("retained", current);
    const transition = { current };
    transitionPending = transition;
    transition.pending = Promise.resolve().then(async () => {
      try {
        const decision = await owner.dispatch(operation, "logout");
        if (decision.value !== "proceed" || !current() || !retire({ withdraw: true })) return false;
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
  return Object.freeze({ state: readonly(reactive({ ready, valid, reloadRequired })), key, capture, captureCredential,
    load: refresh, refresh, acceptProjection: () => refresh({ accepted: true }), adopt, invalidate: () => !unavailable() && retire({ withdraw: true }), beforeSignIn, acceptToken, signIn, logout, transport: io, tokens,
    authorityChanged, beginCredentialHandoff,
    isDisposed: () => context.disposed,
    hasWork: () => attempt.hasWork(), settle: () => attempt.settle(),
    snapshot: () => config(),
    retainLoginProof(proof, accepted) {
      if (!context.disposed && key() != null && (!accepted || accepted.current())) loginProof = { proof: { username: proof.username, password: proof.password }, current: capture() };
    },
    consumeLoginProof() {
      const proof = loginProof; loginProof = null;
      return proof?.current() ? proof.proof : null;
    },
    dispose() { if (!context.disposed) { stopSharedSignIn?.(); context.dispose(); retire({ closing: true }); } return attempt.dispose(); },
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
