<template>
  <LoadingIndicator
    ref="loadingIndicator"
    class="relative flex h-dvh w-screen flex-col overflow-hidden print:max-w-full"
  >
    <PrimeToast />
    <SetupModal
      v-if="globalStore.config.setupRequired || globalStore.setupWizardRequested"
      :dismissible="!globalStore.config.setupRequired"
      @completed="setupCompleted"
      @dismiss="globalStore.setupWizardRequested = false"
    />
    <template v-else>
      <QuickSwitcher
        v-model="isQuickSwitcherVisible"
        :initial-focus-event="quickSwitcherFocusEvent"
        @opened="quickSwitcherFocusEvent = null"
      />
      <CommandPalette v-model="isCommandPaletteVisible" />
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
    </template>
  </LoadingIndicator>
</template>

<script setup>
import Mousetrap from "mousetrap";
import "mousetrap/plugins/global-bind/mousetrap-global-bind";
import { useToast } from "primevue/usetoast";
import { computed, ref } from "vue";
import { RouterView, useRoute } from "vue-router";

import { apiErrorHandler, getConfig } from "./api.js";
import { applyBrandToDocument } from "./brand.js";
import { subscribe, TOPICS } from "./bus/index.js";
import PrimeToast from "./components/PrimeToast.vue";
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
import NavBar from "./partials/NavBar.vue";
import QuickSwitcher from "./components/QuickSwitcher.vue";
import CommandPalette from "./components/CommandPalette.vue";
import LoadingIndicator from "./components/LoadingIndicator.vue";
import router from "./router.js";

const globalStore = useGlobalStore();
const isQuickSwitcherVisible = ref(false);
const isCommandPaletteVisible = ref(false);
const loadingIndicator = ref();
const navBar = ref();
const route = useRoute();
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
subscribe(TOPICS.APP_NEW_NOTE, () => {
  if (route.name !== "login") {
    router.push({ name: "new" });
  }
});
subscribe(TOPICS.APP_GO_HOME, () => {
  if (route.name !== "login") {
    router.push({ name: "home" });
  }
});
subscribe(TOPICS.APP_OPEN_SWITCHER, () => {
  if (showNavBar.value) {
    isQuickSwitcherVisible.value = true;
  }
});

getConfig()
  .then((data) => {
    globalStore.config = data;
    applyBrandToDocument(data.brand);
    loadingIndicator.value.setLoaded();
    refreshNoteIndex();
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

subscribe(TOPICS.APP_OPEN_PALETTE, () => {
  isCommandPaletteVisible.value = true;
});

subscribe(TOPICS.HOME_SEARCH_FOCUS, (event) => {
  if (showNavBar.value) {
    isQuickSwitcherVisible.value = true;
    quickSwitcherFocusEvent.value = event ?? null;
  }
});

function setupCompleted() {
  globalStore.setupWizardRequested = false;
  // No reload: setup flipped auth server-side — re-fetch config and route.
  getConfig().then((data) => {
    globalStore.config = data;
    applyBrandToDocument(data.brand);
    if (
      data.authType === authTypes.none ||
      data.authType === authTypes.readOnly
    ) {
      refreshNoteIndex();
      router.push({ name: "home" });
    } else {
      toast.add(
        getToastOptions(
          "Password created — sign in with your new credentials.",
          "Setup complete",
          "success",
        ),
      );
      router.push({ name: "login" });
    }
  });
}

initTheme();
</script>
