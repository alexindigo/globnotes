<template>
  <RouterLink v-if="snapshot.available" :to="conflictsTarget()" class="conflict-badge focus-ring" :aria-label="snapshot.label" :title="snapshot.label" data-conflict-badge>
    <span class="conflict-badge__icon"><Icon :icon="splitFile" size="1.25em" /></span>
    <span v-if="snapshot.total > 0" class="conflict-badge__count">{{ snapshot.total }}</span>
    <span v-if="snapshot.stale" class="sr-only">Count out of date</span>
  </RouterLink>
</template>
<script setup>
import { RouterLink } from "vue-router";
import Icon from "./Icon.vue";
import { conflictsTarget } from "../conflictNavigation.js";
defineProps({ snapshot: { type: Object, required: true } });
const splitFile = ["M8 3h-2a2 2 0 0 0 -2 2v14a2 2 0 0 0 2 2h2", "M16 3h2a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-2", "M12 3v18", "M7 8h1", "M16 8h1", "M7 12h1", "M16 12h1"];
</script>
<style scoped>
.conflict-badge { display: inline-flex; align-items: center; border-radius: .25rem; color: rgb(var(--theme-text)); }
.conflict-badge:hover { background: rgb(var(--theme-background-elevated)); color: rgb(var(--theme-brand)); }
.conflict-badge__icon { display: grid; place-items: center; width: 2.25rem; height: 2.25rem; }
.conflict-badge__count { margin-inline-end: .5rem; min-width: 1.25rem; padding: .125rem .25rem; border-radius: .25rem; background: rgb(var(--theme-background-elevated)); font-size: .75rem; text-align: center; }
</style>
