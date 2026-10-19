<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="settings-actions" data-settings-actions>
    <div v-if="$slots.start" class="settings-actions-start" data-settings-actions-start><slot name="start" /></div>
    <div class="settings-actions-end" data-settings-actions-end><slot name="end"><slot /></slot></div>
  </div>
</template>
<style scoped>
.settings-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:1.5rem; min-width:0; }
.settings-actions-start, .settings-actions-end { display:flex; flex-wrap:wrap; align-items:stretch; gap:1rem; min-width:0; }
.settings-actions-start { margin-inline-end:auto; }
.settings-actions-end { justify-content:flex-end; }
</style>
