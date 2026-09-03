<template>
  <template v-if="visible">
    <!-- Invisible click-catcher: no dimming, so the app stays previewable -->
    <div class="fixed inset-0 z-40" @click="close" />
    <div
      class="fixed right-4 top-16 z-50 flex max-h-[70vh] w-[35rem] flex-col rounded-lg border border-theme-border bg-theme-background shadow-lg"
    >
      <div
        class="flex items-center justify-between border-b border-theme-border px-3 py-2"
      >
        <span class="text-xs font-bold uppercase text-theme-text-very-muted">
          Keybindings
        </span>
        <CustomButton
          :iconPath="tabClose"
          label=""
          title="Close"
          @click="close"
        />
      </div>

      <!-- Rail (layers) + cheat-sheet content -->
      <div class="flex min-h-0 flex-1">
        <div
          class="w-44 shrink-0 overflow-y-auto border-r border-theme-border p-2"
        >
          <KeybindingPicker />
        </div>
        <div class="min-w-0 flex-1 overflow-y-auto p-2">
          <p class="px-1 pb-2 text-xs text-theme-text-very-muted">
            {{ activeLayerMeta.description }}
          </p>
          <div
            v-if="isCustomLayer()"
            class="px-1 pb-2 text-xs text-theme-text-very-muted"
          >
            Click a binding to remap it (press Escape to cancel). Changes are
            stored in this browser.
          </div>

          <!-- Cheat sheet for the active layer, grouped by action kind -->
          <section v-for="group in groupedBindings" :key="group.name">
            <div
              class="px-1 pb-1 pt-2 text-[10px] font-bold uppercase text-theme-text-very-muted"
            >
              {{ group.name }}
            </div>
            <div
              v-for="row in group.rows"
              :key="row.action"
              class="flex items-center justify-between rounded px-1 py-0.5 hover:bg-theme-background-elevated"
            >
              <span class="text-xs text-theme-text">{{ row.label }}</span>
              <span class="flex items-center gap-1">
                <span
                  v-if="row.modified"
                  class="h-1.5 w-1.5 rounded-full bg-theme-brand"
                  title="Modified in Custom"
                />
                <button
                  v-if="isCustomLayer()"
                  type="button"
                  class="rounded border border-theme-border bg-theme-background px-1.5 py-0.5 font-mono text-[10px] text-theme-text hover:border-theme-brand"
                  :title="capturing === row.action ? 'Press a key…' : 'Click to remap'"
                  @click="startCapture(row.action)"
                >
                  {{ capturing === row.action ? "Press a key…" : row.display }}
                </button>
                <span
                  v-else
                  class="rounded border border-theme-border bg-theme-background px-1.5 py-0.5 font-mono text-[10px] text-theme-text"
                >
                  {{ row.display }}
                </span>
                <button
                  v-if="isCustomLayer() && row.modified"
                  type="button"
                  class="px-1 text-theme-text-muted hover:text-theme-text"
                  title="Reset to base binding"
                  @click="resetBinding(row.action)"
                >
                  ↺
                </button>
              </span>
            </div>
          </section>
        </div>
      </div>
    </div>
  </template>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from "vue";

import { tabClose } from "../icons.js";
import CustomButton from "./CustomButton.vue";
import KeybindingPicker from "./KeybindingPicker.vue";
import { effectiveBindings, isCustomLayer, customOverridesMap, removeCustomBinding, setCustomBinding, currentLayer } from "../keybindings/store.js";
import {
  ACTIONS,
  CUSTOM_BASE_LAYER_ID,
  LAYERS,
} from "../keybindings/layers.js";
import { isMac } from "../keybindings/keys.js";

const visible = defineModel({ type: Boolean });

function close() {
  visible.value = false;
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

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  stopCapture();
});

// --- Cheat-sheet rows -----------------------------------------------------

const activeLayerMeta = computed(() => currentLayer());

const GROUP_ORDER = ["Editing", "Formatting", "App"];

const groupedBindings = computed(() => {
  const bindings = effectiveBindings();
  const overrides = customOverridesMap();
  const base = LAYERS[CUSTOM_BASE_LAYER_ID].bindings;
  const groups = GROUP_ORDER.map((name) => ({ name, rows: [] }));
  for (const [action, binding] of Object.entries(bindings)) {
    const meta = ACTIONS[action];
    if (!meta) continue;
    const group = groups.find((g) => g.name === meta.group) ?? groups[0];
    group.rows.push({
      action,
      label: meta.label,
      display: displayBinding(binding),
      modified:
        isCustomLayer() &&
        JSON.stringify(base[action]) !== JSON.stringify(binding) &&
        action in overrides,
    });
  }
  return groups.filter((g) => g.rows.length);
});

function displayBinding(binding) {
  // The platform is known: show only the keys that work on this machine
  // (the data still carries both — the dispatcher/editor keymaps resolve
  // per-platform at bind time).
  const primary = isMac() ? binding.mac : binding.other;
  return binding.alias
    ? `${primary} or ${displayBinding(binding.alias)}`
    : primary;
}

// --- Custom-layer per-binding remapping ------------------------------------

const capturing = ref(null);

function startCapture(action) {
  if (!isCustomLayer() || capturing.value) return;
  capturing.value = action;
  // Capture phase on window, ahead of Mousetrap (document bubble), so the
  // captured key never triggers live bindings.
  window.addEventListener("keydown", captureKeydown, true);
}

function stopCapture() {
  capturing.value = null;
  window.removeEventListener("keydown", captureKeydown, true);
}

function captureKeydown(event) {
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    stopCapture();
    return;
  }
  const binding = bindingFromEvent(event);
  if (binding) {
    setCustomBinding(capturing.value, binding);
    stopCapture();
  }
}

/** Translate a captured keydown into a `{ mac, other }` binding. */
function bindingFromEvent(event) {
  if (event.key.length !== 1 && !NAMED_KEYS.has(event.key)) return null;
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.metaKey) parts.push("Cmd");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  const mac = parts.join("+");
  const other = isMac() ? mac.replace("Cmd+", "Ctrl+") : mac;
  return { mac, other };
}

const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

function resetBinding(action) {
  removeCustomBinding(action);
}
</script>
