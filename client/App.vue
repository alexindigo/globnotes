<template>
  <div ref="dialogHost" id="globnotes-dialog-host" />
  <LoadingIndicator
    ref="loadingIndicator"
    class="relative flex h-dvh w-screen flex-col overflow-hidden print:max-w-full"
  >
    <PrimeToast :action-notice="app.session.state.reloadRequired" />
    <Modal v-if="reauthentication && !app.session.state.reloadRequired" :key="reauthentication.id" :model-value="true" name="reauthentication" anchor="dialog"
      labelledby="reauthentication-title" trap-focus :close-handler-override="reauthentication.cancel">
      <div class="flex flex-col gap-4 p-6" data-reauthentication>
        <h2 id="reauthentication-title" class="text-xl font-semibold">Sign in to continue</h2>
        <p>Your edits stay here. Saves paused for sign-in will retry.</p>
        <LoginForm :on-authenticated="reauthentication.authenticated" :is-current="reauthentication.isCurrent" dialog />
        <button type="button" class="self-end rounded px-3 py-2 hover:bg-theme-background-elevated" @click="reauthentication.cancel">Cancel</button>
      </div>
    </Modal>
    <IdentityDialog v-if="app.state.signInVisible && !app.session.state.reloadRequired" :open="true" title="Sign in" :cancel="app.closeSignIn">
      <LoginForm :on-authenticated="app.closeSignIn" dialog />
    </IdentityDialog>
    <div class="contents" data-app-shell :inert="modalStack.length || app.session.state.reloadRequired ? '' : undefined">
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
        :identity-controllers="identityControllers"
        :writable="permissionsWritable"
        @logout="app.logoutFromSettings"
      />
      <PermissionRequestModal :request="activePermissionRequest" :presentation="requestPresentation" :narrow-error="narrowError" :narrow-host-text="narrowHostText" :on-narrow-text="permissionReview.setNarrowHost" :on-narrow-host="permissionReview.selectNarrowHost"
        :choices="activePermissionChoices" :busy="activePermissionSnapshot?.busy" :error="activePermissionSnapshot?.error"
        :writable="permissionsWritable"
        :on-scope="chooseRequestScope" :on-master="chooseRequestMaster" :on-approve="approvePermissionRequest" :on-deny="denyPermissionRequest" :on-cancel="deferPermissionRequest" />
      <ConfirmModal :model-value="permissionRiskVisible" action-layout="grouped" @update:model-value="permissionReview.setPermissionRiskVisible" title="Approve all hosts" :message="permissionRiskMessage" confirm-button-text="Approve all hosts"
        @confirm="finishPermissionRisk(true)" @cancel="finishPermissionRisk(false)" />
      <!-- Sidebar chrome (open button, backdrop, drawer/docked panel)
           positions itself — fixed, outside the page column. -->
      <SidebarPanel v-if="app.state.noteShell" />
      <SyncBanner v-if="app.state.noteShell" />
      <!-- Page column: the old centered container geometry (see
           style.css). The header lives INSIDE it, so header and content
           share the column's edges by construction; the column centers
           on the window and yields to the pinned sidebar. -->
      <div
        class="content-column flex min-h-0 flex-1 flex-col print:max-w-full"
        :class="{
          'content-column--pinned':
            sidebarVisible && sidebarPinned,
        }"
      >
        <NavBar
          v-if="showNavBar"
          ref="navBar"
          class="shrink-0"
          :class="{ 'print:hidden': route.name == 'note' }"
          :hide-logo="!showNavBarLogo"
          @toggleQuickSwitcher="toggleQuickSwitcher"
          @openSyncSettings="settingsModal?.openSettings('core:sync')"
        />
        <div class="min-w-0 flex-1 overflow-y-auto py-4">
          <RouterView v-if="app.state.configReady" />
        </div>
      </div>
    </div>
  </LoadingIndicator>
</template>

<script setup>
import { useToast } from "primevue/usetoast";
import { computed, onBeforeUnmount, onMounted, provide, ref, toRefs, watch } from "vue";
import { RouterView, useRoute } from "vue-router";

import { createAppPermissions } from "./appPermissions.js";
import { createIdentityApplication, IDENTITY_APPLICATION } from "./identityApplication.js";
import { activeTokenStorage } from "./tokenStorage.js";
import { bindVaultChanges } from "./vaultChanges.js";
import { bindPluginRuntime } from "./pluginRuntime.js";
import { bindNoteIndex } from "./noteIndex.js";
import { subscribe, TOPICS } from "./bus/index.js";
import PrimeToast from "./components/PrimeToast.vue";
import SettingsModal from "./components/SettingsModal.vue";
import IdentityDialog from "./components/IdentityDialog.vue";
import SidebarPanel from "./components/SidebarPanel.vue";
import SyncBanner from "./components/SyncBanner.vue";
import { useGlobalStore } from "./globalStore.js";
import { sidebarPinned, sidebarVisible } from "./sidebarPreferences.js";
import { initDebugNotifications } from "./debug.js";
import { initTheme } from "./themes.js";
import { initDispatcher } from "./keybindings/dispatcher.js";
import PermissionRequestModal from "./components/PermissionRequestModal.vue";
import ConfirmModal from "./components/ConfirmModal.vue";
import NavBar from "./partials/NavBar.vue";
import QuickSwitcher from "./components/QuickSwitcher.vue";
import CommandPalette from "./components/CommandPalette.vue";
import LoadingIndicator from "./components/LoadingIndicator.vue";
import router, { bindIdentityRouteSession } from "./router.js";
import { DIALOG_HOST, isActionAvailable, modalStack } from "./modalState.js";
import Modal from "./components/Modal.vue";
import LoginForm from "./components/LoginForm.vue";
import { reauthenticationRequest as reauthentication } from "./reauthentication.js";
import { CONFLICT_INBOX, createConflictInbox } from "./conflictInbox.js";
import { SYNC_STATUS, createSyncStatus } from "./syncStatusController.js";

const globalStore = useGlobalStore();
const dialogHost = ref(null);
provide(DIALOG_HOST, dialogHost);
const actionUnsubs = [];
function subscribeApp(topic, handler) { actionUnsubs.push(subscribe(topic, payload => { if (!app.session.state.reloadRequired && isActionAvailable(topic)) handler(payload); })); }
onBeforeUnmount(() => actionUnsubs.forEach(dispose => dispose()));
const isQuickSwitcherVisible = ref(false);
const isCommandPaletteVisible = ref(false);
const loadingIndicator = ref();
const navBar = ref();
const route = useRoute();
const toast = useToast();
const isSettingsVisible = ref(false);
const app = createIdentityApplication({
  config: () => globalStore.config, setConfig: value => { globalStore.config = value; },
  tokens: activeTokenStorage(), store: globalStore, currentRoute: () => route,
  confirmDeparture: request => settingsModal.value.confirmDeparture(request),
  setSettingsVisible: value => { isSettingsVisible.value = value; },
  navigate: target => router.push(target), toast,
  loaded: () => loadingIndicator.value.setLoaded(), failed: () => loadingIndicator.value.setFailed(),
});
provide(IDENTITY_APPLICATION, app);
watch(() => app.session.state.reloadRequired, notice => {
  if (!notice) return;
  reauthentication.value?.cancel();
  isQuickSwitcherVisible.value = isCommandPaletteVisible.value = isSettingsVisible.value = false;
});
const identityControllers = app.createSettings();
const releases = [bindIdentityRouteSession(app.session), bindVaultChanges(app.changes), bindPluginRuntime(app.runtime), bindNoteIndex(app.index)];
onBeforeUnmount(() => { releases.forEach(release => release()); void app.dispose(); });
watch(() => route.name, app.routeChanged);
const conflictInbox = createConflictInbox();
provide(CONFLICT_INBOX, conflictInbox);
conflictInbox.bindContext({ config: () => globalStore.config,
  configReady: () => app.state.hasLiveConfig, routeName: () => route.name });
onBeforeUnmount(conflictInbox.dispose);
const syncStatus = createSyncStatus();
provide(SYNC_STATUS,syncStatus);
syncStatus.bindContext({config:()=>globalStore.config,configReady:()=>app.state.hasLiveConfig,routeName:()=>route.name});
onBeforeUnmount(syncStatus.dispose);
const permissionReview = createAppPermissions({
  config: () => globalStore.config, configReady: () => app.state.configReady,
  sessionKey: app.session.key,
  routeName: () => route.name, setupRequested: () => route.name === "setup",
  startRuntime: () => {}, stopRuntime: () => {},
  refreshConfig: app.refreshConfig,
});
const { permissions, finishPermissionRisk, chooseRequestScope, chooseRequestMaster,
  approvePermissionRequest, denyPermissionRequest, deferPermissionRequest } = permissionReview;
const { permissionsWritable, activePermissionRequest, activePermissionSnapshot, activePermissionChoices, requestPresentation, narrowError, narrowHostText,
  permissionRiskVisible, permissionRiskMessage } = toRefs(permissionReview.state);
onBeforeUnmount(permissionReview.dispose);
// The focus event that opened the modal — consumed by QuickSwitcher to place
// a thin caret inside its own input, so a click on Home's search box hands
// over visibly instead of feeling unfocused. Cleared as soon as the panel
// reports the handoff complete.
const quickSwitcherFocusEvent = ref(null);

initDebugNotifications(toast);

// Keyboard input: app-level keys are bound by the keybinding dispatcher
// from the active layer (all layers share Ctrl+Alt+N/H and add per-layer
// keys); this root component owns the routing effects.
initDispatcher();

// App-level action channel: input sources publish app:* topics, this root
// component owns the routing effects.
subscribeApp(TOPICS.APP_NEW_NOTE, app.newNote);
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

onMounted(app.load);

const showNavBar = computed(() => {
  return app.state.noteShell;
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
subscribeApp(TOPICS.APP_OPEN_SETTINGS, ({ page } = {}) => {
  if (!app.state.noteShell) return;
  settingsModal.value?.openSettings?.(page);
});

subscribeApp(TOPICS.HOME_SEARCH_FOCUS, (event) => {
  if (showNavBar.value) {
    isQuickSwitcherVisible.value = true;
    quickSwitcherFocusEvent.value = event ?? null;
  }
});

initTheme();
</script>
