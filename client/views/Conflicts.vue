<template>
  <main class="conflicts-page" aria-labelledby="conflicts-title">
    <template v-if="id">
      <RouterLink :to="conflictsTarget()" class="text-theme-brand hover:underline">Back to conflicts</RouterLink>
      <h1 id="conflicts-title" class="mt-4 mb-5 truncate text-3xl">Compare versions</h1>
      <p v-if="comparison.status === 'loading'" role="status">Loading comparison...</p>
      <p v-if="comparison.status === 'missing'" role="status">Conflict not found.</p>
      <p v-if="comparison.resolvedElsewhere" role="status">This conflict was resolved elsewhere.</p>
      <div v-if="comparison.error" role="status" class="mb-4">
        <p>{{ comparison.error }}</p><button type="button" class="text-theme-brand" @click="controller.refresh">Retry</button>
      </div>
      <div v-if="comparison.reviewRequired" role="status" class="conflicts-page__notice">
        <p>These files changed. Review current versions before resolving.</p>
        <button type="button" class="text-theme-brand hover:underline" @click="controller.reviewCurrent">Review current versions</button>
      </div>
      <p v-if="comparison.message" role="status" class="conflicts-page__notice" :aria-busy="comparison.busy">{{ comparison.message }}</p>
      <ConflictComparison v-if="comparison.pair && comparison.status === 'open'" :pair="comparison.pair" :original-href="comparison.originalHref" :copy-href="comparison.copyHref" :on-open="controller.followFile" />
      <div v-if="comparison.recovered" class="conflicts-page__notice" role="status">
        <p>A browser merge draft is available. Resume it for review, or discard only this local draft.</p>
        <div class="conflicts-page__actions">
          <button type="button" class="conflicts-page__button" @click="controller.resumeDraft">Resume draft</button>
          <button type="button" class="conflicts-page__button" @click="controller.discard">Discard draft</button>
        </div>
      </div>
      <section v-if="comparison.merge" class="conflicts-page__merge" aria-labelledby="merge-label">
        <label id="merge-label" for="conflict-merge">Manual merge</label>
        <p v-if="comparison.pair && comparison.status === 'open'">Save at <span :title="comparison.pair.original.path">{{ comparison.pair.original.path }}</span>; remove <span :title="comparison.pair.copy.path">{{ comparison.pair.copy.path }}</span>.</p>
        <textarea id="conflict-merge" :value="comparison.draft" :readonly="comparison.busy || comparison.authenticationRequired || comparison.status !== 'open'" spellcheck="false" @input="controller.setDraft($event.target.value)" />
      </section>
      <div v-if="comparison.status === 'open' || comparison.merge" class="conflicts-page__actions" aria-label="Conflict actions">
        <template v-if="comparison.canKeep">
          <button type="button" class="conflicts-page__button" @click="controller.choose('original')">Keep original</button>
          <button type="button" class="conflicts-page__button" @click="controller.choose('copy')">Keep conflict copy</button>
          <button type="button" class="conflicts-page__button" @click="controller.choose('both')">Keep both</button>
        </template>
        <button v-if="comparison.canMerge" type="button" class="conflicts-page__button" @click="controller.editMerge">Edit a merge</button>
        <button v-if="comparison.canSaveMerge" type="button" class="conflicts-page__button conflicts-page__button--primary" @click="controller.choose('merge')">Save merge</button>
        <button v-if="comparison.merge && !comparison.busy && !comparison.unknown && !comparison.authenticationRequired" type="button" class="conflicts-page__button" @click="controller.cancelMerge">Cancel merge</button>
        <button v-if="!comparison.busy && !comparison.unknown && !comparison.authenticationRequired" type="button" class="conflicts-page__button" @click="controller.back">Postpone</button>
        <button v-if="comparison.unknown && !comparison.reviewRequired" type="button" class="conflicts-page__button" @click="controller.reviewCurrent">Review current versions</button>
      </div>
      <ConfirmModal v-if="comparison.confirmation" :model-value="true" title="Resolve conflict" :message="comparison.confirmation.message" :confirm-button-text="comparison.confirmation.label" confirm-button-style="danger" action-layout="grouped" @confirm="controller.confirmResolution(comparison.confirmation.identity)" @cancel="controller.cancelConfirmation" />
      <ConfirmModal v-if="comparison.decision" :model-value="true" title="Merge draft" :message="comparison.decision.message" :confirm-button-text="comparison.decision.canSave ? 'Save merge' : 'Discard draft'" :reject-button-text="comparison.decision.canSave ? 'Discard draft' : undefined" action-layout="grouped" @confirm="controller.onDecision(comparison.decision.canSave ? 'save' : 'discard')" @reject="controller.onDecision('discard')" @cancel="controller.onDecision('cancel')" />
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
            <span class="conflicts-page__row-meta"><span>{{ row.reasonLabel }}</span><span v-if="row.sourceLabel">{{ row.sourceLabel }}</span><time :datetime="row.createdAt">{{ row.createdLabel }}</time></span>
          </RouterLink>
        </li>
      </ul>
    </template>
  </main>
</template>
<script setup>
import { inject, onBeforeUnmount, onMounted, watch } from "vue";
import { RouterLink, onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from "vue-router";
import { CONFLICT_INBOX } from "../conflictInbox.js";
import { createConflictResolutionController } from "../conflictResolutionController.js";
import { conflictsTarget } from "../conflictNavigation.js";
import ConflictComparison from "../components/ConflictComparison.vue";
import ConfirmModal from "../components/ConfirmModal.vue";
import { useGlobalStore } from "../globalStore.js";
import { authTypes } from "../constants.js";
const props = defineProps({ id: String });
const inbox = inject(CONFLICT_INBOX);
const router = useRouter();
const globalStore = useGlobalStore();
const controller = createConflictResolutionController({ inbox, navigate: target => router.push(target),
  getContext: () => ({ writable: globalStore.config.authType !== authTypes.readOnly }) });
const comparison = controller.state, list = inbox.state;
watch(() => props.id, controller.select);
watch(() => list.generation, () => { controller.contextChanged(); controller.select(list.available ? props.id : null); });
onMounted(() => controller.mount(props.id));
onBeforeUnmount(controller.dispose);
onBeforeRouteUpdate(controller.gateNavigation);
onBeforeRouteLeave(controller.gateNavigation);
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
.conflicts-page__actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1rem; }
.conflicts-page__button { padding: .5rem .75rem; border: 1px solid rgb(var(--theme-border)); border-radius: .375rem; white-space: nowrap; font-size: .875rem; }
.conflicts-page__button:hover { background: rgb(var(--theme-background-elevated)); }
.conflicts-page__button:focus-visible, .conflicts-page__merge textarea:focus-visible { outline: 2px solid rgb(var(--theme-brand)); outline-offset: 2px; }
.conflicts-page__button--primary { background: rgb(var(--theme-brand)); color: white; }
.conflicts-page__merge { margin-top: 1.5rem; display: grid; gap: .75rem; min-width: 0; }
.conflicts-page__merge label { white-space: nowrap; font-weight: 600; }
.conflicts-page__merge p { overflow-wrap: anywhere; font-size: .875rem; }
.conflicts-page__merge textarea { width: 100%; min-height: 16rem; padding: 1rem; border: 1px solid rgb(var(--theme-border)); border-radius: .375rem; background: rgb(var(--theme-background)); color: rgb(var(--theme-text)); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: .875rem; line-height: 1.6; }
</style>
