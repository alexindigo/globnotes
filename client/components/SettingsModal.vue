<!-- SPDX-License-Identifier: LGPL-3.0-only -->

<template>
  <Modal
    ref="modal"
    v-model="isVisible"
    name="settings"
    anchor="viewport-center"
    class="!mx-1 !w-full sm:!mx-4 sm:!w-[80dvw]"
    labelledby="settings-modal-title"
    trap-focus
    :keydown-handler="core.captureKey"
    :close-handler-override="requestClose"
  >
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-center justify-between gap-2 border-b border-theme-border px-4 py-3">
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
          class="shrink-0"
          aria-label="Close settings"
          :icon-path="tabClose"
          @click="requestClose"
        />
      </div>
      <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          class="max-h-40 w-full shrink-0 overflow-y-auto border-b border-theme-border py-2 sm:max-h-none sm:w-48 sm:border-b-0 sm:border-r"
          aria-label="Settings pages"
        >
          <div
            v-for="group in groupedPages"
            :key="group.name"
            class="mb-2"
          >
            <div class="px-4 py-1 text-xs font-bold uppercase text-theme-text-very-muted">
              {{ group.name }}
            </div>
            <button
              v-for="page in group.pages"
              :key="page.id"
              :data-permission-page="page.permissionPluginId"
              class="block w-full truncate px-4 py-1.5 text-left text-sm text-theme-text"
              :class="{ 'bg-theme-background-elevated': page.id === currentPageId }"
              @click="selectPage(page.id)"
            >
              {{ page.label }}
            </button>
          </div>
        </nav>
        <div class="min-w-0 flex-1 overflow-y-auto p-2 sm:p-4">
          <div v-if="currentPage?.unsupported">
            <p class="text-sm text-theme-danger">
              This settings page uses an unsupported renderer
              ({{ currentPage.renderer?.kind }}). It cannot be displayed in
              this version of globnotes.
            </p>
          </div>
          <PluginPermissionPanel
            v-else-if="currentPage?.permissionPluginId"
            :plugin="permissionSnapshot?.plugin"
            :view="permissionSnapshot?.view"
            :busy="permissionSnapshot?.busy"
            :error="permissionSnapshot?.error"
            :has-server="permissionSnapshot?.hasServer"
            :writable="permissionSnapshot?.writable"
            :has-draft="!!permissionSnapshot?.draft"
            :on-master="value=>permissions.setMaster(currentPage.permissionPluginId,value)"
            :on-approve="(kind,scope)=>approveScope(currentPage.permissionPluginId,kind,scope)"
            :on-delete="(kind,row)=>deleteScope(currentPage.permissionPluginId,kind,row)"
            :on-review="()=>permissions.review(currentPage.permissionPluginId)"
            :on-retry="()=>permissions.retry(currentPage.permissionPluginId)"
            :on-discard="()=>discardPermission(currentPage.permissionPluginId)"
            :on-request="request=>emit('review-request',request)"
          />
          <div v-else-if="currentPageIsPlugin" class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <PluginBrowserBadge :runs-in-browser="currentPage.plugin?.runsInBrowser" :browser-components="currentPage.plugin?.browserComponents" />
            <CustomButton label="Permissions" @click="openPermissionReview(currentPage.owner)" />
          </div>
          <PluginTrustNotice />
          <DeclarativeSettingsPage
            :key="currentPageId"
            :page="currentPage.descriptor"
            :blocking="currentPage.blocking"
            :snapshot="currentSnapshot"
            :on-browse="field=>browseField(currentPageId,field)"
            @edit="pageState.edit(currentPageId, $event.key, $event.raw)"
            @commit="pageState.commit(currentPageId, $event)"
            @reload="reloadCurrentPage"
            @retry="pageState.retry(currentPageId)"
          />
          </div>
          <div v-else-if="currentPage">
            <!-- Appearance: the theme list content (values + callbacks;
             the legacy popup wrapper is not rendered here). -->
            <AppearanceSettingsPage v-if="currentPage.id === 'core:appearance'" :themes="core.THEMES" :selected="core.currentTheme.value" :on-select="core.setTheme" :on-swatch="core.themeSwatch" />
            <KeybindingsSettingsPage v-else-if="currentPage.id === 'core:keybindings'" :layers="core.layers" :snapshot="keybindingSnapshot" :on-layer="core.setLayer" :on-capture="core.startCapture" :on-reset="core.resetBinding" />
            <BrandingSettingsPage v-else-if="currentPage.id === 'core:branding'" :snapshot="brandingSnapshot" :on-edit="core.editBrand" :on-clear-accent="core.clearAccent" :on-pick-file="core.chooseFile" :on-discard-file="core.discardFile" :on-remove-file="core.removeFile" :on-save="()=>core.saveBrand()" :on-reset="resetCoreBranding" :on-retry="core.retryBrand" :on-cancel="requestClose" />
            <!-- Plugins: vault-owned inventory + enablement (the old
             localStorage switches are legacy preferences, shown once). -->
            <PluginInventorySettingsPage v-else-if="currentPage.id === 'core:plugins'"
              :plugins="catalogPlugins" :policy="catalogPolicy" :writable="writable" :errors="pluginError" :snapshot="inventorySnapshot"
               :pages-by-plugin="inventoryPages" :on-open-page="session.selectPage"
               :on-auto-enable="toggleAutoEnable" :on-enabled="togglePlugin" :on-review="openPermissionReview"
               :on-policy-review="inventory.review" :on-policy-retry="inventory.retry" :on-policy-discard="discardInventoryChoice" />
            <div v-else-if="currentPage.id === 'core:editor'" class="flex items-center gap-2 text-sm text-theme-text">
              <Toggle :is-on="core.viewLineNumbers.value" @click="core.saveViewLineNumbers(!core.viewLineNumbers.value)" />
              Line numbers in view mode
            </div>
            <div v-else-if="currentPage.id === 'core:diagnostics'" class="flex items-center gap-2 text-sm text-theme-text">
              <Toggle :is-on="core.debugEnabled.value" @click="core.toggleDebug()" />
              Debug notifications
            </div>
            <div v-else-if="currentPage.id === 'core:access'" class="flex flex-col gap-2">
              <p class="text-sm text-theme-text-muted">
                Update access and authenticator settings in place. Your note
                stays open underneath while you confirm the change.
              </p>
              <CustomButton v-if="writable" label="Change access mode" @click="openAccess" />
               <p v-else class="text-sm text-theme-text-muted">Access changes are unavailable in this session. Locked settings are recovered through deployment configuration.</p>
            </div>
            <div v-else-if="currentPage.id === 'core:account'" class="flex flex-col gap-2">
              <CustomButton v-if="canLogout" label="Log out" @click="$emit('logout')" />
              <p v-else class="text-sm text-theme-text-muted">This session has no account to log out.</p>
            </div>
            <p v-else class="text-sm text-theme-text-muted">This page has no options.</p>
          </div>
        </div>
      </div>
    </div>
  </Modal>
  <Modal :model-value="!!reviewPluginId" name="plugin-permission-review" anchor="viewport-center" labelledby="permission-review-title" trap-focus :close-handler-override="closePermissionReview">
    <section v-if="reviewSnapshot" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" data-permission-review>
      <div class="flex items-center justify-between gap-2">
        <h2 id="permission-review-title" class="text-lg font-semibold">Review permissions</h2>
        <CustomButton label="Close review" @click="closePermissionReview" />
      </div>
      <PluginPermissionPanel :plugin="reviewSnapshot.plugin" :view="reviewSnapshot.view" :busy="reviewSnapshot.busy" :error="reviewSnapshot.error"
        :has-server="reviewSnapshot.hasServer" :writable="reviewSnapshot.writable" :has-draft="!!reviewSnapshot.draft"
        :on-master="value=>permissions.setMaster(reviewPluginId,value)" :on-approve="(kind,scope)=>approveScope(reviewPluginId,kind,scope)"
        :on-delete="(kind,row)=>deleteScope(reviewPluginId,kind,row)" :on-review="()=>permissions.review(reviewPluginId)" :on-retry="()=>permissions.retry(reviewPluginId)"
        :on-discard="()=>discardPermission(reviewPluginId)" :on-request="request=>emit('review-request',request)" />
    </section>
  </Modal>
  <ConfirmModal :model-value="riskVisible" action-layout="grouped" :title="riskTitle" :message="riskMessage" :confirm-button-text="riskConfirmText" :confirm-button-style="riskConfirmStyle" @update:model-value="session.setRiskVisible" @confirm="resolveRisk(true)" @cancel="resolveRisk(false)" />
  <Modal :model-value="!!pathChoice" name="settings-path-choice" anchor="viewport-center" labelledby="settings-path-title" trap-focus :close-handler-override="closePathChoice">
    <section v-if="pathChoice" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"><h2 id="settings-path-title" class="text-lg font-semibold">Choose {{ pathChoice.field.type }} in this vault</h2>
      <p class="text-sm text-theme-text-muted">Outside-host paths remain validated text values in the settings field.</p><p v-if="pathChoiceError" role="alert">{{ pathChoiceError }}</p>
      <CustomButton v-if="pathChoice.root" label="Parent folder" @click="loadPathChoices(parentPath(pathChoice.root))" />
      <CustomButton v-if="pathChoice.field.type==='folder'" :label="pathChoice.root ? 'Use this folder' : 'Use vault root'" @click="selectPath(pathChoice.root)" />
      <button v-for="entry in pathEntries" :key="entry.path" class="rounded border border-theme-border p-2 text-left text-theme-text" @click="entry.directory ? loadPathChoices(entry.path) : selectPath(entry.path)">{{ entry.label }}{{ entry.directory ? '/' : '' }}</button>
      <CustomButton label="Cancel" @click="closePathChoice" />
    </section>
  </Modal>
  <ConfirmModal
    :model-value="departureVisible"
    action-layout="grouped"
    title="Unsaved settings"
    :message="departureMessage"
    confirm-button-text="Save / Retry"
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
import { tabClose } from "../icons.js";
import Toggle from "./Toggle.vue";
import PluginPermissionPanel from "./PluginPermissionPanel.vue";
import PluginInventorySettingsPage from "./PluginInventorySettingsPage.vue";
import PluginTrustNotice from "./PluginTrustNotice.vue";
import PluginBrowserBadge from "./PluginBrowserBadge.vue";
import { useGlobalStore } from "../globalStore.js";
import AppearanceSettingsPage from "./AppearanceSettingsPage.vue";
import KeybindingsSettingsPage from "./KeybindingsSettingsPage.vue";
import BrandingSettingsPage from "./BrandingSettingsPage.vue";

const props = defineProps({ permissionController: Object, writable: { type: Boolean, default: false } });
const isVisible = defineModel({ type: Boolean });
const emit = defineEmits(["open-access", "logout", "review-request"]);
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
  togglePlugin, toggleAutoEnable, discardInventoryChoice,
  approveScope, deleteScope, discardPermission, openPermissionReview, closePermissionReview, resolveRisk,
  resetCoreBranding, openAccess, parentPath, closePathChoice, browseField, loadPathChoices, selectPath,
} = session;
const { brandingSnapshot, keybindingSnapshot, canLogout, versionLabel, currentPageId, reviewPluginId,
  riskVisible, riskTitle, riskMessage, riskConfirmText, riskConfirmStyle, pathChoice, pathEntries, pathChoiceError,
  reviewSnapshot, departureVisible, departureMessage, departureCanSave, inventorySnapshot, pluginError,
  groupedPages, inventoryPages, currentSnapshot, currentPage, currentPageIsPlugin, permissionSnapshot, catalogPlugins, catalogPolicy,
} = toRefs(session.state);
onBeforeUnmount(session.dispose);
defineExpose({ openSettings, selectPage });
</script>
