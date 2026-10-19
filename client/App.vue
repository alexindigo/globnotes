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
        @open-access="openAccessFromSettings"
        @logout="logoutFromSettings"
      />
      <PermissionRequestModal :request="activePermissionRequest" :presentation="requestPresentation" :narrow-error="narrowError" :narrow-host-text="narrowHostText" :on-narrow-text="permissionReview.setNarrowHost" :on-narrow-host="permissionReview.selectNarrowHost"
        :choices="activePermissionChoices" :busy="activePermissionSnapshot?.busy" :error="activePermissionSnapshot?.error"
        :writable="permissionsWritable"
        :on-scope="chooseRequestScope" :on-master="chooseRequestMaster" :on-approve="approvePermissionRequest" :on-deny="denyPermissionRequest" :on-cancel="deferPermissionRequest" />
      <ConfirmModal :model-value="permissionRiskVisible" action-layout="grouped" @update:model-value="permissionReview.setPermissionRiskVisible" title="Approve all hosts" :message="permissionRiskMessage" confirm-button-text="Approve all hosts"
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
        />
        <div class="min-w-0 flex-1 overflow-y-auto py-4">
          <RouterView />
        </div>
      </div>
    </div>
  </LoadingIndicator>
</template>

<script setup>
import { useToast } from "primevue/usetoast";
import { computed, onBeforeUnmount, provide, ref, toRefs } from "vue";
import { RouterView, useRoute } from "vue-router";

import { createAppPermissions } from "./appPermissions.js";
import { createAppSession } from "./appSession.js";
import { subscribe, TOPICS } from "./bus/index.js";
import PrimeToast from "./components/PrimeToast.vue";
import SettingsModal from "./components/SettingsModal.vue";
import SetupModal from "./components/SetupModal.vue";
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
import router from "./router.js";
import { DIALOG_HOST, isActionAvailable, modalStack } from "./modalState.js";

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
const toast = useToast();
const isSettingsVisible = ref(false);
const session = createAppSession({
  config: () => globalStore.config, setConfig: value => { globalStore.config = value; },
  setSetupRequested: value => { globalStore.setupWizardRequested = value; },
  setSettingsVisible: value => { isSettingsVisible.value = value; },
  navigate: target => router.push(target), toast,
  loaded: () => loadingIndicator.value.setLoaded(), failed: () => loadingIndicator.value.setFailed(),
});
const { openAccessFromSettings, beforeSetupCommit, logoutFromSettings, setupCompleted } = session;
const permissionReview = createAppPermissions({
  config: () => globalStore.config, configReady: () => session.state.configReady,
  routeName: () => route.name, setupRequested: () => globalStore.setupWizardRequested,
  refreshConfig: session.refreshConfig,
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

session.load();

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
subscribeApp(TOPICS.APP_OPEN_SETTINGS, ({ page } = {}) => {
  if (route.name === "login") return;
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
