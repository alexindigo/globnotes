<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="settings-actions" data-settings-actions :class="{ 'settings-actions-paired': $slots.start && $slots.end }">
    <div v-if="$slots.start" class="settings-actions-zone" data-settings-actions-start><slot name="start" /></div>
    <div v-if="$slots.end" class="settings-actions-zone settings-actions-end" data-settings-actions-end><slot name="end" /></div>
  </div>
</template>

<style scoped>
.settings-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  column-gap: 1rem;
  align-items: start;
  min-width: 0;
}
.settings-actions-paired {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.settings-actions-zone {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
}
.settings-actions-end {
  align-items: flex-end;
}
</style>
