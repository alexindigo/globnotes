// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly, ref, watch } from "vue";
import {
  getConfig, getAccessSettings, postBrand, getTree, putPluginEnabled, putPluginPolicy,
  getPluginPermissions, putPluginPermissions, getPluginPermissionRequests,
  decidePluginPermissionRequest,
} from "./api.js";
import { authTypes } from "./constants.js";
import { createCoreSettingsAdapters } from "./coreSettingsAdapters.js";
import { createPluginInventoryController } from "./pluginInventoryController.js";
import { createPluginPermissionController, permissionScopeKey, permissionAttentionId } from "./pluginPermissionController.js";
import {
  pluginCatalog, refreshPluginRuntimeCatalog, capturePluginCatalogOwnership,
  acknowledgePluginPolicy,
} from "./pluginRuntime.js";
import { registerSessionParticipant } from "./sessionActions.js";
import { createSettingsPageState } from "./settingsPageState.js";
import { commitPluginPage, findPage, isPluginSettingsPage, readPluginPage, settingsPages, settingsNavigation } from "./settingsRegistry.js";
import { getStoredToken } from "./tokenStorage.js";
import { permissionSessionKey } from "./appSessionPolicy.js";
import { formatVersion } from "../shared/version.ts";
import { createAccessSettingsState } from "./accessSettingsState.js";
import { attention } from './attention.js';

const defaultRegistry = {
  find: findPage,
  read: page => isPluginSettingsPage(page) ? readPluginPage(page.owner, page.pageId) : Promise.resolve({ values: {}, revision: 0 }),
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
  readPaths = getTree, readAccess = getAccessSettings, clock = globalThis, attentionRegistry = attention,
  registerParticipant = registerSessionParticipant,
  createCore = createCoreSettingsAdapters, createPages = createSettingsPageState,
  createInventory = createPluginInventoryController, createPermissions = createPluginPermissionController,
}) {
  const core = createCore({ getBrand: () => config().brand, writable, writeBrand: postBrand,
    readBrand: async () => (await getConfig()).brand, applyBrand });
  const brandingSnapshot = computed(() => core.brandSnapshot()), keybindingSnapshot = computed(() => core.keybindings());
  const appearanceSnapshot = computed(() => core.appearance());
  const access = createAccessSettingsState({ read:readAccess, readStatus:getConfig, completed:()=>{} });
  const accessSummary = computed(() => ({ loading:access.state.loading, error:access.state.error,
    rows:access.state.view ? [
      {label:'Access mode',value:{password:'Password protected',none:'Open access',read_only:'Read-only'}[access.state.view.mode]},
      {label:'Sign-in',value:access.state.view.mode === 'password' ? access.state.view.totpEnabled ? 'Password and authenticator' : 'Username and password' : 'Not required'},
      {label:'Settings lock',value:access.state.view.settingsWritable ? 'Unlocked' : 'Locked'},
    ] : [] }));
  const accountName = computed(() => access.state.view?.username || '');
  const accountSummary = computed(() => ({text:canLogout.value
    ? accountName.value ? `Signed in as ${accountName.value}` : access.state.loading ? 'Reading current account…' : 'This session is signed in.'
    : 'This session has no account.'}));
  const stopAccessSession = watch([()=>permissionSessionKey(config(),token()),()=>config().accessRevision],()=>{
    const refresh=(access.state.loading || isVisible()) && ['access','account'].includes(currentPage.value?.kind);
    access.invalidate();
    if(refresh)void access.load();
  },{flush:'sync'});
  // Recheck at the intent boundary too: browser token storage is not reactive.
  async function loadAccessSummary(){access.invalidate();return await access.load();}
  const attentionItems = attentionRegistry.items;
  const canLogout = computed(() => [authTypes.password, authTypes.totp].includes(config().authType));
  const versionLabel = computed(() => formatVersion({ version: config()?.version, revision: config()?.revision }));
  const currentPageId = ref("core:appearance");
  const expandedPluginId = ref(null), capturedPlugins=new Map();
  const ownsPermissions = !permissionController;
  const permissions = permissionController ?? createPermissions({ readView: getPluginPermissions, writeView: putPluginPermissions,
    readPending: getPluginPermissionRequests, decideRequest: decidePluginPermissionRequest, changed: refreshCatalog });
  if (ownsPermissions) permissions.setSession("settings", { active: true, canWrite: writable() });
  const riskVisible = ref(false), riskTitle = ref(""), riskMessage = ref("");
  const riskConfirmText = ref(""), riskConfirmStyle = ref("cta");
  const pathChoice = ref(null), pathEntries = ref([]), pathChoiceError = ref(""), pathLoading = ref(false);
  const pathChoiceView = computed(() => {
    const choice=pathChoice.value;if(!choice)return null;
    const snapshot=pageState.snapshot(choice.id);
    return {...choice,canSelect:!pathLoading.value && !pathChoiceError.value && writable() && snapshot.available && !snapshot.changedDescriptor};
  });
  const pathCrumbs = computed(() => [{label:'Vault',path:''}, ...(pathChoice.value?.root.split('/').filter(Boolean).map((label,index,parts)=>({label,path:parts.slice(0,index+1).join('/')})) ?? [])]);
  let pathTicket = 0, riskResolve = null;
  const departureVisible = ref(false), departureMessage = ref(""), departureCanSave = ref(false), departureConfirmText = ref('Save');
  let departureRequest = null, departureResolve = null;

  function askDeparture({ reason, pages, canSave }) {
    if (departureRequest) return departureRequest;
    departureCanSave.value = canSave;
    departureConfirmText.value = pages.some(page => page.uncertain || page.status === 'error') || core.brandSnapshot().canRetry || inventory.snapshot().unknown ? 'Retry' : 'Save';
    departureMessage.value = `Unsaved changes on ${pages.map(page => page.page.label).join(", ")}. Save your changes before ${reason}, or keep editing. Invalid or unavailable drafts must be kept or explicitly discarded.`;
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
    getSession: () => permissionSessionKey(config(), token()),
    writable,
    captureOwner: capturePluginCatalogOwnership, acknowledge: acknowledgePluginPolicy,
    writeEnabled: putPluginEnabled, writePolicy: putPluginPolicy, refreshCatalog,
    prepareDisable: async id => await pageState.resolveDeparture(pageState.pageIds().filter(pageId => pageState.snapshot(pageId).page.owner === id), "disabling plugin") && await resolvePermissionDeparture([id], "disabling plugin"),
    confirm: request=>askDeparture({...request,pages:request.pages.map(page=>({...page,page:{...page.page,label:'Plugins'}}))}),
  });
  const inventorySnapshot = computed(() => inventory.snapshot());
  const participant = {
    hasUnsavedChanges: () => inventory.hasWork() || pageState.hasWork() || permissions.hasWork() || core.hasWork(),
    settlePending: async () => await inventory.settle() && await pageState.settle() && await permissions.settle() && await core.settle(),
    requestDecision: reason => {
      const pages = pageState.pageIds().map(id => pageState.snapshot(id)).filter(page => page.dirty || page.pending);
      const permissionPages = permissions.recoveryIds().map(id => ({ page: { label: `Permissions for ${pluginName(id)}` }, canSave: !!permissions.snapshot(id).draft }));
      const corePages = core.hasWork() ? [{ page: { label: 'Branding' }, canSave: writable() }] : [];
      const inventoryPages = inventory.hasWork() ? [{ page: { label: 'Plugins' }, canSave: inventory.snapshot().canRetry }] : [];
      const all = [...pages, ...permissionPages, ...corePages, ...inventoryPages];
      return askDeparture({ reason, pages: all, canSave: all.every(page => page.canSave) });
    },
    save: async () => await inventory.resolveDeparture("session handoff", "save") && await pageState.resolveDeparture(pageState.pageIds(), "session handoff", "save") && await resolvePermissionDeparture(permissions.recoveryIds(), "session handoff", "save") && await resolveCoreDeparture('session handoff', 'save'),
    discard: async () => await inventory.resolveDeparture("session handoff", "discard") && await pageState.resolveDeparture(pageState.pageIds(), "session handoff", "discard") && await resolvePermissionDeparture(permissions.recoveryIds(), "session handoff", "discard") && await resolveCoreDeparture('session handoff', 'discard'),
  };
  const disposeParticipant = registerParticipant("settings", participant);
  // Current registry order plus captured recovery definitions, normalized once
  // for both navigation consumers. Retained descriptors replace the same ID in
  // place; removed recovery IDs append without inventing new catalog plugins.
  const projectedPages = computed(() => {
    const retained = pageState.pageIds().map(id => pageState.snapshot(id))
      .filter(snapshot => snapshot.dirty || snapshot.pending || snapshot.uncertain || snapshot.changedDescriptor)
      .map(snapshot => snapshot.page);
    return [...new Map([...pages.value, ...retained].map(page => [page.id, page])).values()];
  });
  const inventoryPages = computed(() => {
    const byOwner = Object.create(null);
    for (const page of projectedPages.value) {
      if (!isPluginSettingsPage(page)) continue;
      (byOwner[page.owner] ??= []).push(page);
    }
    return byOwner;
  });
  const groupedPages = computed(() => settingsNavigation(projectedPages.value, currentPageId.value));
  const currentSnapshot = computed(() => ({ ...pageState.snapshot(currentPageId.value, writable()), writable: writable() }));
  const currentPage = computed(() => currentSnapshot.value.page);
  const currentPageIsPlugin = computed(() => isPluginSettingsPage(currentPage.value));
  const catalogPlugins = computed(() => catalog.value?.plugins ?? []);
  const catalogPolicy = computed(() => catalog.value?.policy ?? null);
  const pluginPageHeader = computed(() => ({ title:currentPage.value?.plugin?.name ?? currentPage.value?.owner,
    description:[...new Set([currentPage.value?.plugin?.description,currentPage.value?.descriptor?.description].filter(Boolean))].join(' '), pages:inventoryPages.value[currentPage.value?.owner] ?? [] }));
  function pluginName(id) {return catalogPlugins.value.find(plugin=>plugin.id===id)?.name ?? capturedPlugins.get(id)?.name ?? permissions.snapshot(id)?.plugin?.name ?? 'Unavailable plugin';}
  function policyRecovery() {
    const state = inventorySnapshot.value;
    return state.intent ? { text:state.error || 'Your policy choice is retained.', pendingText:state.unknown ? 'Waiting for the server to confirm…' : state.busy ? 'Saving plugin policy…' : '',
      canReview:state.canReview, canRetry:state.canRetry, canDiscard:state.canDiscard } : null;
  }
  const autoEnableView = computed(() => ({ value:catalogPolicy.value?.effectiveAutoEnable ?? true,
    canToggle:inventorySnapshot.value.canMutate && catalogPolicy.value?.autoEnableSource !== 'environment',
    note:catalogPolicy.value?.autoEnableSource === 'environment' ? 'Set by the server configuration' : '',
    recovery:inventorySnapshot.value.intent?.type === 'auto-enable' ? policyRecovery() : null }));
  const pluginRows = computed(() => {
    const plugins = new Map(catalogPlugins.value.map(plugin => [plugin.id, plugin]));
    // A removed owner with retained permission work must remain visible until
    // that work is explicitly resolved, just like retained plugin-page drafts.
    for (const id of permissions.recoveryIds()) if (!plugins.has(id)) {
      const captured = permissions.snapshot(id).plugin;
      plugins.set(id, { ...captured, id, name:captured?.name ?? id, enabled:false });
    }
    const intent=inventorySnapshot.value.intent;
    if(intent?.type==='enabled'&&!plugins.has(intent.id))plugins.set(intent.id,{...capturedPlugins.get(intent.id),id:intent.id,name:pluginName(intent.id),enabled:false});
    return [...plugins.values()].map(plugin => {
    const items=attentionItems.value.filter(item=>item.kind==='plugin-access-request'&&item.owner===plugin.id);
    const projected=permissions.permissionView(plugin.id);
    const requests=projected.requests.flatMap(request=>{const item=items.find(item=>item.id===permissionAttentionId(plugin.id,request.id));return item?[{...request,open:item.open,reviewLabel:`Review request: ${request.label}`}]:[];});
    const permission = {...projected,requests}, hasServer = permissions.snapshot(plugin.id).hasServer;
    const attention = [];
    const count = items.length;
    if (count) attention.push({ key:'requests', text:`${count} access request${count === 1 ? '' : 's'}`, tone:'quiet' });
    if (plugin.status === 'failed') attention.push({ key:'failure', text:`Failed: ${plugin.diagnostics?.[0]?.detail ?? 'runtime error'}`, tone:'danger' });
    if (plugin.blocking?.actions?.length) attention.push({ key:'blocking', text:`${plugin.blocking.active===false ? 'Can block when on' : 'Can block'}: ${plugin.blocking.actions.join(', ')}`, tone:'warning' });
    return { id:plugin.id, name:plugin.name ?? plugin.id, enabled:plugin.enabled, runsInBrowser:!!plugin.runsInBrowser, attention,
      canToggle:!!inventorySnapshot.value.canMutate && catalogPlugins.value.some(item => item.id === plugin.id),
      toggleNote:catalogPlugins.value.some(item => item.id === plugin.id) ? '' : 'Plugin unavailable. Your choices are retained.',
      hasServer, expanded:hasServer && expandedPluginId.value===plugin.id, openSettingsLabel:`Open ${plugin.name ?? plugin.id} settings`, pages:inventoryPages.value[plugin.id] ?? [], permission,
      recovery:inventorySnapshot.value.intent?.id === plugin.id ? policyRecovery() : null };
    });
  });

  async function refreshCatalog() {
    return await refreshRuntimeCatalog();
  }
  async function togglePlugin(plugin, enabled) {
    return await inventory.setEnabled(plugin.id, enabled, catalogPolicy.value);
  }
  const togglePluginRow = id => {
    const plugin = catalogPlugins.value.find(plugin => plugin.id === id);
    return plugin ? togglePlugin(plugin, !plugin.enabled) : false;
  };
  const toggleLineNumbers = () => core.saveViewLineNumbers(!core.viewLineNumbers.value);
  const toggleDebug = () => core.toggleDebug();
  async function toggleAutoEnable() {
    return await inventory.setAutoEnable(!catalogPolicy.value.effectiveAutoEnable, catalogPolicy.value);
  }
  async function discardInventoryChoice() {
    if (!inventory.snapshot().canDiscard) return false;
    if (!await askRisk("Discard choice?", "Discard this retained plugin choice? This does not undo a committed request. Turning a plugin on again is a new request.", 'Discard choice', 'danger')) return false;
    return inventory.discard();
  }
  const stopPages = watch(pages, () => pageState.reconcile());
  const stopCatalog = watch([catalog, writable], () => {
    for(const plugin of catalog.value?.plugins ?? [])capturedPlugins.set(plugin.id,{...plugin});
    if (ownsPermissions) permissions.setSession("settings", { active: true, canWrite: writable() });
    permissions.reconcile(catalog.value);
  }, { immediate: true });

  /** Open/focus stays idempotent; the component owns its actual DOM focus. */
  async function openSettings(page) {
    if (page?.startsWith('core:plugin-permissions:')) {
      if (!await managePlugin(page.slice('core:plugin-permissions:'.length))) return;
      page = undefined;
    }
    const selected=page && registry.find(page);
    if (selected && !await selectPage(page)) return;
    if (!selected && ['access','account'].includes(currentPage.value?.kind)) await loadAccessSummary();
    if (isVisible()) { focus(); return; }
    setVisible(true);
    if (currentPage.value?.kind === 'plugin-page') await pageState.load(currentPageId.value);
  }
  async function selectPage(id) {
    if (id !== currentPageId.value && !await inventory.resolveDeparture("changing pages")) return false;
    if (id !== currentPageId.value && !await pageState.resolveDeparture([currentPageId.value], "changing pages")) return false;
    if (id !== currentPageId.value && currentPage.value?.kind === 'plugins' && expandedPluginId.value && !await resolvePermissionDeparture([expandedPluginId.value], "changing pages")) return false;
    if (id !== currentPageId.value && !await resolveCoreDeparture('changing pages')) return false;
    core.stopCapture(); closePathChoice();
    if (id !== currentPageId.value) expandedPluginId.value = null;
    currentPageId.value = id;
    if (currentPage.value?.kind === 'branding') core.loadBrand();
    if (['access','account'].includes(currentPage.value?.kind)) await loadAccessSummary();
    if (currentPage.value?.kind === 'plugin-page') await pageState.load(id);
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
  function askRisk(title, message, confirmText, confirmStyle) {
    if (!confirmText || !['cta','danger'].includes(confirmStyle)) throw Error('Risk decisions require an explicit action label and style');
    if (riskResolve) return Promise.resolve(false);
    riskTitle.value = title; riskMessage.value = message; riskConfirmText.value = confirmText; riskConfirmStyle.value = confirmStyle; riskVisible.value = true;
    return new Promise(resolve => { riskResolve = resolve; });
  }
  function resolveRisk(value) { riskVisible.value = false; riskResolve?.(value); riskResolve = null; }
  async function approveScope(id, kind, scope) {
    const view = permissions.snapshot(id).view;
    if (scope.type === "all" && !await askRisk("Approve all hosts", `Approve all hosts and all ports for ${kind === 'imports' ? 'remote-code imports' : 'network data'} in ${pluginName(id)}? This broad grant is separate from Allow network.`, 'Approve all hosts', 'cta')) return false;
    return permissions.approve(id, kind, scope, view);
  }
  async function deleteScope(id, kind, row) {
    const view = permissions.snapshot(id).view, coverage = row.approvalCoverage;
    if (coverage.some(scope => permissionScopeKey(scope) !== permissionScopeKey(row.scope)) && !await askRisk("Remove covering approvals", `Revoking this host requires deleting covering approvals: ${coverage.map(scope => scope.type === 'all' ? 'All hosts' : scope.authority).join(', ')}. Other hosts covered by those grants also lose access unless another approval covers them.`, 'Remove approvals', 'danger')) return false;
    return permissions.remove(id, kind, coverage, view);
  }
  const togglePermissionMaster = id => permissions.setMaster(id, !permissions.snapshot(id).view?.allowNetwork);
  const permissionHostAction = (id, kind, row) => row.action?.kind === 'remove' ? deleteScope(id, kind, row) : approveScope(id, kind, row.scope);
  async function discardPermission(id) {
    if (!await askRisk("Discard choice?", `Discard retained unsaved permission choices for ${pluginName(id)}? This does not undo a committed server decision.`, 'Discard choice', 'danger')) return false;
    return permissions.discard(id);
  }
  async function resolvePermissionDeparture(ids, reason, confirmedDecision) {
    if (ids.some(id => permissions.snapshot(id).busy) && !await permissions.settle()) return false;
    const changed = ids.filter(id => permissions.recoveryIds().includes(id));
    if (!changed.length) return true;
    const pages = changed.map(id => ({ page: { label: `Permissions for ${pluginName(id)}` }, canSave: !!permissions.snapshot(id).draft }));
    const decision = confirmedDecision ?? await askDeparture({ reason, pages, canSave: pages.every(page => page.canSave) });
    if (decision === "discard") return changed.every(id => permissions.discard(id));
    if (decision === "save" || decision === "retry") {
      for (const id of changed) if (!await permissions.retry(id)) return false;
      return true;
    }
    return false;
  }
  async function managePlugin(id) {
    if (!await selectPage('core:plugins')) return false;
    const row=pluginRows.value.find(row=>row.id===id);
    return row?.hasServer ? changeExpansion(id) : true;
  }
  async function changeExpansion(next) {
    const previous=expandedPluginId.value;
    if (previous && previous !== next && !await resolvePermissionDeparture([previous], 'collapsing plugin permissions')) return false;
    if(next&&!pluginRows.value.some(row=>row.id===next&&row.hasServer))return false;
    expandedPluginId.value=next;
    if (next) await permissions.load(next);
    return true;
  }
  const toggleExpansion=id=>changeExpansion(expandedPluginId.value===id?null:id);
  async function resolveCoreDeparture(reason, confirmedDecision) {
    if (!core.hasWork()) return true;
    if (!await core.settle()) return false;
    const decision = confirmedDecision ?? await askDeparture({ reason, pages: [{ page: { label: 'Branding' }, canSave: writable() }], canSave: writable() });
    if (decision === 'discard') return core.discardBrand();
    if (decision === 'save' || decision === 'retry') return await core.saveBrand() && !core.hasWork();
    return false;
  }
  async function cancelBranding() { return await core.settle() && core.discardBrand(); }
  async function resetCoreBranding() { if (await askRisk('Reset branding?', core.resetMessage(), 'Reset branding', 'danger')) await core.saveBrand(true); }
  async function openAccess() { if (await requestClose()) notifyOpenAccess(); }
  function parentPath(path) { return path.split('/').slice(0, -1).join('/'); }
  function closePathChoice() { pathTicket++; pathChoice.value = null; pathEntries.value = []; pathLoading.value=false; return true; }
  async function browseField(id, field) {
    if (!writable() || !pageState.snapshot(id).available) return;
    pathChoice.value = { id, field, root: '' }; await loadPathChoices('');
  }
  async function loadPathChoices(root) {
    const choice = pathChoice.value; if (!choice) return; const ticket = ++pathTicket; pathChoiceError.value = ''; pathLoading.value=true;
    let timer;
    try {
      const tree = await Promise.race([readPaths(root), new Promise((_, reject) => { timer = clock.setTimeout(() => reject(Error('Host path choices could not be loaded within the deadline.')), 5000); })]);
      const entries = tree.folders.map(entry => ({ path: entry.path, label: entry.name, directory: true }));
      if (choice.field.type === 'file') for (const note of tree.notes) entries.push({ path: `${note.path}.md`, label: `${note.title}.md`, directory: false });
      if (ticket === pathTicket && pathChoice.value === choice) { choice.root = root; pathEntries.value = entries.filter(entry => choice.field.type === 'file' || entry.directory).sort((a,b)=>Number(b.directory)-Number(a.directory)||a.label.localeCompare(b.label)); }
    } catch (error) { if (ticket === pathTicket) pathChoiceError.value = error.message; }
    finally { clock.clearTimeout(timer); if(ticket===pathTicket) pathLoading.value=false; }
  }
  function selectPath(path) {
    const choice = pathChoice.value; if (!choice) return;
    const snapshot = pageState.snapshot(choice.id);
    if (!writable() || !snapshot.available || snapshot.changedDescriptor) return;
    pageState.edit(choice.id, choice.field.key, path); pageState.commit(choice.id, choice.field.key); closePathChoice();
  }
  const choosePathEntry = entry => entry.directory ? loadPathChoices(entry.path) : selectPath(entry.path);
  function dispose() {
    decideDeparture("cancel"); resolveRisk(false); closePathChoice(); disposeParticipant();
    inventory.dispose(); pageState.dispose(); core.dispose(); access.dispose(); if (ownsPermissions) permissions.dispose();
    stopPages(); stopCatalog(); stopAccessSession();
  }
  return {
    state: readonly(reactive({ brandingSnapshot, keybindingSnapshot, appearanceSnapshot, accessSummary, accountName, accountSummary, attentionItems, canLogout, versionLabel, currentPageId,
      riskVisible, riskTitle, riskMessage, riskConfirmText, riskConfirmStyle, pathChoice:pathChoiceView, pathEntries, pathChoiceError, pathCrumbs, pathLoading,
      departureVisible, departureMessage, departureCanSave, departureConfirmText, inventorySnapshot,
      groupedPages, inventoryPages, currentSnapshot, currentPage, currentPageIsPlugin, catalogPlugins, catalogPolicy,
      pluginRows, autoEnableView, pluginPageHeader, expandedPluginId })),
    core, permissions, pageState, inventory,
    setRiskVisible: value => { riskVisible.value = value; },
    setDepartureVisible: value => { departureVisible.value = value; },
    openSettings, selectPage, requestClose, reloadCurrentPage, decideDeparture,
    togglePlugin, togglePluginRow, toggleAutoEnable, toggleLineNumbers, toggleDebug, discardInventoryChoice, managePlugin, toggleExpansion,
    approveScope, deleteScope, togglePermissionMaster, permissionHostAction, discardPermission, resolveRisk,
    cancelBranding, resetCoreBranding, openAccess, parentPath, closePathChoice, browseField, loadPathChoices, selectPath, choosePathEntry, dispose,
  };
}
