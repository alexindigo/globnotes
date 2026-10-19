<!-- SPDX-License-Identifier: LGPL-3.0-only -->

<template>
  <Modal
    ref="modal"
    v-model="isVisible"
    name="settings"
    anchor="viewport-center"
    scroll="content"
    class="!mx-1 !w-full [--settings-inline-inset:1rem] sm:!mx-4 sm:!w-[80dvw]"
    labelledby="settings-modal-title"
    trap-focus
    :keydown-handler="core.captureKey"
    :close-handler-override="requestClose"
  >
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-center justify-between gap-2 border-b border-theme-border py-3 [padding-inline:var(--settings-inline-inset)]">
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h2
            id="settings-modal-title"
            class="text-lg font-semibold text-theme-text"
          >Settings</h2>
          <span
            v-if="versionLabel"
            data-app-version
            class="min-w-0 max-w-full truncate text-xs text-theme-text-muted"
          >{{ versionLabel }}</span>
        </div>
        <CustomButton
          type="button"
          variant="text"
          class="shrink-0"
          aria-label="Close settings"
          :icon-path="tabClose"
          @click="requestClose"
        />
      </div>
      <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
        <SettingsNav :groups="groupedPages" :attention-items="attentionItems" :on-select="selectPage" />
        <div class="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6" data-settings-content :data-settings-current-page="currentPageId">
          <SettingsPage v-if="currentPage?.kind === 'unsupported'" :title="pluginPageHeader.title" :description="pluginPageHeader.description">
            <template #action><CustomButton type="button" label="Manage in Plugins" variant="text" @click="managePlugin(currentPage.owner)" /></template>
            <SettingsTabs :pages="pluginPageHeader.pages" :selected="currentPageId" :on-select="selectPage">
            <p class="text-sm text-theme-danger">
              This settings page uses an unsupported renderer
              ({{ currentPage.renderer?.kind }}). It cannot be displayed in
              this version of globnotes.
            </p>
            </SettingsTabs>
          </SettingsPage>
          <SettingsPage v-else-if="currentPage?.kind === 'plugin-page'" :title="pluginPageHeader.title" :description="pluginPageHeader.description">
          <template #action><CustomButton type="button" label="Manage in Plugins" variant="text" @click="managePlugin(currentPage.owner)" /></template>
          <SettingsTabs :pages="pluginPageHeader.pages" :selected="currentPageId" :on-select="selectPage">
          <DeclarativeSettingsPage
            :key="currentPageId"
            :page="currentPage.descriptor"
            :snapshot="currentSnapshot"
            :on-browse="field=>browseField(currentPageId,field)"
            @edit="pageState.edit(currentPageId, $event.key, $event.raw)"
            @commit="pageState.commit(currentPageId, $event)"
            @reload="reloadCurrentPage"
            @retry="pageState.retry(currentPageId)"
          />
          </SettingsTabs>
          </SettingsPage>
          <SettingsPage v-else-if="currentPage" :title="currentPage.label" :description="currentPage.description">
            <!-- Appearance: the theme list content (values + callbacks;
             the legacy popup wrapper is not rendered here). -->
            <AppearanceSettingsPage v-if="currentPage.preference === 'appearance'" :snapshot="appearanceSnapshot" :selected="core.currentTheme.value" :on-select="core.setTheme" />
            <KeybindingsSettingsPage v-else-if="currentPage.preference === 'keybindings'" :layers="core.layers" :snapshot="keybindingSnapshot" :on-layer="core.setLayer" :on-capture="core.startCapture" :on-reset="core.resetBinding" />
            <BrandingSettingsPage v-else-if="currentPage.kind === 'branding'" :snapshot="brandingSnapshot" :on-edit="core.editBrand" :on-clear-accent="core.clearAccent" :on-pick-file="core.chooseFile" :on-discard-file="core.discardFile" :on-remove-file="core.removeFile" :on-save="()=>core.saveBrand()" :on-reset="resetCoreBranding" :on-review="core.reviewBrand" :on-cancel="session.cancelBranding" />
            <!-- Plugins: vault-owned inventory + enablement (the old
             localStorage switches are legacy preferences, shown once). -->
            <PluginInventorySettingsPage v-else-if="currentPage.kind === 'plugins'"
              :rows="pluginRows" :auto-enable="autoEnableView" :on-expansion="toggleExpansion"
              :on-open-page="selectPage" :on-auto-enable="toggleAutoEnable" :on-enabled="togglePluginRow"
              :on-policy-review="inventory.review" :on-policy-retry="inventory.retry" :on-policy-discard="discardInventoryChoice"
              :on-master="session.togglePermissionMaster" :on-host="session.permissionHostAction"
              :on-review="permissions.review" :on-retry="permissions.retry" :on-discard="discardPermission" />
            <SettingRow v-else-if="currentPage.preference === 'editor'" label="Line numbers when reading" help="Show line numbers beside code blocks when reading notes. This preference is stored in this browser." short v-slot="row">
              <Toggle :id="row.id" :aria-labelledby="row.labelledby" :aria-describedby="row.describedby" :is-on="core.viewLineNumbers.value" @click="session.toggleLineNumbers" />
            </SettingRow>
            <SettingRow v-else-if="currentPage.preference === 'diagnostics'" label="Debug notifications" help="Show diagnostic notifications in this browser while investigating a problem." short v-slot="row">
              <Toggle :id="row.id" :aria-labelledby="row.labelledby" :aria-describedby="row.describedby" :is-on="core.debugEnabled.value" @click="session.toggleDebug" />
            </SettingRow>
            <div v-else-if="currentPage.kind === 'access'" class="flex flex-col gap-4" data-access-summary>
              <p v-if="accessSummary.loading" role="status" class="text-[13px] text-theme-text-muted">Reading current access…</p>
              <p v-if="accessSummary.error" role="alert" class="text-[13px] text-theme-danger">{{ accessSummary.error }}</p>
              <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-4 text-sm"><template v-for="row in accessSummary.rows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></template></dl>
              <CustomButton v-if="writable" type="button" variant="secondary" label="Change access…" class="self-start" @click="openAccess" />
               <p v-else class="text-sm text-theme-text-muted">Access changes are unavailable in this session. Locked settings are recovered through deployment configuration.</p>
            </div>
            <div v-else-if="currentPage.kind === 'account'" class="flex flex-col gap-2">
              <p class="text-sm text-theme-text">{{ accountSummary.text }}</p>
              <CustomButton v-if="canLogout" type="button" variant="secondary" label="Log out" class="self-start" @click="$emit('logout')" />
            </div>
            <p v-else class="text-sm text-theme-text-muted">This page has no options.</p>
          </SettingsPage>
        </div>
      </div>
    </div>
  </Modal>
  <ConfirmModal :model-value="riskVisible" action-layout="grouped" :title="riskTitle" :message="riskMessage" :confirm-button-text="riskConfirmText" :confirm-button-style="riskConfirmStyle" @update:model-value="session.setRiskVisible" @confirm="resolveRisk(true)" @cancel="resolveRisk(false)" />
  <Modal :model-value="!!pathChoice" name="settings-path-choice" anchor="dialog" scroll="content" labelledby="settings-path-title" trap-focus :close-handler-override="closePathChoice">
    <section v-if="pathChoice" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"><h2 id="settings-path-title" class="text-lg font-semibold">Choose {{ pathChoice.field.type }} in this vault</h2>
      <p v-if="pathChoiceError" role="alert">{{ pathChoiceError }}</p>
      <nav aria-label="Current folder" class="flex flex-wrap items-center gap-1"><template v-for="(crumb,index) in pathCrumbs" :key="crumb.path"><span v-if="index" aria-hidden="true">/</span><span v-if="index===pathCrumbs.length-1" aria-current="location" class="text-sm">{{ crumb.label }}</span><CustomButton v-else type="button" variant="text" :label="crumb.label" :disabled="pathLoading" @click="loadPathChoices(crumb.path)" /></template></nav>
      <CustomButton v-if="pathChoice.root" type="button" label="Up one level" variant="text" class="self-start" :disabled="pathLoading" @click="loadPathChoices(parentPath(pathChoice.root))" />
      <p v-if="pathLoading" role="status" class="text-[13px] text-theme-text-muted">Loading this folder…</p>
      <p v-else-if="!pathEntries.length && !pathChoiceError" class="text-[13px] text-theme-text-muted">This folder is empty.</p>
      <ul v-else class="flex min-w-0 flex-col divide-y divide-theme-border"><li v-for="entry in pathEntries" :key="entry.path"><button type="button" class="focus-ring flex w-full min-w-0 items-center gap-2 py-3 text-left text-sm text-theme-text" :disabled="pathLoading" @click="session.choosePathEntry(entry)"><Icon v-if="entry.directory" :icon="tabFolder" class="shrink-0" width="18" height="18" /><span>{{ entry.label }}{{ entry.directory ? '/' : '' }}</span></button></li></ul>
      <SettingsActions class="mt-auto"><template #end><CustomButton type="button" label="Cancel" variant="secondary" @click="closePathChoice" /><CustomButton v-if="pathChoice.field.type==='folder'" type="button" label="Use this folder" variant="cta" :disabled="!pathChoice.canSelect" @click="selectPath(pathChoice.root)" /></template></SettingsActions>
    </section>
  </Modal>
  <ConfirmModal
    :model-value="departureVisible"
    action-layout="grouped"
    title="Unsaved changes"
    :message="departureMessage"
    :confirm-button-text="departureConfirmText"
    :confirm-disabled="!departureCanSave"
    reject-button-text="Discard"
    cancel-button-text="Keep editing"
    @update:model-value="session.setDepartureVisible"
    @confirm="decideDeparture('save')"
    @reject="decideDeparture('discard')"
    @cancel="decideDeparture('cancel')"
  />
</template>

<script setup>
import { onBeforeUnmount, ref, toRefs } from "vue";
import { createSettingsSession } from "../settingsSession.js";
import Modal from "./Modal.vue";
import ConfirmModal from "./ConfirmModal.vue";
import CustomButton from "./CustomButton.vue";
import DeclarativeSettingsPage from "./DeclarativeSettingsPage.vue";
import { tabClose, tabFolder } from "../icons.js";
import Icon from './Icon.vue';
import Toggle from "./Toggle.vue";
import PluginInventorySettingsPage from "./PluginInventorySettingsPage.vue";
import SettingsNav from './settings/SettingsNav.vue';
import SettingsPage from './settings/SettingsPage.vue';
import SettingsTabs from './settings/SettingsTabs.vue';
import SettingRow from './settings/SettingRow.vue';
import SettingsActions from './SettingsActions.vue';
import { useGlobalStore } from "../globalStore.js";
import AppearanceSettingsPage from "./AppearanceSettingsPage.vue";
import KeybindingsSettingsPage from "./KeybindingsSettingsPage.vue";
import BrandingSettingsPage from "./BrandingSettingsPage.vue";

const props = defineProps({ permissionController: Object, writable: { type: Boolean, default: false } });
const isVisible = defineModel({ type: Boolean });
const emit = defineEmits(["open-access", "logout"]);
const globalStore = useGlobalStore();
const modal = ref(null);
const session = createSettingsSession({
  permissionController: props.permissionController,
  config: () => globalStore.config,
  applyBrand: fresh => { globalStore.config = { ...globalStore.config, brand: fresh }; },
  writable: () => props.writable,
  isVisible: () => isVisible.value,
  setVisible: value => { isVisible.value = value; },
  focus: () => modal.value?.focus(),
  openAccess: () => emit("open-access"),
});
const { core, permissions, pageState, inventory,
  openSettings, selectPage, requestClose, reloadCurrentPage, decideDeparture,
   togglePluginRow, toggleAutoEnable, discardInventoryChoice, managePlugin, toggleExpansion,
   discardPermission, resolveRisk,
  resetCoreBranding, openAccess, parentPath, closePathChoice, browseField, loadPathChoices, selectPath,
} = session;
const { brandingSnapshot, keybindingSnapshot, appearanceSnapshot, accessSummary, accountSummary, attentionItems, canLogout, versionLabel, currentPageId,
  riskVisible, riskTitle, riskMessage, riskConfirmText, riskConfirmStyle, pathChoice, pathEntries, pathChoiceError, pathLoading, pathCrumbs,
  departureVisible, departureMessage, departureCanSave, departureConfirmText,
   groupedPages, currentSnapshot, currentPage,
   pluginRows, autoEnableView, pluginPageHeader,
} = toRefs(session.state);
onBeforeUnmount(session.dispose);
defineExpose({ openSettings, selectPage });
</script>
