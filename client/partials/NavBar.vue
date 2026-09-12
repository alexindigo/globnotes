<template>
  <nav
    class="sticky top-0 z-20 mb-2 flex justify-between bg-theme-background align-top md:mb-6"
  >
    <div class="flex items-start pl-10 md:pl-0">
      <RouterLink :to="{ name: 'home' }" v-if="!hideLogo">
        <Logo responsive></Logo>
      </RouterLink>
    </div>
    <div class="flex grow items-start justify-end pr-10 md:pr-4">
      <!-- All Notes (browse the whole tree) -->
      <RouterLink
        :to="{
          name: 'search',
          query: {
            [params.searchTerm]: '*',
            [params.sortBy]: searchSortOptions.path,
          },
        }"
        title="All notes"
      >
        <CustomButton :iconPath="allNotesIcon" title="All notes" />
      </RouterLink>
      <!-- Search (unified jump + full-text) -->
      <CustomButton :iconPath="tabSearch" title="Search" @click="openSearch" />
      <!-- New Note -->
      <RouterLink v-if="showNewButton" :to="newNoteTarget">
        <CustomButton :iconPath="tabEdit" title="New note" />
      </RouterLink>
    </div>
  </nav>

  <!-- Floating corner menu (matches the sidebar toggle treatment) -->
  <div class="fixed right-4 top-4 z-30">
    <CustomButton
      :iconPath="tabMenu"
      label=""
      variant="cta"
      class="shadow-md"
      title="Menu"
      @click="toggleMenu"
    />
    <PrimeMenu
      ref="menu"
      :model="menuItems"
      :popup="true"
      @show="publish(TOPICS.SETTINGS_MENU_OPEN, {})"
      @hide="publish(TOPICS.SETTINGS_MENU_CLOSE, {})"
    />
    <ThemePicker v-model="themePickerVisible" />
    <KeybindingsPanel v-model="keybindingsVisible" />
    <PluginSettings v-model="pluginSettingsVisible" />
    <BrandingSettings v-model="brandingVisible" />
  </div>
</template>

<script setup>
import { tabSearch, tabEdit } from "../icons.js";
import {
  tabConsole,
  tabListNumbers,
  tabLogout,
  tabMenu,
  tabDeviceDesktop,
  tabKeyboard,
  tabPalette,
  tabPlug,
} from "../icons.js";
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import { publish, TOPICS } from "../bus/index.js";
import BrandingSettings from "../components/BrandingSettings.vue";
import CustomButton from "../components/CustomButton.vue";
import Logo from "../components/Logo.vue";
import KeybindingsPanel from "../components/KeybindingsPanel.vue";
import PluginSettings from "../components/PluginSettings.vue";
import PrimeMenu from "../components/PrimeMenu.vue";
import ThemePicker from "../components/ThemePicker.vue";
import { authTypes, params, searchSortOptions } from "../constants.js";
import { useGlobalStore } from "../globalStore.js";
import { directoryFromPath } from "../helpers.js";
import { debugEnabled, toggleDebug } from "../debug.js";
import { saveViewLineNumbers, viewLineNumbers } from "../pluginSettings.js";
import { currentLayer } from "../keybindings/store.js";
import { currentThemeLabel } from "../themes.js";
import { clearStoredToken } from "../tokenStorage.js";

const globalStore = useGlobalStore();

// The All Notes badge: a live vault count rendered from the note index, with
// the list-details glyph as fallback before the index loads (or in an empty
// vault). Key-string lookup into ICON_PATHS's number-*-small family.
const noteCount = computed(() => globalStore.noteMeta.length);
const allNotesIcon = computed(() =>
  noteCount.value >= 100
    ? "tabNumber100Small"
    : noteCount.value > 0
      ? `tabNumber${noteCount.value}Small`
      : "tabViewList",
);
const menu = ref();
const route = useRoute();
const router = useRouter();
const themePickerVisible = ref(false);
const keybindingsVisible = ref(false);
const pluginSettingsVisible = ref(false);
const brandingVisible = ref(false);

const newNoteTarget = computed(() => {
  if (route.name === "search" && route.query[params.folder]) {
    return { name: "new", query: { folder: route.query[params.folder] } };
  }
  if (route.name === "note" && route.params.path) {
    const folder = directoryFromPath(route.params.path);
    return folder ? { name: "new", query: { folder } } : { name: "new" };
  }
  return { name: "new" };
});

defineProps({
  hideLogo: Boolean,
});

const emit = defineEmits(["toggleQuickSwitcher"]);

function openSearch() {
  emit("toggleQuickSwitcher");
}

const menuItems = computed(() => [
  {
    label: `Theme: ${currentThemeLabel.value}`,
    icon: tabDeviceDesktop,
    command: () => {
      themePickerVisible.value = true;
    },
  },
  {
    label: `Keybindings: ${currentLayer().label}`,
    icon: tabKeyboard,
    command: () => {
      keybindingsVisible.value = true;
    },
  },
  {
    label: "Plugins",
    icon: tabPlug,
    command: () => {
      pluginSettingsVisible.value = true;
    },
  },
  {
    label: "Branding",
    icon: tabPalette,
    command: () => {
      brandingVisible.value = true;
    },
    // Read-only deployments have nothing to brand — no dead affordance.
    visible: canModify,
  },
  {
    label: `Line numbers: ${viewLineNumbers.value ? "on" : "off"}`,
    icon: tabListNumbers,
    command: () => saveViewLineNumbers(!viewLineNumbers.value),
  },
  {
    label: `Debug: ${debugEnabled.value ? "on" : "off"}`,
    icon: tabConsole,
    command: () => toggleDebug(),
  },
  {
    separator: true,
    visible: showLogOutButton,
  },
  {
    label: "Log Out",
    icon: tabLogout,
    command: logOut,
    visible: showLogOutButton,
  },
]);

const showNewButton = computed(() => {
  return globalStore.config.authType !== authTypes.readOnly;
});

function logOut() {
  clearStoredToken();
  localStorage.clear();
  router.push({ name: "login" });
}

function toggleMenu(event) {
  menu.value.toggle(event);
}

function showLogOutButton() {
  return ![authTypes.none, authTypes.readOnly].includes(
    globalStore.config.authType,
  );
}

function canModify() {
  return globalStore.config.authType !== authTypes.readOnly;
}
</script>
