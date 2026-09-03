<template>
  <div class="flex flex-wrap gap-1">
    <button
      v-for="layer in selectableLayers"
      :key="layer.id"
      type="button"
      class="rounded px-2 py-1 text-left text-xs"
      :class="{
        'bg-theme-brand text-theme-background':
          layer.id === currentLayerId,
        'bg-theme-background-elevated text-theme-text-muted hover:text-theme-text':
          layer.id !== currentLayerId,
      }"
      :title="layer.description"
      @click="setLayer(layer.id)"
    >
      {{ layer.label }}
    </button>
  </div>
</template>

<script setup>
import {
  CUSTOM_LAYER_ID,
  LAYER_ORDER,
  LAYERS,
} from "../keybindings/layers.js";
import { currentLayerId, setLayer } from "../keybindings/store.js";

/** The five named layers + Custom, in cheat-sheet picker order. */
const selectableLayers = LAYER_ORDER.map((id) =>
  id === CUSTOM_LAYER_ID
    ? {
        id,
        label: "Custom",
        description:
          "Starts as a copy of Legacy; edit bindings below. Overrides " +
          "are stored in this browser.",
      }
    : LAYERS[id],
);
</script>
