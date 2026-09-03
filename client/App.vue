<template>
  <LoadingIndicator
    ref="loadingIndicator"
    class="container relative mx-auto flex h-dvh flex-col px-2 py-4 print:max-w-full"
  >
    <PrimeToast />
    <SetupModal
      v-if="globalStore.config.setupRequired"
      @completed="setupCompleted"
    />
    <template v-else>
      <QuickSwitcher
        v-model="isQuickSwitcherVisible"
        :initial-focus-event="quickSwitcherFocusEvent"
        @opened="quickSwitcherFocusEvent = null"
      />
      <SidebarPanel />
      <SyncBanner />
      <!-- Shared content column: navbar and content scroller live beside
           each other in it, so their edges align by construction. -->
      <div class="flex min-h-0 flex-1 flex-col">
        <NavBar
          v-if="showNavBar"
          ref="navBar"
          :class="{ 'print:hidden': route.name == 'note' }"
          :hide-logo="!showNavBarLogo"
          @toggleQuickSwitcher="toggleQuickSwitcher"
        />
        <div class="min-w-0 flex-1 overflow-y-auto pr-2">
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
import { useGlobalStore } from "./globalStore.js";
import { initDebugNotifications } from "./debug.js";
import { initTheme } from "./themes.js";
import { initDispatcher } from "./keybindings/dispatcher.js";
import { refreshNoteIndex } from "./noteIndex.js";
import NavBar from "./partials/NavBar.vue";
import QuickSwitcher from "./components/QuickSwitcher.vue";
import LoadingIndicator from "./components/LoadingIndicator.vue";
import router from "./router.js";

const globalStore = useGlobalStore();
const isQuickSwitcherVisible = ref(false);
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

subscribe(TOPICS.HOME_SEARCH_FOCUS, (event) => {
  if (showNavBar.value) {
    isQuickSwitcherVisible.value = true;
    quickSwitcherFocusEvent.value = event ?? null;
  }
});

function setupCompleted() {
  // Reload so the app boots fresh with the new auth state.
  window.location.reload();
}

initTheme();
</script>
