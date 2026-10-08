<!-- SPDX-License-Identifier: LGPL-3.0-only -->

<template>
  <Modal
    ref="modal"
    v-model="isVisible"
    name="settings"
    anchor="viewport-center"
    labelledby="settings-modal-title"
    trap-focus
    :keydown-handler="core.captureKey"
    :close-handler-override="requestClose"
  >
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-center justify-between border-b border-theme-border px-4 py-3">
        <h2
          id="settings-modal-title"
          class="text-lg font-semibold text-theme-text"
        >Settings</h2>
        <CustomButton
          aria-label="Close settings"
          :icon-path="tabClose"
          @click="requestClose"
        />
      </div>
      <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          class="max-h-40 w-full shrink-0 overflow-y-auto border-b border-theme-border py-2 sm:max-h-none sm:w-48 sm:border-b-0 sm:border-r"
          aria-label="Settings pages"
        >
          <div
            v-for="group in groupedPages"
            :key="group.name"
            class="mb-2"
          >
            <div class="px-4 py-1 text-xs font-bold uppercase text-theme-text-very-muted">
              {{ group.name }}
            </div>
            <button
              v-for="page in group.pages"
              :key="page.id"
              :data-permission-page="page.permissionPluginId"
              class="block w-full truncate px-4 py-1.5 text-left text-sm text-theme-text"
              :class="{ 'bg-theme-background-elevated': page.id === currentPageId }"
              @click="selectPage(page.id)"
            >
              {{ page.label }}
            </button>
          </div>
        </nav>
        <div class="min-w-0 flex-1 overflow-y-auto p-4">
          <div v-if="currentPage?.unsupported">
            <p class="text-sm text-theme-danger">
              This settings page uses an unsupported renderer
              ({{ currentPage.renderer?.kind }}). It cannot be displayed in
              this version of globnotes.
            </p>
          </div>
          <PluginPermissionPanel
            v-else-if="currentPage?.permissionPluginId"
            :plugin="permissionSnapshot?.plugin"
            :view="permissionSnapshot?.view"
            :busy="permissionSnapshot?.busy"
            :error="permissionSnapshot?.error"
            :has-server="permissionSnapshot?.hasServer"
            :writable="permissionSnapshot?.writable"
            :has-draft="!!permissionSnapshot?.draft"
            :on-master="value=>permissions.setMaster(currentPage.permissionPluginId,value)"
            :on-approve="(kind,scope)=>approveScope(currentPage.permissionPluginId,kind,scope)"
            :on-delete="(kind,row)=>deleteScope(currentPage.permissionPluginId,kind,row)"
            :on-review="()=>permissions.review(currentPage.permissionPluginId)"
            :on-retry="()=>permissions.retry(currentPage.permissionPluginId)"
            :on-discard="()=>discardPermission(currentPage.permissionPluginId)"
            :on-request="request=>emit('review-request',request)"
          />
          <div v-else-if="currentPage?.owner && currentPage.owner !== 'core'" class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <PluginBrowserBadge :runs-in-browser="currentPage.plugin?.runsInBrowser" :browser-components="currentPage.plugin?.browserComponents" />
            <CustomButton label="Review permissions" @click="openPermissionReview(currentPage.owner)" />
          </div>
          <PluginTrustNotice />
          <DeclarativeSettingsPage
            :key="currentPageId"
            :page="currentPage.descriptor"
            :blocking="currentPage.blocking"
            :snapshot="currentSnapshot"
            :on-browse="field=>browseField(currentPageId,field)"
            @edit="pageState.edit(currentPageId, $event.key, $event.raw)"
            @commit="pageState.commit(currentPageId, $event)"
            @reload="reloadCurrentPage"
            @retry="pageState.retry(currentPageId)"
          />
          </div>
          <div v-else-if="currentPage">
            <!-- Appearance: the theme list content (values + callbacks;
             the legacy popup wrapper is not rendered here). -->
            <AppearanceSettingsPage v-if="currentPage.id === 'core:appearance'" :themes="core.THEMES" :selected="core.currentTheme.value" :on-select="core.setTheme" :on-swatch="core.themeSwatch" />
            <KeybindingsSettingsPage v-else-if="currentPage.id === 'core:keybindings'" :layers="core.layers" :snapshot="keybindingSnapshot" :on-layer="core.setLayer" :on-capture="core.startCapture" :on-reset="core.resetBinding" />
            <BrandingSettingsPage v-else-if="currentPage.id === 'core:branding'" :snapshot="brandingSnapshot" :on-edit="core.editBrand" :on-clear-accent="core.clearAccent" :on-pick-file="core.chooseFile" :on-discard-file="core.discardFile" :on-remove-file="core.removeFile" :on-save="()=>core.saveBrand()" :on-reset="resetCoreBranding" :on-retry="core.retryBrand" :on-cancel="requestClose" />
            <!-- Plugins: vault-owned inventory + enablement (the old
             localStorage switches are legacy preferences, shown once). -->
            <PluginInventorySettingsPage v-else-if="currentPage.id === 'core:plugins'"
              :plugins="catalogPlugins" :policy="catalogPolicy" :writable="writable" :errors="pluginError" :snapshot="inventorySnapshot"
               :on-auto-enable="toggleAutoEnable" :on-enabled="togglePlugin" :on-review="openPermissionReview"
               :on-policy-review="inventory.review" :on-policy-retry="inventory.retry" :on-policy-discard="discardInventoryChoice" />
            <div v-else-if="currentPage.id === 'core:editor'" class="flex items-center gap-2 text-sm text-theme-text">
              <Toggle :is-on="core.viewLineNumbers.value" @click="core.saveViewLineNumbers(!core.viewLineNumbers.value)" />
              Line numbers in view mode
            </div>
            <div v-else-if="currentPage.id === 'core:diagnostics'" class="flex items-center gap-2 text-sm text-theme-text">
              <Toggle :is-on="core.debugEnabled.value" @click="core.toggleDebug()" />
              Debug notifications
            </div>
            <div v-else-if="currentPage.id === 'core:access'" class="flex flex-col gap-2">
              <p class="text-sm text-theme-text-muted">
                Update access and authenticator settings in place. Your note
                stays open underneath while you confirm the change.
              </p>
              <CustomButton v-if="writable" label="Change access mode" @click="openAccess" />
               <p v-else class="text-sm text-theme-text-muted">Access changes are unavailable in this session. Locked settings are recovered through deployment configuration.</p>
            </div>
            <div v-else-if="currentPage.id === 'core:account'" class="flex flex-col gap-2">
              <CustomButton v-if="canLogout" label="Log out" @click="$emit('logout')" />
              <p v-else class="text-sm text-theme-text-muted">This session has no account to log out.</p>
            </div>
            <p v-else class="text-sm text-theme-text-muted">This page has no options.</p>
          </div>
        </div>
      </div>
    </div>
  </Modal>
  <Modal :model-value="!!reviewPluginId" name="plugin-permission-review" anchor="viewport-center" labelledby="permission-review-title" trap-focus :close-handler-override="closePermissionReview">
    <section v-if="reviewSnapshot" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" data-permission-review>
      <div class="flex items-center justify-between gap-2">
        <h2 id="permission-review-title" class="text-lg font-semibold">Review permissions</h2>
        <CustomButton label="Close review" @click="closePermissionReview" />
      </div>
      <PluginPermissionPanel :plugin="reviewSnapshot.plugin" :view="reviewSnapshot.view" :busy="reviewSnapshot.busy" :error="reviewSnapshot.error"
        :has-server="reviewSnapshot.hasServer" :writable="reviewSnapshot.writable" :has-draft="!!reviewSnapshot.draft"
        :on-master="value=>permissions.setMaster(reviewPluginId,value)" :on-approve="(kind,scope)=>approveScope(reviewPluginId,kind,scope)"
        :on-delete="(kind,row)=>deleteScope(reviewPluginId,kind,row)" :on-review="()=>permissions.review(reviewPluginId)" :on-retry="()=>permissions.retry(reviewPluginId)"
        :on-discard="()=>discardPermission(reviewPluginId)" :on-request="request=>emit('review-request',request)" />
    </section>
  </Modal>
  <ConfirmModal v-model="riskVisible" :title="riskTitle" :message="riskMessage" :confirm-button-text="riskConfirmText" :confirm-button-style="riskConfirmStyle" @confirm="resolveRisk(true)" @cancel="resolveRisk(false)" />
  <Modal :model-value="!!pathChoice" name="settings-path-choice" anchor="viewport-center" labelledby="settings-path-title" trap-focus :close-handler-override="closePathChoice">
    <section v-if="pathChoice" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"><h2 id="settings-path-title" class="text-lg font-semibold">Choose {{ pathChoice.field.type }} in this vault</h2>
      <p class="text-sm text-theme-text-muted">Outside-host paths remain validated text values in the settings field.</p><p v-if="pathChoiceError" role="alert">{{ pathChoiceError }}</p>
      <CustomButton v-if="pathChoice.root" label="Parent folder" @click="loadPathChoices(parentPath(pathChoice.root))" />
      <CustomButton v-if="pathChoice.field.type==='folder'" :label="pathChoice.root ? 'Use this folder' : 'Use vault root'" @click="selectPath(pathChoice.root)" />
      <button v-for="entry in pathEntries" :key="entry.path" class="rounded border border-theme-border p-2 text-left text-theme-text" @click="entry.directory ? loadPathChoices(entry.path) : selectPath(entry.path)">{{ entry.label }}{{ entry.directory ? '/' : '' }}</button>
      <CustomButton label="Cancel" @click="closePathChoice" />
    </section>
  </Modal>
  <ConfirmModal
    v-model="departureVisible"
    title="Unsaved settings"
    :message="departureMessage"
    confirm-button-text="Save / Retry"
    :confirm-disabled="!departureCanSave"
    reject-button-text="Discard"
    cancel-button-text="Keep editing"
    @confirm="decideDeparture('save')"
    @reject="decideDeparture('discard')"
    @cancel="decideDeparture('cancel')"
  />
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";

import {
  commitPluginPage,
  findPage,
  readPluginPage,
  settingsPages,
  permissionPageId,
} from "../settingsRegistry.js";
import { createSettingsPageState } from "../settingsPageState.js";
import { createPluginInventoryController } from "../pluginInventoryController.js";
import { getStoredToken } from "../tokenStorage.js";
import { registerSessionParticipant } from "../sessionActions.js";
import Modal from "./Modal.vue";
import ConfirmModal from "./ConfirmModal.vue";
import CustomButton from "./CustomButton.vue";
import DeclarativeSettingsPage from "./DeclarativeSettingsPage.vue";
import { tabClose } from "../icons.js";
import { pluginCatalog, refreshPluginRuntimeCatalog, capturePluginCatalogOwnership, acknowledgePluginPolicy } from "../pluginRuntime.js";
import { putPluginEnabled, putPluginPolicy } from "../api.js";
import Toggle from "./Toggle.vue";
import PluginPermissionPanel from "./PluginPermissionPanel.vue";
import PluginInventorySettingsPage from "./PluginInventorySettingsPage.vue";
import PluginTrustNotice from "./PluginTrustNotice.vue";
import PluginBrowserBadge from "./PluginBrowserBadge.vue";
import { createPluginPermissionController, permissionScopeKey } from "../pluginPermissionController.js";
import { getPluginPermissions, putPluginPermissions, getPluginPermissionRequests, decidePluginPermissionRequest } from "../api.js";
import { getConfig, postBrand, getTree } from "../api.js";
import { useGlobalStore } from "../globalStore.js";
import { authTypes } from "../constants.js";
import { createCoreSettingsAdapters } from "../coreSettingsAdapters.js";
import AppearanceSettingsPage from "./AppearanceSettingsPage.vue";
import KeybindingsSettingsPage from "./KeybindingsSettingsPage.vue";
import BrandingSettingsPage from "./BrandingSettingsPage.vue";

const props = defineProps({ permissionController: Object, writable: { type: Boolean, default: false } });
const isVisible = defineModel({ type: Boolean });
const emit = defineEmits(["open-access", "logout", "review-request"]);
const globalStore = useGlobalStore();
const core = createCoreSettingsAdapters({ getBrand: ()=>globalStore.config.brand, writable: ()=>props.writable, writeBrand: postBrand,
  readBrand: async()=> (await getConfig()).brand, applyBrand: fresh=>{globalStore.config={...globalStore.config,brand:fresh};} });
const brandingSnapshot = computed(()=>core.brandSnapshot()), keybindingSnapshot = computed(()=>core.keybindings());
const canLogout = computed(()=>[authTypes.password,authTypes.totp].includes(globalStore.config.authType));

const currentPageId = ref("core:appearance");
const modal = ref(null);
const ownsPermissions = !props.permissionController;
const permissions = props.permissionController ?? createPluginPermissionController({ readView: getPluginPermissions, writeView: putPluginPermissions,
  readPending: getPluginPermissionRequests, decideRequest: decidePluginPermissionRequest, changed: refreshCatalog });
if (ownsPermissions) permissions.setSession("settings", { active: true, canWrite: props.writable });
const reviewPluginId = ref(null), riskVisible = ref(false), riskTitle = ref(""), riskMessage = ref("");
const riskConfirmText = ref("Confirm permission change"), riskConfirmStyle = ref("cta");
const pathChoice = ref(null), pathEntries = ref([]), pathChoiceError = ref("");
let pathTicket = 0;
let riskResolve = null;
const reviewSnapshot = computed(() => reviewPluginId.value ? permissions.snapshot(reviewPluginId.value) : null);
const departureVisible = ref(false);
const departureMessage = ref("");
const departureCanSave = ref(false);
let departureRequest = null;
let departureResolve = null;
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
const pageState = createSettingsPageState({ registry: {
  find: findPage,
  read: page => page.owner === "core" ? Promise.resolve({ values: {}, revision: 0 }) : readPluginPage(page.owner, page.pageId),
  commit: (page, values, revision) => commitPluginPage(page.owner, page.pageId, values, revision),
}, confirm: askDeparture });
const inventory = createPluginInventoryController({
  getCatalog: () => pluginCatalog.value,
  getSession: () => `${globalStore.config.authType}:${getStoredToken() ?? 'anonymous'}`,
  writable: () => props.writable,
  captureOwner: capturePluginCatalogOwnership, acknowledge: acknowledgePluginPolicy,
  writeEnabled: putPluginEnabled, writePolicy: putPluginPolicy, refreshCatalog,
  prepareDisable: async id => await pageState.resolveDeparture(pageState.pageIds().filter(pageId => pageState.snapshot(pageId).page.owner === id), "disabling plugin") && await resolvePermissionDeparture([id], "disabling plugin"),
  confirm: askDeparture,
});
const inventorySnapshot = computed(() => inventory.snapshot());
const disposeParticipant = registerSessionParticipant("settings", {
  hasUnsavedChanges: () => inventory.hasWork() || pageState.hasWork() || permissions.hasWork() || core.hasWork(),
  settlePending: async () => await inventory.settle() && await pageState.settle() && await permissions.settle() && await core.settle(),
  requestDecision: reason => {
    const pages = pageState.pageIds().map(pageState.snapshot).filter(page => page.dirty || page.pending);
    const permissionPages = permissions.recoveryIds().map(id => ({ page: { label: `Server permissions: ${id}` }, canSave: !!permissions.snapshot(id).draft }));
    const corePages = core.hasWork() ? [{page:{label:'Branding'},canSave:props.writable}] : [];
    const inventoryPages = inventory.hasWork() ? [{ page: { label: inventory.snapshot().label }, canSave: inventory.snapshot().canRetry }] : [];
    return askDeparture({ reason, pages: [...pages, ...permissionPages, ...corePages, ...inventoryPages], canSave: [...pages, ...permissionPages, ...corePages, ...inventoryPages].every(page => page.canSave) });
  },
  save: async () => await inventory.resolveDeparture("session handoff", "save") && await pageState.resolveDeparture(pageState.pageIds(), "session handoff", "save") && await resolvePermissionDeparture(permissions.recoveryIds(), "session handoff", "save") && await resolveCoreDeparture('session handoff','save'),
  discard: async () => await inventory.resolveDeparture("session handoff", "discard") && await pageState.resolveDeparture(pageState.pageIds(), "session handoff", "discard") && await resolvePermissionDeparture(permissions.recoveryIds(), "session handoff", "discard") && await resolveCoreDeparture('session handoff','discard'),
});
onBeforeUnmount(() => { decideDeparture("cancel"); resolveRisk(false); closePathChoice(); disposeParticipant(); inventory.dispose(); pageState.dispose(); core.dispose(); if (ownsPermissions) permissions.dispose(); });
const pluginError = ref({});

const groupedPages = computed(() => {
  const groups = new Map();
  const pages = new Map([...settingsPages.value, ...pageState.recoveryPages()].map(page => [page.id, page]));
  for (const page of pages.values()) {
    if (!groups.has(page.group)) groups.set(page.group, []);
    groups.get(page.group).push(page);
  }
  return [...groups.entries()].map(([name, pages]) => ({ name, pages }));
});

const currentSnapshot = computed(() => ({...pageState.snapshot(currentPageId.value),writable:props.writable}));
const currentPage = computed(() => currentSnapshot.value.page);
const permissionSnapshot = computed(() => currentPage.value?.permissionPluginId ? permissions.snapshot(currentPage.value.permissionPluginId) : null);
const catalogPlugins = computed(() => pluginCatalog.value?.plugins ?? []);
const catalogPolicy = computed(() => pluginCatalog.value?.policy ?? null);

async function refreshCatalog() {
  return await refreshPluginRuntimeCatalog();
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

watch(settingsPages, () => pageState.reconcile());
watch([pluginCatalog, () => props.writable], () => {
  if (ownsPermissions) permissions.setSession("settings", { active: true, canWrite: props.writable });
  permissions.reconcile(pluginCatalog.value);
}, { immediate: true });

/** Open (or focus) the requested page — idempotent for repeat opens. */
async function openSettings(page) {
  if (page && findPage(page) && !await selectPage(page)) return;
  if (isVisible.value) {
    modal.value?.focus();
    return;
  }
  isVisible.value = true;
  if (currentPage.value?.owner !== "core") await pageState.load(currentPageId.value);
}

async function selectPage(id) {
  if (id !== currentPageId.value && !await inventory.resolveDeparture("changing pages")) return false;
  if (id !== currentPageId.value && !await pageState.resolveDeparture([currentPageId.value], "changing pages")) return false;
  if (id !== currentPageId.value && currentPage.value?.permissionPluginId && !await resolvePermissionDeparture([currentPage.value.permissionPluginId], "changing pages")) return false;
  if (id !== currentPageId.value && !await resolveCoreDeparture('changing pages')) return false;
  core.stopCapture(); closePathChoice();
  currentPageId.value = id;
  if(id==='core:branding') core.loadBrand();
  if (currentPage.value?.permissionPluginId) await permissions.load(currentPage.value.permissionPluginId);
  if (currentPage.value?.owner !== "core") await pageState.load(id);
  return true;
}

/** Closing never silently discards pending/invalid drafts: the page keeps
 * them in component state; reopening the same session shows them again. */
async function requestClose() {
  if (!await inventory.resolveDeparture("closing Settings")) return false;
  if (!await pageState.resolveDeparture(pageState.pageIds(), "closing Settings")) return false;
  if (!await resolvePermissionDeparture(permissions.recoveryIds(), "closing Settings")) return false;
  if (!await resolveCoreDeparture('closing Settings')) return false;
  core.stopCapture(); closePathChoice();
  isVisible.value = false;
  return true;
}
async function reloadCurrentPage() {
  if (!await pageState.resolveDeparture([currentPageId.value], "reloading")) return;
  await pageState.load(currentPageId.value);
}

function askRisk(title, message, confirmText = 'Confirm permission change', confirmStyle = 'cta') {
  if (riskResolve) return Promise.resolve(false);
  riskTitle.value = title; riskMessage.value = message; riskConfirmText.value=confirmText; riskConfirmStyle.value=confirmStyle; riskVisible.value = true;
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
  if (coverage.some(scope => permissionScopeKey(scope) !== permissionScopeKey(row.scope)) && !await askRisk("Remove covering approvals", `Revoking this host requires deleting covering approvals: ${coverage.map(scope=>scope.type==='all'?'All hosts':scope.authority).join(', ')}. Other hosts covered by those grants also lose access unless another approval covers them.`)) return false;
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
  const decision = confirmedDecision ?? await askDeparture({ reason, pages, canSave: pages.every(page=>page.canSave) });
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
  const decision=confirmedDecision ?? await askDeparture({reason,pages:[{page:{label:'Branding'},canSave:props.writable}],canSave:props.writable});
  if(decision==='discard') return core.discardBrand();
  if(decision==='save'||decision==='retry') return await core.saveBrand() && !core.hasWork();
  return false;
}
async function resetCoreBranding() { if(await askRisk('Reset branding?',core.resetMessage(),'Reset','danger')) await core.saveBrand(true); }
async function openAccess() { if(await requestClose()) emit('open-access'); }
function parentPath(path) { return path.split('/').slice(0,-1).join('/'); }
function closePathChoice() { pathTicket++; pathChoice.value=null; pathEntries.value=[]; return true; }
async function browseField(id,field) { if(!props.writable || !pageState.snapshot(id).available) return; pathChoice.value={id,field,root:''}; await loadPathChoices(''); }
async function loadPathChoices(root) {
  const choice=pathChoice.value; if(!choice)return; const ticket=++pathTicket; pathChoiceError.value='';
  let timer;
  try {
    const tree=await Promise.race([getTree(root),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Host path choices could not be loaded within the deadline.')),5000);})]), entries=tree.folders.map(entry=>({path:entry.path,label:entry.name,directory:true}));
    if(choice.field.type==='file') for(const note of tree.notes) entries.push({path:`${note.path}.md`,label:`${note.title}.md`,directory:false});
    if(ticket===pathTicket && pathChoice.value===choice) { choice.root=root; pathEntries.value=entries.filter(entry=>choice.field.type==='file'||entry.directory); }
  } catch(error) { if(ticket===pathTicket)pathChoiceError.value=error.message; }
  finally {clearTimeout(timer);}
}
function selectPath(path) { const choice=pathChoice.value;if(!choice)return;const snapshot=pageState.snapshot(choice.id);if(!props.writable||!snapshot.available||snapshot.changedDescriptor)return;pageState.edit(choice.id,choice.field.key,path);pageState.commit(choice.id,choice.field.key);closePathChoice(); }

defineExpose({ openSettings, selectPage });
</script>
