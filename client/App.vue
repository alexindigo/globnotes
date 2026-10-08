<template>
  <div ref="dialogHost" id="globnotes-dialog-host" />
  <LoadingIndicator
    ref="loadingIndicator"
    class="relative flex h-dvh w-screen flex-col overflow-hidden print:max-w-full"
  >
    <PrimeToast />
    <SetupModal
      v-if="globalStore.config.setupRequired || globalStore.setupWizardRequested"
      :dismissible="!globalStore.config.setupRequired"
      :before-commit="beforeSetupCommit"
      @completed="setupCompleted"
      @dismiss="globalStore.setupWizardRequested = false"
    />
    <div v-if="!globalStore.config.setupRequired" class="contents" data-app-shell :inert="modalStack.length ? '' : undefined">
      <QuickSwitcher
        v-model="isQuickSwitcherVisible"
        :initial-focus-event="quickSwitcherFocusEvent"
        @opened="quickSwitcherFocusEvent = null"
      />
      <CommandPalette v-model="isCommandPaletteVisible" />
      <SettingsModal
        ref="settingsModal"
        v-model="isSettingsVisible"
        :permission-controller="permissions"
        :writable="permissionsWritable"
        @review-request="openRequestedPermissionReview"
        @open-access="openAccessFromSettings"
        @logout="logoutFromSettings"
      />
      <PermissionRequestModal :request="activePermissionRequest" :plugin="activePermissionSnapshot?.plugin" :view="activePermissionSnapshot?.view"
        :choices="activePermissionChoices" :busy="activePermissionSnapshot?.busy" :error="activePermissionSnapshot?.error"
        :has-server="activePermissionSnapshot?.hasServer" :writable="permissionsWritable"
        :on-scope="chooseRequestScope" :on-master="chooseRequestMaster" :on-approve="approvePermissionRequest" :on-deny="denyPermissionRequest" :on-cancel="deferPermissionRequest" />
      <ConfirmModal v-model="permissionRiskVisible" title="Approve all hosts" :message="permissionRiskMessage" confirm-button-text="Select all hosts"
        @confirm="finishPermissionRisk(true)" @cancel="finishPermissionRisk(false)" />
      <!-- Sidebar chrome (open button, backdrop, drawer/docked panel)
           positions itself — fixed, outside the page column. -->
      <SidebarPanel />
      <SyncBanner />
      <!-- Page column: the old centered container geometry (see
           style.css). The header lives INSIDE it, so header and content
           share the column's edges by construction; the column centers
           on the window and yields to the pinned sidebar. -->
      <div
        class="content-column flex min-h-0 flex-1 flex-col print:max-w-full"
        :class="{
          'content-column--pinned':
            globalStore.sidebarVisible && globalStore.sidebarPinned,
        }"
      >
        <NavBar
          v-if="showNavBar"
          ref="navBar"
          class="shrink-0"
          :class="{ 'print:hidden': route.name == 'note' }"
          :hide-logo="!showNavBarLogo"
          @toggleQuickSwitcher="toggleQuickSwitcher"
        />
        <div class="min-w-0 flex-1 overflow-y-auto py-4">
          <RouterView />
        </div>
      </div>
    </div>
  </LoadingIndicator>
</template>

<script setup>
import Mousetrap from "./keybindings/mousetrap.js";
import { useToast } from "primevue/usetoast";
import { computed, onBeforeUnmount, provide, ref, watch } from "vue";
import { RouterView, useRoute } from "vue-router";

import { apiErrorHandler, getConfig, getPluginPermissions, putPluginPermissions, getPluginPermissionRequests, decidePluginPermissionRequest } from "./api.js";
import { applyBrandToDocument } from "./brand.js";
import { subscribe, TOPICS } from "./bus/index.js";
import PrimeToast from "./components/PrimeToast.vue";
import SettingsModal from "./components/SettingsModal.vue";
import SetupModal from "./components/SetupModal.vue";
import SidebarPanel from "./components/SidebarPanel.vue";
import SyncBanner from "./components/SyncBanner.vue";
import { authTypes } from "./constants.js";
import { useGlobalStore } from "./globalStore.js";
import { initDebugNotifications } from "./debug.js";
import { getToastOptions } from "./helpers.js";
import { initTheme } from "./themes.js";
import { initDispatcher } from "./keybindings/dispatcher.js";
import { refreshNoteIndex } from "./noteIndex.js";
import { pluginCatalog, refreshPluginRuntimeCatalog, startPluginRuntime, stopPluginRuntime } from "./pluginRuntime.js";
import { clearStoredToken, getStoredToken } from "./tokenStorage.js";
import { createPluginPermissionController, permissionScopeKey } from "./pluginPermissionController.js";
import PermissionRequestModal from "./components/PermissionRequestModal.vue";
import ConfirmModal from "./components/ConfirmModal.vue";
import NavBar from "./partials/NavBar.vue";
import QuickSwitcher from "./components/QuickSwitcher.vue";
import CommandPalette from "./components/CommandPalette.vue";
import LoadingIndicator from "./components/LoadingIndicator.vue";
import router from "./router.js";
import { DIALOG_HOST, isActionAvailable, modalStack } from "./modalState.js";
import { resolveParticipants } from "./sessionActions.js";

const globalStore = useGlobalStore();
const dialogHost = ref(null);
provide(DIALOG_HOST, dialogHost);
const actionUnsubs = [];
function subscribeApp(topic, handler) { actionUnsubs.push(subscribe(topic, payload => { if (isActionAvailable(topic)) handler(payload); })); }
onBeforeUnmount(() => actionUnsubs.forEach(dispose => dispose()));
const isQuickSwitcherVisible = ref(false);
const isCommandPaletteVisible = ref(false);
const loadingIndicator = ref();
const navBar = ref();
const route = useRoute();
const permissions = createPluginPermissionController({ readView: getPluginPermissions, writeView: putPluginPermissions,
  readPending: getPluginPermissionRequests, decideRequest: decidePluginPermissionRequest, changed: refreshPluginRuntimeCatalog });
const configReady = ref(false);
const permissionsEligible = computed(() => configReady.value && !globalStore.config.setupRequired && route.name !== "login" &&
  ([authTypes.none, authTypes.readOnly].includes(globalStore.config.authType) || !!getStoredToken()));
const permissionsWritable = computed(() => permissionsEligible.value && (globalStore.config.settingsWritable ?? globalStore.config.authType !== authTypes.readOnly));
const activePermissionRequest = ref(null), permissionRiskVisible = ref(false), permissionRiskMessage = ref("");
let requestOpening = 0, permissionRiskResolve = null;
const activePermissionSnapshot = computed(() => activePermissionRequest.value ? permissions.snapshot(activePermissionRequest.value.pluginId) : null);
const activePermissionChoices = computed(() => activePermissionRequest.value ? permissions.requestChoices(activePermissionRequest.value) : { scopes: [], allowNetwork: false });
watch([configReady, () => route.name, () => globalStore.config.authType, () => globalStore.config.setupRequired, permissionsWritable], () => {
  permissions.setSession(`${globalStore.config.authType}:${getStoredToken() ?? 'anonymous'}`, { active: permissionsEligible.value, canWrite: permissionsWritable.value });
  requestOpening++; activePermissionRequest.value = null; finishPermissionRisk(false);
  if (permissionsEligible.value) { permissions.reconcile(pluginCatalog.value); permissions.refreshPending(); }
}, { immediate: true });
watch([permissionsEligible, () => `${globalStore.config.authType}:${getStoredToken() ?? 'anonymous'}`], ([active, session]) => { if (active) startPluginRuntime(session); else stopPluginRuntime(); });
let configRefreshTicket = 0;
watch(pluginCatalog, catalog => {
  permissions.reconcile(catalog); if (permissionsEligible.value) permissions.refreshPending();
  if (!configReady.value) return;
  const ticket = ++configRefreshTicket;
  getConfig().then(fresh => {
    if (ticket !== configRefreshTicket || fresh.accessRevision === undefined || fresh.accessRevision < (globalStore.config.accessRevision ?? 0)) return;
    globalStore.config = fresh;
  }).catch(() => {});
});
const permissionRequestKey = request => request ? JSON.stringify([request.pluginId, request.id, request.state, request.kind, request.scopes, request.source.key, request.source.revision]) : null;
const permissionSession = () => `${globalStore.config.authType}:${getStoredToken() ?? 'anonymous'}`;
function automaticPermissionOpeningEligible() {
  return permissionsEligible.value && !globalStore.setupWizardRequested && !activePermissionRequest.value && !modalStack.value.some(owner => owner.name !== "settings");
}
function permissionRequestCurrent(request, receipt) {
  const snapshot = permissions.snapshot(request.pluginId);
  return receipt.status === "accepted" && receipt.current() && snapshot.available && snapshot.hasServer &&
    snapshot.view?.pendingRequests.some(item => permissionRequestKey(item) === permissionRequestKey(request));
}
watch([() => permissionRequestKey(permissions.nextRequest()), permissionsEligible, () => globalStore.setupWizardRequested, () => route.name, () => modalStack.value, pluginCatalog], async () => {
  // A new modal/session/request invalidates the old opening even if the new
  // state is ineligible. Postponement never writes or locally defers consent.
  const ticket = ++requestOpening;
  if (!automaticPermissionOpeningEligible()) return;
  const request = permissions.nextRequest(); if (!request) return;
  const session = permissionSession(), key = permissionRequestKey(request);
  const receipt = await permissions.load(request.pluginId);
  if (ticket === requestOpening && session === permissionSession() && automaticPermissionOpeningEligible() &&
      permissionRequestKey(permissions.nextRequest()) === key && permissionRequestCurrent(request, receipt)) activePermissionRequest.value = request;
});
watch(() => activePermissionRequest.value && [activePermissionSnapshot.value.view, activePermissionSnapshot.value.available, permissions.pendingRequests.value], () => {
  const request = activePermissionRequest.value; if (!request) return;
  const view = permissions.snapshot(request.pluginId).view;
  if (!permissionsEligible.value || !activePermissionSnapshot.value.available || !view?.pendingRequests.some(item => permissionRequestKey(item) === permissionRequestKey(request))) {
    requestOpening++; activePermissionRequest.value = null; finishPermissionRisk(false);
  }
});
function finishPermissionRisk(value) { permissionRiskVisible.value = false; permissionRiskResolve?.(value); permissionRiskResolve = null; }
async function chooseRequestScope(scope, selected) {
  const request = activePermissionRequest.value; if (!request || activePermissionSnapshot.value.busy) return;
  if (selected && scope.type === "all") {
    permissionRiskMessage.value = `Select all hosts and all ports for ${request.kind === 'imports' ? 'remote-code imports' : 'network data'}? This is broad access, separate from the master.`;
    permissionRiskVisible.value = true;
    if (!await new Promise(resolve => { permissionRiskResolve = resolve; })) return;
    if (activePermissionRequest.value !== request) return;
  }
  const choices = permissions.requestChoices(request), scopes = choices.scopes.filter(item => permissionScopeKey(item) !== permissionScopeKey(scope));
  if (selected) scopes.push(scope);
  permissions.editRequest(request, { scopes });
}
function chooseRequestMaster(value) { const request = activePermissionRequest.value; if (request) permissions.editRequest(request, { allowNetwork: value }); }
async function approvePermissionRequest() {
  const request = activePermissionRequest.value; if (!request) return;
  const choices = permissions.requestChoices(request);
  if (await permissions.decide(request.pluginId, request, "approve", choices.allowNetwork, choices.scopes) && activePermissionRequest.value === request) activePermissionRequest.value = null;
}
async function denyPermissionRequest() {
  const request = activePermissionRequest.value; if (!request) return;
  if (await permissions.decide(request.pluginId, request, "deny") && activePermissionRequest.value === request) activePermissionRequest.value = null;
}
function deferPermissionRequest() {
  const request = activePermissionRequest.value; if (!request || activePermissionSnapshot.value?.busy) return;
  permissions.defer(request.id); requestOpening++; activePermissionRequest.value = null; finishPermissionRisk(false);
}
async function openRequestedPermissionReview(request) {
  if (!permissionsEligible.value) return;
  const ticket = ++requestOpening, session = permissionSession();
  const receipt = await permissions.load(request.pluginId);
  if (ticket === requestOpening && session === permissionSession() && permissionsEligible.value && !globalStore.setupWizardRequested &&
      permissionRequestCurrent(request, receipt)) activePermissionRequest.value = request;
}
onBeforeUnmount(() => { requestOpening++; finishPermissionRisk(false); permissions.dispose(); });
const toast = useToast();
// The focus event that opened the modal — consumed by QuickSwitcher to place
// a thin caret inside its own input, so a click on Home's search box hands
// over visibly instead of feeling unfocused. Cleared as soon as the panel
// reports the handoff complete.
const quickSwitcherFocusEvent = ref(null);

initDebugNotifications(toast);

// Keyboard input: app-level keys are bound by the keybinding dispatcher
// from the active layer (legacy Flatnotes restores Ctrl+Alt+N/H and adds
// per-layer keys); this root component owns the routing effects.
initDispatcher();

// App-level action channel: input sources publish app:* topics, this root
// component owns the routing effects.
subscribeApp(TOPICS.APP_NEW_NOTE, () => {
  if (route.name !== "login") {
    router.push({ name: "new" });
  }
});
subscribeApp(TOPICS.APP_GO_HOME, () => {
  if (route.name !== "login") {
    router.push({ name: "home" });
  }
});
subscribeApp(TOPICS.APP_OPEN_SWITCHER, () => {
  if (showNavBar.value) {
    isQuickSwitcherVisible.value = true;
  }
});

getConfig()
  .then((data) => {
    globalStore.config = data;
    configReady.value = true;
    applyBrandToDocument(data.brand);
    loadingIndicator.value.setLoaded();
    refreshNoteIndex();
    // Browser application contributions start after config/auth
    // readiness, not when WYSIWYG mounts. Setup-pending vaults stay gated.
  })
  .catch((error) => {
    apiErrorHandler(error, toast);
    loadingIndicator.value.setFailed();
  });

const showNavBar = computed(() => {
  return route.name !== "login";
});

const showNavBarLogo = computed(() => {
  return route.name !== "home";
});

function toggleQuickSwitcher() {
  isQuickSwitcherVisible.value = !isQuickSwitcherVisible.value;
}

subscribeApp(TOPICS.APP_OPEN_PALETTE, () => {
  isCommandPaletteVisible.value = true;
});

// Settings: gear, palette, remapped keys and plugin SDK dispatch all
// invoke this ONE handler; an already-open modal focuses the page.
const settingsModal = ref();
const isSettingsVisible = ref(false);
subscribeApp(TOPICS.APP_OPEN_SETTINGS, ({ page } = {}) => {
  if (route.name === "login") return;
  settingsModal.value?.openSettings?.(page);
});

function openAccessFromSettings() {
  isSettingsVisible.value = false;
  globalStore.setupWizardRequested = true;
}

function beforeSetupCommit() {
  return resolveParticipants("access").then(result => result === "proceed");
}

let logoutPending = null;
function logoutFromSettings() {
  if (logoutPending) return logoutPending;
  logoutPending = (async () => {
    if (await resolveParticipants("logout") !== "proceed") return;
    stopPluginRuntime();
    const { clearStoredToken } = await import("./tokenStorage.js");
    clearStoredToken();
    isSettingsVisible.value = false;
    await router.push({ name: "login" });
  })().finally(() => { logoutPending = null; });
  return logoutPending;
}

subscribeApp(TOPICS.HOME_SEARCH_FOCUS, (event) => {
  if (showNavBar.value) {
    isQuickSwitcherVisible.value = true;
    quickSwitcherFocusEvent.value = event ?? null;
  }
});

function setupCompleted(result) {
  if (result) {
    const view = result.view;
    const acknowledged = result.config ?? {
      ...globalStore.config, setupRequired: false,
      authType: view.mode === 'password' ? view.totpEnabled ? authTypes.totp : authTypes.password : view.mode,
      settingsWritable: view.settingsWritable, readOnlySettings: view.readOnlySettings, accessRevision: view.revision,
    };
    globalStore.config = { ...globalStore.config, ...acknowledged };
    globalStore.setupWizardRequested = false;
    configRefreshTicket++;
    if (result.requiresLogin) {
      stopPluginRuntime();
      clearStoredToken();
      toast.add(getToastOptions("Access updated — sign in with your confirmed credentials.", "Access updated", "success"));
      router.push({ name: "login" });
    } else if ([authTypes.none, authTypes.readOnly].includes(acknowledged.authType)) {
      clearStoredToken();
      if (acknowledged.authType === authTypes.readOnly) router.push({ name: "home" });
      else { refreshNoteIndex(); refreshPluginRuntimeCatalog(); }
    } else refreshPluginRuntimeCatalog();
    // Policy is already acknowledged. A follow-up read may refresh unrelated
    // fields, but cannot strand the known credential transition or replay it.
    getConfig().then(fresh => {
      if ((fresh.accessRevision ?? -1) >= (globalStore.config.accessRevision ?? 0)) globalStore.config = fresh;
    }).catch(() => {});
    return;
  }
  globalStore.setupWizardRequested = false;
  // No reload: setup flipped auth server-side — re-fetch config and route.
  getConfig().then((data) => {
    globalStore.config = data;
    applyBrandToDocument(data.brand);
    if (
      data.authType === authTypes.none ||
      data.authType === authTypes.readOnly
    ) {
      import('./tokenStorage.js').then(({ clearStoredToken }) => clearStoredToken());
      refreshNoteIndex();
      router.push({ name: "home" });
    } else {
      stopPluginRuntime();
      import('./tokenStorage.js').then(async ({ clearStoredToken }) => {
        clearStoredToken();
        await router.push({ name: "login" });
      });
      toast.add(
        getToastOptions(
          "Password created — sign in with your new credentials.",
          "Setup complete",
          "success",
        ),
      );
    }
  });
}

initTheme();
</script>
