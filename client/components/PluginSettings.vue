<template>
  <Modal v-model="isVisible">
    <div class="p-4">
      <div class="mb-3 text-lg font-bold text-theme-text">Plugins</div>
      <div class="max-h-96 overflow-y-auto">
        <div class="mb-3 flex items-center justify-between">
          <div>
            <div class="text-theme-text">Auto-enable new plugins</div>
            <div class="text-sm text-theme-text-muted">
              Plugins you haven't switched are
              {{ autoEnable ? "on" : "off" }} by default.
            </div>
          </div>
          <Toggle :isOn="autoEnable" @click="toggleAutoEnable" />
        </div>
        <div
          v-for="plugin in plugins"
          :key="plugin.id"
          class="flex items-center justify-between border-t border-theme-border py-2"
        >
          <div>
            <div class="text-theme-text">{{ plugin.name }}</div>
            <div class="text-sm text-theme-text-muted">
              {{ plugin.id }} · v{{ plugin.version }}
            </div>
          </div>
          <Toggle :isOn="plugin.enabled" @click="togglePlugin(plugin)" />
        </div>
        <p v-if="!plugins.length" class="py-4 text-sm text-theme-text-muted">
          No plugins installed.
        </p>
      </div>
    </div>
  </Modal>
</template>

<script setup>
import { ref, watch } from "vue";

import { getPlugins } from "../api.js";
import Modal from "./Modal.vue";
import Toggle from "./Toggle.vue";
import {
  loadAutoEnable,
  loadSwitches,
  saveAutoEnable,
  saveSwitch,
} from "../pluginSettings.js";

const isVisible = defineModel({ type: Boolean });

const plugins = ref([]);
const autoEnable = ref(true);

watch(isVisible, async (visible) => {
  if (!visible) return;
  autoEnable.value = loadAutoEnable();
  const switches = loadSwitches();
  plugins.value = (await getPlugins()).map((p) => ({
    ...p,
    enabled: switches[p.id] ?? autoEnable.value,
  }));
});

function toggleAutoEnable() {
  autoEnable.value = !autoEnable.value;
  saveAutoEnable(autoEnable.value);
  // Unswitched plugins follow the new default.
  const switches = loadSwitches();
  for (const p of plugins.value) {
    p.enabled = switches[p.id] ?? autoEnable.value;
  }
}

function togglePlugin(plugin) {
  plugin.enabled = !plugin.enabled;
  saveSwitch(plugin.id, plugin.enabled);
}
</script>
