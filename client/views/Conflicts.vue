<template>
  <main class="conflicts-page" aria-labelledby="conflicts-title">
    <template v-if="id">
      <RouterLink :to="conflictsTarget()" class="text-theme-brand hover:underline">Back to conflicts</RouterLink>
      <h1 id="conflicts-title" class="mt-4 mb-5 truncate text-3xl">Compare versions</h1>
      <p v-if="comparison.status === 'loading'" role="status">Loading comparison...</p>
      <p v-if="comparison.status === 'missing'" role="status">Conflict not found.</p>
      <p v-if="comparison.status === 'resolved'" role="status">This conflict was resolved elsewhere.</p>
      <div v-if="comparison.error" role="status" class="mb-4">
        <p>{{ comparison.error }}</p><button type="button" class="text-theme-brand" @click="controller.refresh">Retry</button>
      </div>
      <div v-if="comparison.reviewRequired" role="status" class="conflicts-page__notice">
        <p>These files changed. Review current versions before resolving.</p>
        <button type="button" class="text-theme-brand hover:underline" @click="controller.reviewCurrent">Review current versions</button>
      </div>
      <ConflictComparison v-if="comparison.pair && comparison.status === 'open'" :pair="comparison.pair" :original-href="comparison.originalHref" :copy-href="comparison.copyHref" />
    </template>
    <template v-else>
      <header class="mb-5 flex items-baseline gap-3">
        <h1 id="conflicts-title" class="truncate text-3xl">Conflicts</h1>
        <span v-if="list.total !== null" class="whitespace-nowrap text-sm">{{ list.total }} unresolved</span>
      </header>
      <p v-if="list.result" role="status" class="conflicts-page__notice">{{ list.result }}</p>
      <p v-if="list.loading && list.total === null" role="status">Loading conflicts...</p>
      <div v-if="list.error" role="status" class="mb-4">
        <p>{{ list.error }}</p><button type="button" class="text-theme-brand hover:underline" @click="inbox.refresh">Retry</button>
      </div>
      <p v-if="list.stale" role="status" class="mb-4 text-sm">This list and count are out of date.</p>
      <p v-if="list.total === 0 && !list.stale">No conflicts to resolve.</p>
      <ul class="conflicts-page__rows">
        <li v-for="row in list.rows" :key="row.id">
          <RouterLink :to="row.target" class="conflicts-page__row focus-ring">
            <span class="conflicts-page__path" :title="row.path">{{ row.path }}</span>
            <span class="conflicts-page__path" :title="row.copyPath">{{ row.copyPath }}</span>
            <span class="conflicts-page__row-meta"><span>{{ row.reasonLabel }}</span><time :datetime="row.createdAt">{{ row.createdLabel }}</time></span>
          </RouterLink>
        </li>
      </ul>
    </template>
  </main>
</template>
<script setup>
import { inject, onBeforeUnmount, onMounted, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { CONFLICT_INBOX } from "../conflictInbox.js";
import { createConflictResolutionController } from "../conflictResolutionController.js";
import { conflictsTarget } from "../conflictNavigation.js";
import ConflictComparison from "../components/ConflictComparison.vue";
const props = defineProps({ id: String });
const inbox = inject(CONFLICT_INBOX);
const router = useRouter();
const controller = createConflictResolutionController({ inbox, navigate: target => router.push(target) });
const comparison = controller.state, list = inbox.state;
watch(() => props.id, controller.select);
watch(() => list.generation, () => { controller.contextChanged(); controller.select(list.available ? props.id : null); });
onMounted(() => controller.mount(props.id));
onBeforeUnmount(controller.dispose);
</script>
<style scoped>
.conflicts-page { container-type: inline-size; min-width: 0; padding-bottom: 2rem; }
.conflicts-page__notice { margin-bottom: 1rem; padding: 1rem; border: 1px solid rgb(var(--theme-border)); border-radius: .375rem; background: rgb(var(--theme-background-elevated)); font-size: .875rem; }
.conflicts-page__rows { border-top: 1px solid rgb(var(--theme-border)); }
.conflicts-page__row { display: grid; gap: .5rem; padding: 1rem 0; border-bottom: 1px solid rgb(var(--theme-border)); min-width: 0; }
.conflicts-page__row:hover { color: rgb(var(--theme-brand)); }
.conflicts-page__path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conflicts-page__row-meta { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; font-size: .8rem; }
.conflicts-page__row-meta > * { white-space: nowrap; }
</style>
