// SPDX-License-Identifier: LGPL-3.0-only
import { reactive, readonly, ref } from "vue";
import { apiErrorHandler, getConfig } from "./api.js";
import { applyBrandToDocument } from "./brand.js";
import { authTypes } from "./constants.js";
import { getToastOptions } from "./helpers.js";
import { refreshNoteIndex } from "./noteIndex.js";
import { refreshPluginRuntimeCatalog, stopPluginRuntime } from "./pluginRuntime.js";
import { resolveParticipants } from "./sessionActions.js";
import { clearStoredToken } from "./tokenStorage.js";

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
