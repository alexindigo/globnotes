<template>
  <!-- Confirm Deletion Modal -->
  <ConfirmModal
    v-model="isDeleteModalVisible"
    title="Confirm Deletion"
    :message="`Are you sure you want to delete the note '${note.path}'?`"
    confirmButtonText="Delete"
    confirmButtonStyle="danger"
    @confirm="deleteConfirmedHandler"
  />

  <!-- Save Changes Modal -->
  <ConfirmModal
    v-model="isSaveChangesModalVisible"
    title="Save Changes"
    :message="saveChangesMessage"
    confirmButtonText="Save"
    confirmButtonStyle="success"
    rejectButtonText="Discard"
    rejectButtonStyle="danger"
    @confirm="onSaveChoice('save')"
    @reject="onSaveChoice('discard')"
    @cancel="onSaveChoice('cancel')"
  />

    <!-- Rename Assets Modal -->
    <RenameAssetsModal
      :visible="renameAssetsModalVisible"
      :refs="renameRefs"
      :prompt-identity="renamePromptIdentity"
      @confirm="controller.confirmRename"
      @cancel="controller.cancelRename"
    />

    <!-- Draft Modal -->
    <ConfirmModal
    v-model="isDraftModalVisible"
    title="Draft Detected"
    message="There is an unsaved draft of this note stored in this browser. Do you want to resume the draft version or delete it?"
    confirmButtonText="Resume Draft"
    confirmButtonStyle="cta"
    rejectButtonText="Delete Draft"
    rejectButtonStyle="danger"
    @confirm="setEditMode()"
    @reject="
      clearDraft();
      setEditMode();
    "
  />

  <LoadingIndicator ref="loadingIndicator" class="flex h-full flex-col">
    <!-- 404 / Not Found -->
    <div
      v-if="isNoteNotFound"
      class="flex h-full flex-col items-center justify-center"
    >
      <Icon
       
        icon="tabNotesOff"
        size="4em"
        class="mb-4 text-theme-brand"
      />
      <span class="mb-4 max-w-80 text-center text-lg text-theme-text-muted">
        Note not found
      </span>
      <div v-if="canModify" class="w-full max-w-80">
        <CtaButton label="Create note 'New note'" :callback="createFromWikilink" />
      </div>
    </div>

    <!-- Header (sits outside the scrollable content) -->
    <div v-if="!isNoteNotFound">
      <div class="flex flex-col-reverse md:flex-row md:items-baseline">
        <!-- Title -->
        <div class="min-w-0 grow">
          <div class="truncate text-3xl leading-[1.6em]">
            <span v-show="!editMode" :title="note.path">{{
              noteBasename
            }}</span>
            <TextInput
              v-show="editMode"
              v-model.trim="editBasename"
              @input="onTitleInput"
              @keydown.enter="controller.applyRename()"
              @blur="controller.applyRename()"
              variant="plain"
              placeholder="Title"
            />
          </div>
          <div
            v-show="!editMode && noteDirName"
            class="truncate pt-1 text-sm text-theme-text-muted"
            :title="note.path"
          >
            <template v-for="(crumb, i) in noteDirBreadcrumbs" :key="i">
              <span v-if="crumb.ellipsis">…/</span>
              <RouterLink
                v-else
                :to="folderSearchTarget(crumb.folder)"
                class="hover:text-theme-brand hover:underline"
                >{{ crumb.label }}/</RouterLink
              >
            </template>
          </div>
          <div v-show="editMode" class="flex pt-1">
            <TextInput
              v-model="editFolder"
              @input="syncTitle"
              @keydown.enter="controller.applyRename()"
              @blur="controller.applyRename()"
              :list="folderDatalistId"
              class="grow"
              variant="plain-muted"
              placeholder="Folder (root)"
            />
            <datalist :id="folderDatalistId">
              <option
                v-for="d in folderDatalistOptions"
                :value="d"
                :key="d"
              />
            </datalist>
          </div>
        </div>

        <!-- Buttons -->
        <div class="flex shrink-0 self-end md:self-end print:hidden">
          <!-- Delete Button -->
          <CustomButton
            v-show="canModify && !isNewNote"
            label="Delete"
            :iconPath="tabTrash"
            @click="deleteHandler"
          />
          <!-- Save Button -->
          <CustomButton
            v-show="editMode"
            label="Save"
            :iconPath="saving ? tabLoader2 : tabSave"
            :iconClass="[unsavedChanges ? 'text-theme-brand' : '', saving ? 'animate-spin motion-reduce:animate-none' : '']"
            :aria-busy="saving ? 'true' : 'false'"
            @click="saveHandler(false)"
            class="ml-1"
          />
          <!-- Edit Toggle -->
          <Toggle
            v-if="canModify"
            label="Edit"
            :isOn="editMode"
            class="ml-1"
            @click="toggleEditModeHandler"
          />
        </div>
      </div>
      <p v-if="editMode && saveFeedback" role="status" class="mt-1 text-sm text-theme-text-muted" data-note-save-status>{{ saveFeedback }}</p>

      <hr v-if="!editMode" class="mt-4 mb-6 border-theme-border" />
    </div>

    <!-- Moved-files banner -->
    <div
      v-if="!editMode && lastMovedFiles.length"
      class="mb-4 rounded-lg border border-theme-brand/20 bg-theme-background-elevated p-3"
    >
      <p class="mb-2 text-sm text-theme-text-muted">
        {{ lastMovedFiles.length }} file(s) moved with this note.
      </p>
      <RouterLink
        :to="rewriteScanLink"
        class="text-sm text-theme-brand hover:underline"
      >
        Scan referencing notes &rarr;
      </RouterLink>
    </div>

    <!-- Content (scrolls internally; the header never moves) -->
    <div class="min-h-0 flex-1 overflow-y-auto print:overflow-visible">
      <ServerViewer
        v-if="!editMode"
        :title="note.path"
        :line="viewLine"
        class="toast-viewer pb-4"
      />
      <div v-if="editMode" class="flex h-full min-h-0 flex-col">
        <div class="mb-2 flex gap-2 text-sm">
          <button
            type="button"
            class="rounded px-2 py-1"
            :class="
              editorMode === 'markdown'
                ? 'bg-theme-background-elevated text-theme-text'
                : 'text-theme-text-muted hover:text-theme-brand'
            "
            @click="setEditorMode('markdown')"
          >
            Source
          </button>
          <button
            type="button"
            class="rounded px-2 py-1"
            :class="
              editorMode === 'wysiwyg'
                ? 'bg-theme-background-elevated text-theme-text'
                : 'text-theme-text-muted hover:text-theme-brand'
            "
            @click="setEditorMode('wysiwyg')"
          >
            WYSIWYG
          </button>
          <button
            type="button"
            class="rounded px-2 py-1"
            :class="
              editorMode === 'preview'
                ? 'bg-theme-background-elevated text-theme-text'
                : 'text-theme-text-muted hover:text-theme-brand'
            "
            @click="setEditorMode('preview')"
          >
            Preview
          </button>
        </div>
        <MarkdownEditor
          v-if="editorMode === 'markdown'"
          ref="editor"
          :initialValue="editorInitialValue"
          :initialLine="editorInitialLine"
          :addImageBlobHook="addImageBlobHook"
          @change="onEditorInput"
          @selection="onSourceSelection"
        />
        <!-- Keyed by the active keybinding layer AND the client-plugin
             epoch: Milkdown keymaps and client plugin factories bake in at
             editor creation, so either switch recreates the editor. The
             watchers below transfer content across the remount. -->
        <WysiwygEditor
          v-else-if="editorMode === 'wysiwyg'"
          ref="editor"
          :key="editorKey"
          :initialValue="editorInitialValue"
          :addImageBlobHook="addImageBlobHook"
          @change="onEditorInput"
        />
        <!-- Preview: the UNSAVED buffer rendered server-side (plugins +
             disabled switches honored like the GET path), debounced. -->
        <div v-else class="min-h-0 flex-1 overflow-y-auto">
          <div
            class="toastui-editor-contents rendered-markdown preview-buffer"
            v-html="previewHtml"
            @click="handleAnchorClick"
          />
        </div>
      </div>
    </div>
  </LoadingIndicator>
</template>

<style>
/* Disable checkboxes in view mode. See https://github.com/nhn/tui.editor/issues/1087. */
.toast-viewer li.task-list-item {
  pointer-events: none;
}
.toast-viewer li.task-list-item a {
  pointer-events: auto;
}
</style>

<script setup>
import { tabSave, tabTrash, tabLoader2 } from "../icons.js";
import { computed, onBeforeUnmount, onMounted, ref, toRefs, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from "vue-router";
import { useToast } from "primevue/usetoast";
import Icon from "../components/Icon.vue";
import ConfirmModal from "../components/ConfirmModal.vue";
import CustomButton from "../components/CustomButton.vue";
import CtaButton from "../components/CtaButton.vue";
import TextInput from '../components/TextInput.vue';
import RenameAssetsModal from "../components/RenameAssetsModal.vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import Toggle from "../components/Toggle.vue";
import MarkdownEditor from "../components/MarkdownEditor.vue";
import WysiwygEditor from "../components/WysiwygEditor.vue";
import ServerViewer from "../components/ServerViewer.vue";
import { handleAnchorClick } from "../anchorClicks.js";
import { useGlobalStore } from "../globalStore.js";
import { currentLayerId } from "../keybindings/store.js";
import { clientPluginEpoch } from "../pluginLoader.js";
import { folderSearchTarget } from "../notePath.js";
import { createNoteController } from "../noteController.js";

const props = defineProps({ path: String });
const route = useRoute();
const router = useRouter();
const globalStore = useGlobalStore();
const controller = createNoteController({
  router, toast: useToast(),
  getContext: () => ({ path: props.path, query: route.query,
    authType: globalStore.config.authType, notePaths: globalStore.notePaths }),
});
const {
  canModify, isNewNote, editMode, isNoteNotFound, note, folderDatalistOptions,
  noteDirName, noteBasename, noteDirBreadcrumbs, renameAssetsModalVisible, renameRefs,
  renamePromptIdentity, lastMovedFiles, rewriteScanLink, editorMode, editorInitialValue,
  editorInitialLine, viewLine, previewHtml, unsavedChanges, saving, saveFeedback, saveChangesMessage,
} = toRefs(controller.state);
const {
  toggleEditModeHandler, setEditorMode, onEditorInput, onSourceSelection, setEditMode,
  syncTitle, onTitleInput, deleteHandler, deleteConfirmedHandler, saveHandler, onSaveChoice,
  clearDraft, createFromWikilink, addImageBlobHook,
} = controller;
const editBasename = computed({ get: () => controller.state.editBasename, set: controller.setBasename });
const editFolder = computed({ get: () => controller.state.editFolder, set: controller.setFolder });
const isSaveChangesModalVisible = computed({ get: () => controller.state.isSaveChangesModalVisible, set: value => controller.setDecisionVisible("save", value) });
const isDeleteModalVisible = computed({ get: () => controller.state.isDeleteModalVisible, set: value => controller.setDecisionVisible("delete", value) });
const isDraftModalVisible = computed({ get: () => controller.state.isDraftModalVisible, set: value => controller.setDecisionVisible("draft", value) });
const folderDatalistId = "folder-datalist";
const loadingIndicator = ref();
const editor = ref();
const editorKey = computed(() => `${currentLayerId.value}:${clientPluginEpoch.value}`);

// Register only the editor's public capability port, not its component state.
watch(editor, instance => controller.registerEditor(instance ? {
  getSnapshot: instance.getSnapshot ? () => instance.getSnapshot() : undefined,
  getMarkdown: () => instance.getMarkdown(),
  setMarkdown: content => instance.setMarkdown(content),
  isWysiwygMode: () => instance.isWysiwygMode(),
  applyAcknowledgement: content => instance.applyAcknowledgement(content),
  selectLine: instance.selectLine ? line => instance.selectLine(line) : undefined,
} : null), { flush: "sync" });
watch(() => controller.state.loadStatus, status => {
  const indicator = loadingIndicator.value;
  if (status === "loading") indicator?.setLoading();
  else if (status === "loaded") indicator?.setLoaded();
  else indicator?.setFailed();
});
watch(() => controller.state.resourceIdentity, controller.init);
watch(() => route.hash, controller.routeHashChanged);
watch([currentLayerId, clientPluginEpoch], controller.captureEditorForRemount);
onMounted(controller.mount);
onBeforeUnmount(controller.dispose);
onBeforeRouteUpdate(async to => { if (!(await controller.gateNavigation(to))) return false; });
onBeforeRouteLeave(async to => { if (!(await controller.gateNavigation(to))) return false; });
</script>
