<!-- SPDX-License-Identifier: LGPL-3.0-only -->

<!-- One presentational row template for the switcher: props in, markup
     out, no state. Every switcher item — note results and the pinned
     full-search row — renders through this component; copies are
     forbidden (the search row once drifted: it missed the active-pill
     highlight). Callers inject content via slots; active state and the
     pill highlight compute once per row here. -->

<template>
  <li
    class="switcher-row flex cursor-pointer items-center justify-between gap-3 rounded px-3 py-2"
    :class="{
      'bg-theme-background-elevated': active,
      'key-tag-active': active,
    }"
    @click="$emit('activate')"
    @mousemove="$emit('point')"
  >
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline justify-between gap-3">
        <span class="truncate text-theme-text">
          <slot name="title">{{ title }}</slot>
        </span>
      </div>
      <div class="mt-0.5 truncate text-xs text-theme-text-very-muted">
        <slot name="subtitle">{{ subtitle }}</slot>
      </div>
    </div>
    <span class="key-tag shrink-0" :title="hintTitle">{{ shortcut }}</span>
  </li>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: "" },
  shortcut: { type: String, required: true },
  hintTitle: { type: String, default: "" },
  active: { type: Boolean, default: false },
});

defineEmits(["activate", "point"]);
</script>

<style scoped>
/* Result shortcut hints — same visual language as the keybindings
   cheat-sheet key tags (mono, bordered, muted). The component owns the
   pill so every row shares one definition (the search row once drifted:
   it was a second hand-maintained copy and missed the active highlight). */
.key-tag {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid rgb(var(--theme-border));
  border-radius: 4px;
  background-color: rgb(var(--theme-background));
  color: rgb(var(--theme-text-very-muted));
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
    monospace;
  font-size: 10px;
  white-space: nowrap;
}
/* The active row's key pill plays the role of an icon — it follows the
   icon-hover convention (brand text + brand border). */
.key-tag-active .key-tag {
  border-color: rgb(var(--theme-brand));
  color: rgb(var(--theme-brand));
}
</style>
