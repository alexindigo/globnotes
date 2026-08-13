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
      <!-- New Note -->
      <RouterLink v-if="showNewButton" :to="newNoteTarget">
        <CustomButton :iconPath="mdilPlusCircle" label="New Note" />
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
    <PrimeMenu ref="menu" :model="menuItems" :popup="true" />
    <ThemePicker v-model="themePickerVisible" />
  </div>
</template>

<script setup>
import {
  mdilLogout,
  mdilMagnify,
  mdilMenu,
  mdilMonitor,
  mdilNoteMultiple,
  mdilPlusCircle,
} from "@mdi/light-js";
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import CustomButton from "../components/CustomButton.vue";
import Logo from "../components/Logo.vue";
import PrimeMenu from "../components/PrimeMenu.vue";
import ThemePicker from "../components/ThemePicker.vue";
import { authTypes, params, searchSortOptions } from "../constants.js";
import { useGlobalStore } from "../globalStore.js";
import { directoryFromTitle } from "../helpers.js";
import { currentThemeLabel } from "../themes.js";
import { clearStoredToken } from "../tokenStorage.js";

const globalStore = useGlobalStore();
const menu = ref();
const route = useRoute();
const router = useRouter();
const themePickerVisible = ref(false);

const newNoteTarget = computed(() => {
  if (route.name === "search" && route.query[params.folder]) {
    return { name: "new", query: { folder: route.query[params.folder] } };
  }
  if (route.name === "note" && route.params.title) {
    const folder = directoryFromTitle(route.params.title);
    return folder ? { name: "new", query: { folder } } : { name: "new" };
  }
  return { name: "new" };
});

defineProps({
  hideLogo: Boolean,
});

const emit = defineEmits(["toggleSearchModal"]);

const menuItems = computed(() => [
  {
    label: "Search",
    icon: mdilMagnify,
    command: () => emit("toggleSearchModal"),
    keyboardShortcut: "/",
  },
  {
    label: "All Notes",
    icon: mdilNoteMultiple,
    command: () =>
      router.push({
        name: "search",
        query: {
          [params.searchTerm]: "*",
          [params.sortBy]: searchSortOptions.title,
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
  return ![authTypes.none, authTypes.readOnly].includes(globalStore.config.authType);
}
</script>
