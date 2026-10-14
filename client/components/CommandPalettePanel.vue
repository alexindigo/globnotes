<template>
  <div ref="root" class="flex min-h-0 w-full flex-col p-3">
    <TextInput
      v-model="query"
      placeholder="Type a command…"
      @keydown="onKey"
    />
    <div class="mt-2 min-h-0 flex-1 overflow-y-auto">
      <div
        v-for="group in grouped"
        :key="group"
        class="mb-2"
      >
        <div class="mb-1 text-xs font-bold uppercase text-theme-text-very-muted">
          {{ group }}
        </div>
        <ul>
          <li
            v-for="entry in groupEntries(group)"
            :key="entry.topic"
            class="flex cursor-pointer items-center justify-between gap-3 rounded px-3 py-2"
            :class="{ 'bg-theme-background-elevated': entry.topic === selected }"
            @click="run(entry.topic)"
            @mousemove="selected = entry.topic"
          >
            <span class="min-w-0 flex-1 truncate text-theme-text">{{ entry.label }}</span>
            <span
              v-if="entry.hint"
              class="shrink-0 text-xs text-theme-text-muted"
            >{{ entry.hint }}</span>
          </li>
        </ul>
      </div>
      <div
        v-if="!results.length"
        class="px-3 py-4 text-center text-theme-text-muted"
      >
        No matching commands.
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";

import TextInput from "./TextInput.vue";
import { commandHint, commandRegistry } from "../commands.js";

const query = ref("");
const selected = ref("");
const root = ref();

const emit = defineEmits(["run"]);

const entries = computed(() =>
  commandRegistry.value.map((command) => ({
    topic: command.id,
    label: command.label,
    group: command.group,
    hint: commandHint(command.id),
  })),
);

const results = computed(() => {
  const q = query.value.trim().toLowerCase();
  return entries.value.filter(
    (e) => !q || `${e.group} ${e.label}`.toLowerCase().includes(q),
  );
});

const grouped = computed(() =>
  [...new Set(results.value.map((e) => e.group))],
);

function groupEntries(group) {
  return results.value.filter((e) => e.group === group);
}

watch(query, () => {
  selected.value = results.value[0]?.topic ?? "";
});

function move(delta) {
  if (!results.value.length) return;
  const flat = results.value.map((e) => e.topic);
  const i = flat.indexOf(selected.value);
  selected.value = flat[(i + delta + flat.length) % flat.length];
  nextTick(() => {
    const row = root.value?.querySelector("li.bg-theme-background-elevated");
    row?.scrollIntoView({ block: "nearest" });
  });
}

function run(topic) {
  query.value = "";
  emit("run", topic);
}

function runSelected() {
  if (selected.value) run(selected.value);
}

function onKey(e) {
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
    e.preventDefault();
    move(1);
  } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
    e.preventDefault();
    move(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    runSelected();
  }
}

function focus() {
  query.value = "";
  selected.value = results.value[0]?.topic ?? "";
}

defineExpose({ focus });
</script>
