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
      <!-- Search (unified jump + full-text) -->
      <CustomButton
        :iconPath="mdiMagnify"
        title="Search"
        @click="openSearch"
      />
      <!-- New Note -->
      <RouterLink v-if="showNewButton" :to="newNoteTarget">
        <CustomButton :iconPath="mdiSquareEditOutline" title="New note" />
      </RouterLink>
    </div>
  </nav>

  <!-- Floating corner menu (matches the sidebar toggle treatment) -->
  <div class="fixed right-4 top-4 z-30">
    <CustomButton
      :iconPath="mdilMenu"
      label=""
      style="cta"
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
    <PluginSettings v-model="pluginSettingsVisible" />
  </div>
</template>

<script setup>
import { mdiMagnify, mdiSquareEditOutline } from "@mdi/js";
import {
  mdilConsole,
  mdilFormatListNumbers,
  mdilLogout,
  mdilMenu,
  mdilMonitor,
  mdilNoteMultiple,
} from "@mdi/light-js";
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import { publish, TOPICS } from "../bus/index.js";
import CustomButton from "../components/CustomButton.vue";
import Logo from "../components/Logo.vue";
import PluginSettings from "../components/PluginSettings.vue";
import PrimeMenu from "../components/PrimeMenu.vue";
import ThemePicker from "../components/ThemePicker.vue";
import { authTypes, params, searchSortOptions } from "../constants.js";
import { useGlobalStore } from "../globalStore.js";
import { directoryFromPath } from "../helpers.js";
import { debugEnabled, toggleDebug } from "../debug.js";
import { saveViewLineNumbers, viewLineNumbers } from "../pluginSettings.js";
import { currentThemeLabel } from "../themes.js";
import { clearStoredToken } from "../tokenStorage.js";

const globalStore = useGlobalStore();
const menu = ref();
const route = useRoute();
const router = useRouter();
const themePickerVisible = ref(false);
const pluginSettingsVisible = ref(false);

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
    label: "All Notes",
    icon: mdilNoteMultiple,
    command: () =>
      router.push({
        name: "search",
        query: {
          [params.searchTerm]: "*",
          [params.sortBy]: searchSortOptions.path,
        },
      }),
  },
  {
    label: `Theme: ${currentThemeLabel.value}`,
    icon: mdilMonitor,
    command: () => {
      themePickerVisible.value = true;
    },
  },
  {
    label: "Plugins",
    icon: mdilMonitor,
    command: () => {
      pluginSettingsVisible.value = true;
    },
  },
  {
    label: `Line numbers: ${viewLineNumbers.value ? "on" : "off"}`,
    icon: mdilFormatListNumbers,
    command: () => saveViewLineNumbers(!viewLineNumbers.value),
  },
  {
    label: `Debug: ${debugEnabled.value ? "on" : "off"}`,
    icon: mdilConsole,
    command: () => toggleDebug(),
  },
  {
    separator: true,
    visible: showLogOutButton,
  },
  {
    label: "Log Out",
    icon: mdilLogout,
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
</script>
