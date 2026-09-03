<template>
  <nav class="flex flex-col gap-0.5" aria-label="Keybinding layers">
    <button
      v-for="layer in selectableLayers"
      :key="layer.id"
      type="button"
      class="w-full rounded px-2 py-1 text-left text-xs"
      :class="{
        'bg-theme-background-elevated text-theme-text':
          layer.id === currentLayerId,
        'text-theme-text-muted hover:bg-theme-background-elevated/60 hover:text-theme-text':
          layer.id !== currentLayerId,
      }"
      :title="layer.description"
      :aria-current="layer.id === currentLayerId ? 'true' : undefined"
      @click="setLayer(layer.id)"
    >
      {{ layer.label }}
    </button>
  </nav>
</template>

<script setup>
import {
  CUSTOM_LAYER_ID,
  LAYER_ORDER,
  LAYERS,
} from "../keybindings/layers.js";
import { currentLayerId, setLayer } from "../keybindings/store.js";

/** The five named layers + Custom, as flat rail rows (Custom last). */
const selectableLayers = LAYER_ORDER.map((id) =>
  id === CUSTOM_LAYER_ID
    ? {
        id,
        label: "Custom",
        description:
          "Starts as a copy of Legacy; edit bindings in the cheat sheet. " +
          "Overrides are stored in this browser.",
      }
    : LAYERS[id],
);
</script>
