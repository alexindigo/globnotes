<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section :aria-label="heading" class="plugin-permission-hosts">
    <h4 class="font-semibold text-theme-text">{{ heading }}</h4>
    <p class="mt-1 text-xs text-theme-text-muted">{{ kind === 'imports' ? 'Remote code executes in the server Worker. Network data approval does not approve these imports.' : 'Data-network access is separate from remote-code imports.' }}</p>
    <p v-if="!rows.length" class="mt-2 text-sm text-theme-text-muted">No requested or remembered {{ kind === 'imports' ? 'import' : 'network' }} hosts.</p>
    <div v-for="row in rows" :key="key(row.scope)" class="mt-2 rounded border border-theme-border p-3" :data-permission-kind="kind" :data-permission-scope="key(row.scope)">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="break-all font-medium text-theme-text">{{ label(row.scope) }}</div>
          <div class="text-sm" :class="row.effective ? 'text-theme-success' : 'text-theme-text-muted'">{{ status(row) }}</div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <CustomButton v-if="row.requested && !row.approved" label="Approve" :disabled="disabled" @click="onApprove(row.scope)" />
          <CustomButton v-if="row.approved" label="Delete approval" :disabled="disabled" @click="onDelete(row)" />
        </div>
      </div>
      <p v-if="row.sources.length" class="mt-1 text-xs text-theme-text-muted">Requested by: {{ row.sources.map(sourceLabel).join(', ') }}</p>
      <p v-if="row.approvalCoverage.length" class="mt-1 text-xs text-theme-text-muted">Approval coverage: {{ row.approvalCoverage.map(label).join(', ') }}.</p>
      <p v-if="row.scope.type === 'all'" class="mt-1 text-sm text-theme-warning">All hosts and all ports. Broad approval requires a separate explicit confirmation.</p>
      <p v-if="row.blockedReasons.includes('parent-unavailable')" class="mt-1 text-sm text-theme-warning">Approved, but unavailable under the server's existing parent permissions.</p>
    </div>
  </section>
</template>
<script setup>
import CustomButton from "./CustomButton.vue";
const props = defineProps({ kind: String, heading: String, rows: { type: Array, default: () => [] }, disabled: Boolean, onApprove: { type: Function, required: true }, onDelete: { type: Function, required: true } });
const key = scope => scope.type === "all" ? "all" : `host:${scope.authority}`;
function label(scope) {
  if (scope.type === "all") return "All hosts";
  const match = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(scope.authority);
  return match?.[2] ? scope.authority : `${scope.authority} (all ports on this host)`;
}
function status(row) {
  if (!row.approved) return "Unapproved";
  if (row.effective) return "Approved — effective";
  if (row.blockedReasons.includes("master-off")) return "Approved — Allow network is off";
  if (row.blockedReasons.includes("parent-unavailable")) return "Approved — parent unavailable";
  return "Remembered approval — not currently requested at this breadth";
}
const sourceLabel = source => source === "legacy" ? "legacy request intent" : source;
</script>
