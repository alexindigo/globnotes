// SPDX-License-Identifier: LGPL-3.0-only

/** Browser plugin runtime — app-level contributions start after
 * config/auth readiness, not when the editor mounts. Vault enablement is
 * the only authority (old per-browser switches remain legacy preferences,
 * never activation sources). Activation is generation-scoped: re-enable
 * and catalog invalidations reload modules via generation-aware URLs; an
 * imported module cannot be unimported, so every generation owns and
 * disposes its resources. */

import { readonly, ref } from "vue";

import { getPluginHostCatalog, openPluginHostEvents } from "./api.js";
import { removeCommandOwner } from "./commands.js";
import { createPluginSdk } from "./pluginSdk.js";
import { getStoredToken } from "./tokenStorage.js";

const pathPrefix = document.querySelector('meta[name="globnotes-prefix"]')?.content || "";

/** Internal injectable owner; the application uses the singleton below. */
export function createPluginRuntime({
  readCatalog = getPluginHostCatalog,
  openEvents = openPluginHostEvents,
  importModule = url => import(/* @vite-ignore */ url),
  createSdk = createPluginSdk,
  removeOwner = removeCommandOwner,
  getSession = () => getStoredToken() ?? "anonymous",
  prefix = pathPrefix,
  report = (...args) => console.error(...args),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const catalog = ref(null), browserStatus = ref(new Map());
  const generations = new Map();
  let started = false, requested = false, documentActive = true;
  let epoch = 0, readTicket = 0, publicationSerial = 0, policyFloor = 0;
  let sessionKey = "default", activeCredential;
  let closeEvents = null, reconnectTimer = null, eventController = null;

  const active = scope => started && documentActive && scope.epoch === epoch &&
    scope.sessionKey === sessionKey && scope.credential === activeCredential && scope.credential === getSession();
  const capture = () => ({ epoch, sessionKey, credential: activeCredential });
  const publicationCurrent = scope => active(scope) && scope.serial === publicationSerial;
  const desired = id => catalog.value?.plugins.some(plugin => plugin.id === id && plugin.enabled && plugin.runtime?.client);
  const publishStatus = () => {
    browserStatus.value = new Map([...generations].map(([id, entry]) => [id, { generation: entry.generation, status: entry.ready ? "ready" : "starting" }]));
  };

  function ownFactory(id, entry, scope) {
    return disposer => {
      let owned = true;
      const release = () => {
        if (!owned) return;
        owned = false;
        entry.disposers.delete(release);
        return disposer();
      };
      if (!active(scope) || entry.retired || generations.get(id) !== entry) throw new Error("plugin generation is obsolete");
      entry.disposers.add(release);
      return release;
    };
  }

  async function activatePlugin(plugin, scope) {
    const generation = crypto.randomUUID(), entry = { generation, disposers: new Set(), ready: false, activated: false, retired: false };
    generations.set(plugin.id, entry);
    const sdk = createSdk({ pluginId: plugin.id, snapshot: {
      pluginId: plugin.id, version: plugin.version, contractVersion: catalog.value?.contractVersion ?? 1,
    }, own: ownFactory(plugin.id, entry, scope), assertActive: () => {
      if (!active(scope) || entry.retired || generations.get(plugin.id) !== entry) throw new Error("plugin generation is obsolete");
    } });
    try {
      const url = `${prefix}/_/plugins/${encodeURIComponent(plugin.id)}/app.js?v=${generation}`;
      const mod = await importModule(url);
      if (!active(scope) || generations.get(plugin.id) !== entry || !desired(plugin.id)) return;
      if (typeof mod.activate !== "function") throw new Error("runtime.client entry requires activate(ctx)");
      await mod.activate(sdk);
      if (!active(scope) || generations.get(plugin.id) !== entry || !desired(plugin.id)) return;
      entry.activated = true;
      entry.ready = (catalog.value?.policy?.revision ?? 0) >= policyFloor;
      publishStatus();
    } catch (error) {
      report(`plugin '${plugin.id}' browser runtime failed`, error);
      disposeEntry(plugin.id, entry);
    }
  }

  function disposeEntry(id, entry) {
    if (!entry || entry.retired) return;
    entry.retired = true;
    if (generations.get(id) === entry) {
      generations.delete(id);
      removeOwner(id);
    }
    for (const release of [...entry.disposers].reverse()) {
      try { release(); } catch (error) { report(`plugin '${id}' disposal failed`, error); }
    }
    entry.disposers.clear();
    publishStatus();
  }

  async function reconcile(accepted, scope) {
    if (!publicationCurrent(scope)) return;
    const wanted = new Map(accepted.plugins.filter(plugin => plugin.enabled && plugin.runtime?.client).map(plugin => [plugin.id, plugin]));
    for (const id of [...generations.keys()]) {
      if (!publicationCurrent(scope)) return;
      if (!wanted.has(id)) disposeEntry(id, generations.get(id));
    }
    for (const plugin of wanted.values()) {
      if (!publicationCurrent(scope)) return;
      if (!generations.has(plugin.id)) await activatePlugin(plugin, scope);
      else generations.get(plugin.id).ready = generations.get(plugin.id).activated;
    }
    if (publicationCurrent(scope)) publishStatus();
  }

  /** The sole catalogue publisher; callers receive explicit read ownership. */
  async function refresh() {
    if (!started || !documentActive) return { status: "inactive" };
    const scope = { ...capture(), ticket: ++readTicket };
    const currentRead = () => active(scope) && scope.ticket === readTicket;
    let fresh;
    try { fresh = await readCatalog(); }
    catch (error) {
      if (!currentRead()) return { status: "superseded" };
      if ((error.response?.status ?? error.status) === 401) stop();
      return { status: "error", detail: error.response?.data?.detail ?? error.message ?? "Catalogue read failed." };
    }
    if (!currentRead()) return { status: "superseded" };
    if (!fresh || !Array.isArray(fresh.plugins)) return { status: "error", detail: "Invalid catalogue response." };
    const revision = fresh.policy?.revision ?? 0;
    if (revision < Math.max(policyFloor, catalog.value?.policy?.revision ?? 0)) return { status: "superseded" };
    catalog.value = structuredClone(fresh);
    const published = { ...capture(), serial: ++publicationSerial };
    const accepted = catalog.value;
    await reconcile(accepted, published);
    if (!publicationCurrent(published)) return { status: "superseded" };
    return { status: "accepted", catalog: readonly(accepted), serial: published.serial };
  }

  function captureOwnership() {
    const scope = capture();
    return Object.freeze({ current: () => active(scope) });
  }
  function acknowledgePolicy(policy, owner) {
    if (!owner?.current() || !Number.isSafeInteger(policy?.revision) || policy.revision < 0) return false;
    if (policy.revision > policyFloor) publicationSerial++;
    policyFloor = Math.max(policyFloor, policy.revision);
    readTicket++;
    return true;
  }

  async function connectEvents() {
    if (!started || !documentActive) return;
    const scope = capture();
    eventController?.abort();
    eventController = new AbortController();
    const controller = eventController;
    closeEvents?.(); closeEvents = null;
    const currentStream = () => active(scope) && eventController === controller && !controller.signal.aborted;
    try {
      const admitted = await openEvents({ signal: controller.signal,
        onEvent: ({ event }) => { if (currentStream() && ["invalidate", "hello"].includes(event)) refresh(); },
        onClose: () => {
          if (!currentStream()) return;
          clearTimer(reconnectTimer);
          reconnectTimer = setTimer(() => { if (currentStream()) refresh().then(() => { if (currentStream()) connectEvents(); }); }, 2000);
        },
      });
      if (!currentStream()) admitted();
      else closeEvents = admitted;
    } catch (error) {
      if (!currentStream()) return;
      if ((error.response?.status ?? error.status) === 401) { stop(); return; }
      clearTimer(reconnectTimer);
      reconnectTimer = setTimer(() => { if (currentStream()) connectEvents(); }, 5000);
    }
  }

  function halt() {
    started = false; epoch++; readTicket++; publicationSerial++; policyFloor = 0;
    clearTimer(reconnectTimer);
    eventController?.abort(); eventController = null;
    closeEvents?.(); closeEvents = null;
    for (const [id, entry] of [...generations]) disposeEntry(id, entry);
    catalog.value = null;
  }
  async function start(nextSession = sessionKey) {
    requested = true;
    if (nextSession !== sessionKey || (started && activeCredential !== getSession())) halt();
    sessionKey = nextSession;
    if (!documentActive) return { status: "inactive" };
    if (started) return { status: "accepted", catalog: readonly(catalog.value), serial: publicationSerial };
    started = true; epoch++; activeCredential = getSession();
    const scope = capture(), receipt = await refresh();
    if (active(scope)) await connectEvents();
    return receipt;
  }
  function stop() { requested = false; halt(); }
  function suspendDocument() { documentActive = false; halt(); }
  function resumeDocument() { documentActive = true; if (requested) return start(); return Promise.resolve({ status: "inactive" }); }

  return Object.freeze({ catalog: readonly(catalog), browserGenerations: readonly(browserStatus), start, stop, refresh,
    captureOwnership, acknowledgePolicy, suspendDocument, resumeDocument });
}

const runtime = createPluginRuntime();
/** Read-only reactive projections; only refresh publishes authoritative data. */
export const pluginCatalog = runtime.catalog;
export const browserGenerations = runtime.browserGenerations;
export const startPluginRuntime = session => runtime.start(session);
export const stopPluginRuntime = () => runtime.stop();
export const refreshPluginRuntimeCatalog = () => runtime.refresh();
export const capturePluginCatalogOwnership = () => runtime.captureOwnership();
export const acknowledgePluginPolicy = (policy, owner) => runtime.acknowledgePolicy(policy, owner);
window.addEventListener("pagehide", () => runtime.suspendDocument());
window.addEventListener("pageshow", () => runtime.resumeDocument());
