// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly, ref, watch } from "vue";
import {
  getConfig, postBrand, getTree, putPluginEnabled, putPluginPolicy,
  getPluginPermissions, putPluginPermissions, getPluginPermissionRequests,
  decidePluginPermissionRequest,
} from "./api.js";
import { authTypes } from "./constants.js";
import { createCoreSettingsAdapters } from "./coreSettingsAdapters.js";
import { createPluginInventoryController } from "./pluginInventoryController.js";
import { createPluginPermissionController, permissionScopeKey } from "./pluginPermissionController.js";
import {
  pluginCatalog, refreshPluginRuntimeCatalog, capturePluginCatalogOwnership,
  acknowledgePluginPolicy,
} from "./pluginRuntime.js";
import { registerSessionParticipant } from "./sessionActions.js";
import { createSettingsPageState } from "./settingsPageState.js";
import { commitPluginPage, findPage, readPluginPage, settingsPages } from "./settingsRegistry.js";
import { getStoredToken } from "./tokenStorage.js";

const defaultRegistry = {
  find: findPage,
  read: page => page.owner === "core" ? Promise.resolve({ values: {}, revision: 0 }) : readPluginPage(page.owner, page.pageId),
  commit: (page, values, revision, sourceKey) => commitPluginPage(page.owner, page.pageId, values, revision, sourceKey),
};

/** Retained Settings workflow. The view supplies visibility/focus and app outputs;
 * this owner composes controllers, decisions, handoffs and host path reads. */
export function createSettingsSession({
  config, applyBrand, writable, isVisible, setVisible, focus,
  openAccess: notifyOpenAccess,
  permissionController,
  catalog = pluginCatalog, pages = settingsPages, registry = defaultRegistry,
  refreshCatalog: refreshRuntimeCatalog = refreshPluginRuntimeCatalog, token = getStoredToken,
  readPaths = getTree, clock = globalThis,
  registerParticipant = registerSessionParticipant,
  createCore = createCoreSettingsAdapters, createPages = createSettingsPageState,
  createInventory = createPluginInventoryController, createPermissions = createPluginPermissionController,
}) {
  const core = createCore({ getBrand: () => config().brand, writable, writeBrand: postBrand,
    readBrand: async () => (await getConfig()).brand, applyBrand });
  const brandingSnapshot = computed(() => core.brandSnapshot()), keybindingSnapshot = computed(() => core.keybindings());
  const canLogout = computed(() => [authTypes.password, authTypes.totp].includes(config().authType));
  const currentPageId = ref("core:appearance");
  const ownsPermissions = !permissionController;
  const permissions = permissionController ?? createPermissions({ readView: getPluginPermissions, writeView: putPluginPermissions,
    readPending: getPluginPermissionRequests, decideRequest: decidePluginPermissionRequest, changed: refreshCatalog });
  if (ownsPermissions) permissions.setSession("settings", { active: true, canWrite: writable() });
  const reviewPluginId = ref(null), riskVisible = ref(false), riskTitle = ref(""), riskMessage = ref("");
  const riskConfirmText = ref("Confirm permission change"), riskConfirmStyle = ref("cta");
  const pathChoice = ref(null), pathEntries = ref([]), pathChoiceError = ref("");
  let pathTicket = 0, riskResolve = null;
  const reviewSnapshot = computed(() => reviewPluginId.value ? permissions.snapshot(reviewPluginId.value) : null);
  const departureVisible = ref(false), departureMessage = ref(""), departureCanSave = ref(false);
  let departureRequest = null, departureResolve = null;

  function askDeparture({ reason, pages, canSave }) {
    if (departureRequest) return departureRequest;
    departureCanSave.value = canSave;
    departureMessage.value = `Resolve your settings edits before ${reason}. ${pages.map(page => page.page.label).join(", ")}. Invalid or unavailable drafts must be kept or explicitly discarded.`;
    departureVisible.value = true;
    departureRequest = new Promise(resolve => { departureResolve = resolve; }).finally(() => { departureRequest = null; });
    return departureRequest;
  }
  function decideDeparture(decision) {
    departureVisible.value = false;
    departureResolve?.(decision);
    departureResolve = null;
  }
  const pageState = createPages({ registry, confirm: askDeparture });
  const inventory = createInventory({
    getCatalog: () => catalog.value,
    getSession: () => `${config().authType}:${token() ?? 'anonymous'}`,
    writable,
    captureOwner: capturePluginCatalogOwnership, acknowledge: acknowledgePluginPolicy,
    writeEnabled: putPluginEnabled, writePolicy: putPluginPolicy, refreshCatalog,
    prepareDisable: async id => await pageState.resolveDeparture(pageState.pageIds().filter(pageId => pageState.snapshot(pageId).page.owner === id), "disabling plugin") && await resolvePermissionDeparture([id], "disabling plugin"),
    confirm: askDeparture,
  });
  const inventorySnapshot = computed(() => inventory.snapshot());
  const participant = {
    hasUnsavedChanges: () => inventory.hasWork() || pageState.hasWork() || permissions.hasWork() || core.hasWork(),
    settlePending: async () => await inventory.settle() && await pageState.settle() && await permissions.settle() && await core.settle(),
    requestDecision: reason => {
      const pages = pageState.pageIds().map(pageState.snapshot).filter(page => page.dirty || page.pending);
      const permissionPages = permissions.recoveryIds().map(id => ({ page: { label: `Server permissions: ${id}` }, canSave: !!permissions.snapshot(id).draft }));
      const corePages = core.hasWork() ? [{ page: { label: 'Branding' }, canSave: writable() }] : [];
      const inventoryPages = inventory.hasWork() ? [{ page: { label: inventory.snapshot().label }, canSave: inventory.snapshot().canRetry }] : [];
      const all = [...pages, ...permissionPages, ...corePages, ...inventoryPages];
      return askDeparture({ reason, pages: all, canSave: all.every(page => page.canSave) });
    },
    save: async () => await inventory.resolveDeparture("session handoff", "save") && await pageState.resolveDeparture(pageState.pageIds(), "session handoff", "save") && await resolvePermissionDeparture(permissions.recoveryIds(), "session handoff", "save") && await resolveCoreDeparture('session handoff', 'save'),
    discard: async () => await inventory.resolveDeparture("session handoff", "discard") && await pageState.resolveDeparture(pageState.pageIds(), "session handoff", "discard") && await resolvePermissionDeparture(permissions.recoveryIds(), "session handoff", "discard") && await resolveCoreDeparture('session handoff', 'discard'),
  };
  const disposeParticipant = registerParticipant("settings", participant);
  const pluginError = ref({});
  const groupedPages = computed(() => {
    const groups = new Map();
    const available = new Map([...pages.value, ...pageState.recoveryPages()].map(page => [page.id, page]));
    for (const page of available.values()) {
      if (!groups.has(page.group)) groups.set(page.group, []);
      groups.get(page.group).push(page);
    }
    return [...groups.entries()].map(([name, pages]) => ({ name, pages }));
  });
  const currentSnapshot = computed(() => ({ ...pageState.snapshot(currentPageId.value), writable: writable() }));
  const currentPage = computed(() => currentSnapshot.value.page);
  const permissionSnapshot = computed(() => currentPage.value?.permissionPluginId ? permissions.snapshot(currentPage.value.permissionPluginId) : null);
  const catalogPlugins = computed(() => catalog.value?.plugins ?? []);
  const catalogPolicy = computed(() => catalog.value?.policy ?? null);

  async function refreshCatalog() {
    return await refreshRuntimeCatalog();
  }
  async function togglePlugin(plugin, enabled) {
    return await inventory.setEnabled(plugin.id, enabled, catalogPolicy.value);
  }
  async function toggleAutoEnable() {
    return await inventory.setAutoEnable(!catalogPolicy.value.effectiveAutoEnable, catalogPolicy.value);
  }
  async function discardInventoryChoice() {
    if (!inventory.snapshot().canDiscard) return false;
    if (!await askRisk("Resolve inventory choice", "Discard this retained local policy choice? This does not undo a committed request. A later enabled:true operation is a fresh request and may rebuild plugin owners.")) return false;
    return inventory.discard();
  }
  const stopPages = watch(pages, () => pageState.reconcile());
  const stopCatalog = watch([catalog, writable], () => {
    if (ownsPermissions) permissions.setSession("settings", { active: true, canWrite: writable() });
    permissions.reconcile(catalog.value);
  }, { immediate: true });

  /** Open/focus stays idempotent; the component owns its actual DOM focus. */
  async function openSettings(page) {
    if (page && registry.find(page) && !await selectPage(page)) return;
    if (isVisible()) { focus(); return; }
    setVisible(true);
    if (currentPage.value?.owner !== "core") await pageState.load(currentPageId.value);
  }
  async function selectPage(id) {
    if (id !== currentPageId.value && !await inventory.resolveDeparture("changing pages")) return false;
    if (id !== currentPageId.value && !await pageState.resolveDeparture([currentPageId.value], "changing pages")) return false;
    if (id !== currentPageId.value && currentPage.value?.permissionPluginId && !await resolvePermissionDeparture([currentPage.value.permissionPluginId], "changing pages")) return false;
    if (id !== currentPageId.value && !await resolveCoreDeparture('changing pages')) return false;
    core.stopCapture(); closePathChoice();
    currentPageId.value = id;
    if (id === 'core:branding') core.loadBrand();
    if (currentPage.value?.permissionPluginId) await permissions.load(currentPage.value.permissionPluginId);
    if (currentPage.value?.owner !== "core") await pageState.load(id);
    return true;
  }
  /** Close keeps pending/invalid drafts unless explicitly resolved. */
  async function requestClose() {
    if (!await inventory.resolveDeparture("closing Settings")) return false;
    if (!await pageState.resolveDeparture(pageState.pageIds(), "closing Settings")) return false;
    if (!await resolvePermissionDeparture(permissions.recoveryIds(), "closing Settings")) return false;
    if (!await resolveCoreDeparture('closing Settings')) return false;
    core.stopCapture(); closePathChoice();
    setVisible(false);
    return true;
  }
  async function reloadCurrentPage() {
    if (!await pageState.resolveDeparture([currentPageId.value], "reloading")) return;
    await pageState.load(currentPageId.value);
  }
  function askRisk(title, message, confirmText = 'Confirm permission change', confirmStyle = 'cta') {
    if (riskResolve) return Promise.resolve(false);
    riskTitle.value = title; riskMessage.value = message; riskConfirmText.value = confirmText; riskConfirmStyle.value = confirmStyle; riskVisible.value = true;
    return new Promise(resolve => { riskResolve = resolve; });
  }
  function resolveRisk(value) { riskVisible.value = false; riskResolve?.(value); riskResolve = null; }
  async function approveScope(id, kind, scope) {
    const view = permissions.snapshot(id).view;
    if (scope.type === "all" && !await askRisk("Approve all hosts", `Approve all hosts and all ports for ${kind === 'imports' ? 'remote-code imports' : 'network data'} in ${id}? This broad grant is separate from Allow network.`)) return false;
    return permissions.approve(id, kind, scope, view);
  }
  async function deleteScope(id, kind, row) {
    const view = permissions.snapshot(id).view, coverage = row.approvalCoverage;
    if (coverage.some(scope => permissionScopeKey(scope) !== permissionScopeKey(row.scope)) && !await askRisk("Remove covering approvals", `Revoking this host requires deleting covering approvals: ${coverage.map(scope => scope.type === 'all' ? 'All hosts' : scope.authority).join(', ')}. Other hosts covered by those grants also lose access unless another approval covers them.`)) return false;
    return permissions.remove(id, kind, coverage, view);
  }
  async function discardPermission(id) {
    if (!await askRisk("Discard permission choice", `Discard retained unsaved permission choices for ${id}? This does not undo a committed server decision.`)) return false;
    return permissions.discard(id);
  }
  async function resolvePermissionDeparture(ids, reason, confirmedDecision) {
    if (ids.some(id => permissions.snapshot(id).busy) && !await permissions.settle()) return false;
    const changed = ids.filter(id => permissions.recoveryIds().includes(id));
    if (!changed.length) return true;
    const pages = changed.map(id => ({ page: { label: `Server permissions: ${id}` }, canSave: !!permissions.snapshot(id).draft }));
    const decision = confirmedDecision ?? await askDeparture({ reason, pages, canSave: pages.every(page => page.canSave) });
    if (decision === "discard") return changed.every(id => permissions.discard(id));
    if (decision === "save" || decision === "retry") {
      for (const id of changed) if (!await permissions.retry(id)) return false;
      return true;
    }
    return false;
  }
  async function openPermissionReview(id) { reviewPluginId.value = id; await permissions.load(id); }
  async function closePermissionReview() {
    const id = reviewPluginId.value;
    if (id && !await resolvePermissionDeparture([id], "closing permission review")) return false;
    reviewPluginId.value = null; return true;
  }
  async function resolveCoreDeparture(reason, confirmedDecision) {
    if (!core.hasWork()) return true;
    if (!await core.settle()) return false;
    const decision = confirmedDecision ?? await askDeparture({ reason, pages: [{ page: { label: 'Branding' }, canSave: writable() }], canSave: writable() });
    if (decision === 'discard') return core.discardBrand();
    if (decision === 'save' || decision === 'retry') return await core.saveBrand() && !core.hasWork();
    return false;
  }
  async function resetCoreBranding() { if (await askRisk('Reset branding?', core.resetMessage(), 'Reset', 'danger')) await core.saveBrand(true); }
  async function openAccess() { if (await requestClose()) notifyOpenAccess(); }
  function parentPath(path) { return path.split('/').slice(0, -1).join('/'); }
  function closePathChoice() { pathTicket++; pathChoice.value = null; pathEntries.value = []; return true; }
  async function browseField(id, field) {
    if (!writable() || !pageState.snapshot(id).available) return;
    pathChoice.value = { id, field, root: '' }; await loadPathChoices('');
  }
  async function loadPathChoices(root) {
    const choice = pathChoice.value; if (!choice) return; const ticket = ++pathTicket; pathChoiceError.value = '';
    let timer;
    try {
      const tree = await Promise.race([readPaths(root), new Promise((_, reject) => { timer = clock.setTimeout(() => reject(Error('Host path choices could not be loaded within the deadline.')), 5000); })]);
      const entries = tree.folders.map(entry => ({ path: entry.path, label: entry.name, directory: true }));
      if (choice.field.type === 'file') for (const note of tree.notes) entries.push({ path: `${note.path}.md`, label: `${note.title}.md`, directory: false });
      if (ticket === pathTicket && pathChoice.value === choice) { choice.root = root; pathEntries.value = entries.filter(entry => choice.field.type === 'file' || entry.directory); }
    } catch (error) { if (ticket === pathTicket) pathChoiceError.value = error.message; }
    finally { clock.clearTimeout(timer); }
  }
  function selectPath(path) {
    const choice = pathChoice.value; if (!choice) return;
    const snapshot = pageState.snapshot(choice.id);
    if (!writable() || !snapshot.available || snapshot.changedDescriptor) return;
    pageState.edit(choice.id, choice.field.key, path); pageState.commit(choice.id, choice.field.key); closePathChoice();
  }
  function dispose() {
    decideDeparture("cancel"); resolveRisk(false); closePathChoice(); disposeParticipant();
    inventory.dispose(); pageState.dispose(); core.dispose(); if (ownsPermissions) permissions.dispose();
    stopPages(); stopCatalog();
  }
  return {
    state: readonly(reactive({ brandingSnapshot, keybindingSnapshot, canLogout, currentPageId, reviewPluginId,
      riskVisible, riskTitle, riskMessage, riskConfirmText, riskConfirmStyle, pathChoice, pathEntries, pathChoiceError,
      reviewSnapshot, departureVisible, departureMessage, departureCanSave, inventorySnapshot, pluginError,
      groupedPages, currentSnapshot, currentPage, permissionSnapshot, catalogPlugins, catalogPolicy })),
    core, permissions, pageState, inventory,
    setRiskVisible: value => { riskVisible.value = value; },
    setDepartureVisible: value => { departureVisible.value = value; },
    openSettings, selectPage, requestClose, reloadCurrentPage, decideDeparture,
    togglePlugin, toggleAutoEnable, discardInventoryChoice,
    approveScope, deleteScope, discardPermission, openPermissionReview, closePermissionReview, resolveRisk,
    resetCoreBranding, openAccess, parentPath, closePathChoice, browseField, loadPathChoices, selectPath, dispose,
  };
}
