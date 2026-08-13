<template>
  <template v-if="visible">
    <!-- Invisible click-catcher: no dimming, so the app stays previewable -->
    <div class="fixed inset-0 z-40" @click="close" />
    <div
      class="fixed right-4 top-16 z-50 flex max-h-[70vh] w-64 flex-col rounded-lg border border-theme-border bg-theme-background shadow-lg"
    >
      <div
        class="flex items-center justify-between border-b border-theme-border px-3 py-2"
      >
        <span class="text-xs font-bold uppercase text-theme-text-very-muted">
          Theme
        </span>
        <CustomButton
          :iconPath="mdiClose"
          label=""
          title="Close"
          @click="close"
        />
      </div>
      <div class="overflow-y-auto p-1">
        <button
          v-for="theme in THEMES"
          :key="theme.id"
          class="flex w-full cursor-pointer items-center rounded px-2 py-1 text-left text-theme-text-muted hover:bg-theme-background-elevated"
          :class="{
            'bg-theme-background-elevated text-theme-text':
              theme.id === currentTheme,
          }"
          @click="setTheme(theme.id)"
        >
          <span
            class="mr-2 h-3 w-3 shrink-0 rounded-full border border-theme-border"
            :style="{ backgroundColor: swatch(theme) }"
          ></span>
          <span class="truncate">{{ theme.label }}</span>
        </button>
      </div>
    </div>
  </template>
</template>

<script setup>
import { onUnmounted, ref, watch } from "vue";

import { mdiClose } from "@mdi/js";
import CustomButton from "./CustomButton.vue";
import {
  currentTheme,
  GLOBNOTES_DARK,
  GLOBNOTES_LIGHT,
  setTheme,
  THEMES,
} from "../themes.js";

const visible = defineModel({ type: Boolean });

function close() {
  visible.value = false;
}

function swatch(theme) {
  if (!theme.mode) {
    return undefined;
  }
  const defaults = theme.mode === "dark" ? GLOBNOTES_DARK : GLOBNOTES_LIGHT;
  return theme.colors.brand || defaults.brand;
}

function onKeydown(event) {
  if (event.key === "Escape") {
    close();
  }
}

watch(visible, (isVisible) => {
  if (isVisible) {
    window.addEventListener("keydown", onKeydown);
  } else {
    window.removeEventListener("keydown", onKeydown);
  }
});

onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>
