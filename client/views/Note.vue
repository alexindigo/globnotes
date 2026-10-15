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
      @confirm="saveOwner.confirmRename"
      @cancel="saveOwner.cancelRename"
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
            <input
              v-show="editMode"
              v-model.trim="editBasename"
              @input="onTitleInput"
              class="w-full bg-theme-background outline-none"
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
            <input
              v-model="editFolder"
              @input="syncTitle"
              :list="folderDatalistId"
              class="min-w-0 grow bg-theme-background text-sm text-theme-text-muted outline-none"
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
import { tabNotesOff } from "../icons.js";
import { tabSave, tabTrash, tabLoader2 } from "../icons.js";
import { createUuid } from "../../shared/uuid.ts";
import Icon from "../components/Icon.vue";
import { useToast } from "primevue/usetoast";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from "vue-router";

import {
  apiErrorHandler,
  deleteNote,
  getNote,
} from "../api.js";
import { Note } from "../classes.js";
import { displayTitle, followedBasename } from "../noteTitle.js";
import ConfirmModal from "../components/ConfirmModal.vue";
import CustomButton from "../components/CustomButton.vue";
import CtaButton from "../components/CtaButton.vue";
import RenameAssetsModal from "../components/RenameAssetsModal.vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import Toggle from "../components/Toggle.vue";
import MarkdownEditor from "../components/MarkdownEditor.vue";
import WysiwygEditor from "../components/WysiwygEditor.vue";
import ServerViewer, {
  handleAnchorClick,
} from "../components/ServerViewer.vue";
import { authTypes, params } from "../constants.js";
import { useGlobalStore } from "../globalStore.js";
import {
  directoryFromPath,
  getToastOptions,
  nextUntitledPath,
} from "../helpers.js";
import {
  editorStateFromFragment,
  parseFragment,
  viewLineFromFragment,
} from "../fragment.js";
import { publish, subscribe, TOPICS } from "../bus/index.js";
import { isActionAvailable } from "../modalState.js";
import { currentLayerId } from "../keybindings/store.js";
import { defaultEditorMode, setDefaultEditorMode } from "../editorPreferences.js";
import { clientPluginEpoch } from "../pluginLoader.js";
import {
  basenameOf,
  encodeRewriteFiles,
  folderSearchTarget,
  joinNotePath,
  newNoteTarget,
  notePath,
  pathBreadcrumbs,
} from "../notePath.js";
import { createNoteDraftStore } from "../noteDrafts.js";
import { createNotePreview } from "../notePreview.js";
import { createNoteUrlSync } from "../noteUrlSync.js";
import { decideNavigation, noteResourceIdentity } from "../noteNavigationGate.js";
import { setBeforeUnloadConfirmation } from "../unloadGuard.js";
import { registerSessionParticipant } from "../sessionActions.js";
import { createNoteSaveOwner } from "../noteSaveOwner.js";
import { createNoteRenameLinks } from "../noteRenameLinks.js";
import { createNoteAttachments } from "../noteAttachments.js";
import { noteOperationError, noteSaveError } from "../noteErrors.js";

const props = defineProps({
  path: String,
});

const canModify = computed(
  () => globalStore.config.authType != authTypes.readOnly,
);
let contentChangedTimeout = null;
const editMode = ref(false);
const globalStore = useGlobalStore();
const isSaveChangesModalVisible = ref(false);
const isDeleteModalVisible = ref(false);
const isDraftModalVisible = ref(false);
const isNoteNotFound = ref(false);
const isNewNote = computed(() => !props.path);
const folderDatalistOptions = computed(() => {
  const dirs = new Set();
  for (const t of globalStore.notePaths || []) {
    const d = directoryFromPath(t);
    if (d) dirs.add(d);
  }
  return [...dirs].sort();
});
const loadingIndicator = ref();
const note = ref({});
const noteDirName = computed(() =>
  directoryFromPath(note.value.path || props.path || ""),
);
const noteBasename = computed(() => {
  const path = note.value.path || props.path || "";
  return noteDirName.value ? basenameOf(path) : path;
});
// The path as breadcrumb links; each section links to its folder view.
// Long paths keep two sections on each side of a non-linked ellipsis.
const noteDirBreadcrumbs = computed(() => pathBreadcrumbs(noteDirName.value));
const route = useRoute();
const router = useRouter();
const newPath = ref();
const editBasename = ref("");
const editFolder = ref("");
// New-note title follow: while the title field is untouched, the filename
// follows the buffer's first H1 (debounced). First user edit stops it.
const titleTouched = ref(false);
const folderDatalistId = "folder-datalist";
const saveOwnerState = shallowRef({ pendingRenamePrompt: null });
const renameAssetsModalVisible = computed(() => !!saveOwnerState.value.pendingRenamePrompt);
const renameRefs = computed(() => saveOwnerState.value.pendingRenamePrompt?.refs ?? []);
const renamePromptIdentity = computed(() => saveOwnerState.value.pendingRenamePrompt?.identity ?? null);
const lastMovedFiles = ref([]);
const rewriteScanLink = computed(() => {
  const files = lastMovedFiles.value;
  if (!files.length) return "";
  const param = encodeRewriteFiles(files);
  return `/_/search?${params.searchTerm}=*&rewriteFiles=${param}`;
});
const toast = useToast();
const { updateRenamedLinks } = createNoteRenameLinks({
  ownsPath: path => saveOwner.ownsPath(path),
  updated: count => toast.add(getToastOptions(`Updated links in ${count} note(s).`, "Links updated", "success")),
});
const { addImageBlobHook } = createNoteAttachments({
  getState: () => ({ requestedPath: newPath.value, path: props.path }),
  notify: ({ title, message, severity }) => toast.add(getToastOptions(message, title, severity)),
  failed: error => apiErrorHandler(error, toast),
});
const editor = ref();
const editorKey = computed(
  () => `${currentLayerId.value}:${clientPluginEpoch.value}`,
);
const editorMode = ref(defaultEditorMode.value);
const editorInitialValue = ref("");
// Fragment-driven entry state: carries through the draft modal so a
// deep-linked mode/line survives both modal branches.
let pendingEditorMode = null;
let pendingInitialLine = null;
let pendingPush = false;
const editorInitialLine = ref(null);
const editorLine = ref(null);
// Preview tab state: the server-rendered buffer HTML.
const previewHtml = ref("");
const preview = createNotePreview({ changed: ({ html }) => { previewHtml.value = html; } });
// View-mode line-link target (from the #view:L fragment) — read by
// ServerViewer's highlight.
const viewLine = ref(null);

/** The live editor buffer. In preview the editor is unmounted, so the
 * buffer lives in editorInitialValue (transferred on mode switch). */
function currentBuffer() {
  const snapshot = editor.value?.getSnapshot?.();
  if (snapshot) return snapshot.ready ? snapshot.content : editorInitialValue.value;
  return editor.value ? editor.value.getMarkdown() : editorInitialValue.value;
}

function setEditorMode(mode, writeUrl = true) {
  if (mode === editorMode.value) return;
  urlSync.clearCaretSyncTimer();
  // Transfer content across the remount; persist the pref immediately.
  editorInitialValue.value = currentBuffer();
  editorMode.value = mode;
  setDefaultEditorMode(mode);
  publish(TOPICS.EDITOR_MODE_CHANGE, { mode });
  // The caret doesn't transfer across editors; the fresh editor reports
  // its own selection once the user interacts with it.
  editorLine.value = null;
  editorInitialLine.value = null;
  if (writeUrl) urlSync.writeCurrentFragment(true);
  if (mode === "preview") schedulePreviewRefresh();
}

function onEditorInput() {
  if (applyingAcknowledgement) return;
  contentRevision.value++;
  noteDirty.value = true;
  refreshDirtyState();
  startContentChangedTimeout();
  schedulePreviewRefresh();
  scheduleTitleFollow();
  publishTitle();
}

function schedulePreviewRefresh() {
  preview.schedule({
    isActive: () => editorMode.value === "preview",
    // Preview unmounts the editor; the retained buffer remains authoritative.
    getBuffer: () => editorInitialValue.value,
  });
}

function onSourceSelection(line) {
  editorLine.value = line;
  urlSync.scheduleCaretSync();
}
const unsavedChanges = ref(false);
// Revisions identify who may apply an acknowledgement. Pending work and
// literal comparison with the acknowledged base determine immediate dirtiness.
const noteDirty = ref(false);
const contentRevision = ref(0);
const pathRevision = ref(0);
const queueState = ref({ status: "idle", unresolved: false, queued: [], jobs: [], canDiscard: true });
const saving = computed(() => ["preparing", "sending"].includes(queueState.value.status));
const saveFeedback = computed(() => queueState.value.status === "paused"
  ? `Saving paused at submission ${queueState.value.failure?.submissionId}. ${queueState.value.queued.length} held saves; current edits are retained. ${queueState.value.failure?.certainty === 'unknown' ? 'The write outcome is unknown; do not resend it.' : queueState.value.failure?.certainty === 'known-committed' ? 'The write committed; its UI integration failed. Do not resend it.' : ''} ${queueState.value.failure?.message ?? ''}`
  : saving.value ? `Saving… ${queueState.value.queued.length} queued.` : "");
const saveChangesMessage = computed(() => queueState.value.unresolved
  ? "Save work is retained. Discard removes queued saves and current unsaved changes only when all sent writes have a known outcome."
  : "Do you want to save your changes?");
const ownerId = createUuid();
let applyingAcknowledgement = false;
const drafts = createNoteDraftStore();
let loadGeneration = 0;
const currentResourceIdentity = computed(() => noteResourceIdentity(props.path, route.query));
const urlSync = createNoteUrlSync({
  router,
  ownerId,
  getPath: () => props.path,
  getState: () => ({
    isNewNote: isNewNote.value,
    editMode: editMode.value,
    editorMode: editorMode.value,
    editorLine: editorLine.value,
    viewLine: viewLine.value,
  }),
});
const saveOwner = createNoteSaveOwner({
  ownerId,
  getState: () => ({
    note: note.value,
    isNewNote: isNewNote.value,
    requestedPath: newPath.value,
    contentRevision: contentRevision.value,
    pathRevision: pathRevision.value,
  }),
  getBuffer: currentBuffer,
  isContentChanged,
  applyNote: result => { note.value = new Note(result); },
  applyPath: path => {
    newPath.value = path;
    editBasename.value = basenameOf(path ?? "");
    editFolder.value = directoryFromPath(path ?? "");
  },
  applyContentAcknowledgement: content => {
    if (!editor.value) editorInitialValue.value = content;
    else if (editor.value.applyAcknowledgement) {
      applyingAcknowledgement = true;
      try { editor.value.applyAcknowledgement(content); }
      finally { applyingAcknowledgement = false; }
    }
  },
  restoreContent: content => {
    editorInitialValue.value = content;
    applyingAcknowledgement = true;
    try { editor.value?.setMarkdown(content); }
    finally { applyingAcknowledgement = false; }
  },
  publishTitle,
  setMovedFiles: files => { lastMovedFiles.value = files; },
  urlSync,
  updateRenamedLinks,
  drafts,
  requestDecision: requestNoteDecision,
  closeNote,
  saveEditorPreference: saveDefaultEditorMode,
  changed: state => {
    saveOwnerState.value = state;
    queueState.value = state.queue;
  },
  refreshDirtyState,
  invalid: message => toast.add(getToastOptions(message, "Invalid", "error")),
  held: () => toast.add(getToastOptions("This Save was captured and held. The queue is paused; no retry or resume was performed.", "Save held", "error")),
  failed: noteSaveFailure,
});

function init() {
  if (urlSync.consumeAcknowledgedResource(props.path, saveOwner.queueState()?.sessionId)) return;
  saveOwner.reset();
  const generation = ++loadGeneration;
  const resource = currentResourceIdentity.value;
  const isCurrentLoad = () => generation === loadGeneration && resource === currentResourceIdentity.value;
  drafts.release(); // release ownership, never erase another logical note's draft
  isNoteNotFound.value = false;
  loadingIndicator.value.setLoading();
  if (props.path) {
    getNote(props.path)
      .then((data) => {
        if (!isCurrentLoad()) return;
        note.value = data;
        refreshDirtyState();
        loadingIndicator.value.setLoaded();
        publishTitle();
        enterEditFromFragment();
        // View-mode line links: #view:L highlights the rendered lines.
        const frag = parseFragment(window.location.hash);
        viewLine.value = viewLineFromFragment(frag);
      })
      .catch((error) => {
        if (!isCurrentLoad()) return;
        if (error.response?.status === 404) {
          isNoteNotFound.value = true;
          loadingIndicator.value.setLoaded();
        } else {
          loadingIndicator.value.setFailed();
          apiErrorHandler(error, toast);
        }
      });
  } else {
    const folder = route.query.folder || "";
    const explicitTitle = route.query.path;
    let prefillTitle;
    if (explicitTitle) {
      prefillTitle = explicitTitle;
    } else {
      prefillTitle = nextUntitledPath(
        globalStore.notePaths || [],
        folder,
      );
    }
    newPath.value = prefillTitle;
    note.value = new Note({ path: prefillTitle });
    editMode.value = false;
    // A fresh new-note page re-arms the title follow.
    titleTouched.value = false;
    nextTick(() => {
      if (!isCurrentLoad()) return;
      editHandler();
      loadingIndicator.value.setLoaded();
      publishTitle();
    });
  }
}

// Note Editing
function toggleEditModeHandler() {
  if (editMode.value) {
    closeHandler();
  } else {
    editHandler(true);
  }
}

function editHandler(pushUrl = false) {
  pendingPush = pushUrl;
  // Drafts key off newPath; on a fresh mount it isn't set until
  // setEditMode, which would make loadDraft miss stored drafts.
  if (!newPath.value && note.value.path) newPath.value = note.value.path;
  const draftContent = loadDraft();
  if (draftContent) {
    isDraftModalVisible.value = true;
  } else {
    setEditMode();
  }
}

// Deep links: #edit opens in WYSIWYG, #source[:L...] in source mode.
// #view[:L...] is a VIEW-mode link — highlight only, never an edit entry.
// The pending mode/line survive the draft modal (both branches call
// setEditMode). Window location is the source of truth — route.hash goes
// stale after our history writes. No history push here: the navigation
// that carried the fragment into the tab IS the history entry.
function enterEditFromFragment(frag = parseFragment(window.location.hash)) {
  const target = editorStateFromFragment(frag);
  if (!target || !canModify.value) return;
  pendingEditorMode = target.mode;
  pendingInitialLine = target.line;
  editHandler();
}

// --- Navigation gate ----------------------------------------------------
// The URL may only leave an edit state once that state change is resolved.
// Every router-driven navigation (links, back/forward, programmatic) passes
// through here BEFORE the URL commits: clean exits commit immediately; dirty
// exits wait on the Save/Discard/Cancel modal; cancel reverts the URL and
// keeps the session exactly where it was.
async function gateNavigation(to) {
  const saveState = saveOwner.queueState();
  const action = decideNavigation({
    ...urlSync.state(),
    ownerId,
    sessionId: saveState?.sessionId,
    activeSubmissionId: saveState?.active?.submissionId,
    resourceIdentity: currentResourceIdentity.value,
    editMode: editMode.value,
    editorMode: editorMode.value,
    canModify: canModify.value,
    queue: queueState.value,
    dirty: isContentChanged(),
  }, to);
  if (action.type === "acknowledge") {
    urlSync.consumeAcknowledgementGuard();
    return true;
  }
  if (action.type === "allow") return true;
  if (action.type === "enter-edit") {
    pendingEditorMode = action.mode;
    pendingInitialLine = action.line;
    editHandler();
    return true;
  }
  if (action.type === "view-line") {
    viewLine.value = action.line;
    return true;
  }
  if (action.type === "sync-editor") {
    if (editorMode.value !== action.mode) setEditorMode(action.mode, false);
    if (action.line) {
      await nextTick();
      editor.value?.selectLine?.(action.line);
    }
    return true;
  }
  if (action.type === "exit-edit") {
    exitEditState();
    return true;
  }
  // Dirty exit: stash the destination and block. For a browser pop, the
  // guard abort makes vue-router revert to the history entry the user was
  // on — whose URL is exactly the edit fragment, no manual repair needed.
  // For a push the address never committed. Either way the modal drives
  // the actual transition; Cancel leaves everything exactly as it was.
  const navWasPop = window.location.hash === to.hash;
  const target = { to, pop: navWasPop, sessionId: saveOwner.queueState()?.sessionId };
  pendingNavTarget = target;
  if (action.type === "settle") {
    // Abort the real route immediately; a bounded owned barrier decides
    // whether a later transition can be requested with this same target.
    settlePendingWrites().then(ok => {
      if (pendingNavTarget !== target || target.sessionId !== saveOwner.queueState()?.sessionId) return;
      if (!ok) { pendingNavTarget = null; return; }
      if (isContentChanged()) isSaveChangesModalVisible.value = true;
      else { pendingNavTarget = null; exitEditState(); commitNavTarget(to, navWasPop); }
    });
  } else if (action.type === "prompt") isSaveChangesModalVisible.value = true;
  else pendingNavTarget = null;
  return false;
}

// --- Save-changes modal (Save / Discard / Cancel) ------------------------
// Shown either by the navigation gate (a destination is pending), by the
// new-note toggle-off path, or by the guarded session handoff (logout /
// access wizard) through sessionActions — one modal, one decision path.
let pendingNavTarget = null;
let pendingSessionDecision = null;
let pendingDecisionPromise = null;

function requestNoteDecision() {
  if (pendingDecisionPromise) return pendingDecisionPromise;
  isSaveChangesModalVisible.value = true;
  pendingDecisionPromise = new Promise(resolve => { pendingSessionDecision = resolve; })
    .finally(() => { pendingDecisionPromise = null; });
  return pendingDecisionPromise;
}
function settlePendingWrites() { return saveOwner.settle(); }
function discardOwnedWork() {
  return saveOwner.discard();
}
function resolveOwnedWork() { return saveOwner.resolve(); }

// The Note registers its own unsaved-state/save/discard callbacks with the
// session coordinator; the coordinator never reads editor internals.
const disposeSessionParticipant = registerSessionParticipant("note", {
  hasUnsavedChanges: () => isContentChanged(),
  settlePending: () => settlePendingWrites(),
  requestDecision: () => requestNoteDecision(),
  save: () => saveForNavigation(),
  discard: () => {
    if (!discardOwnedWork()) return false;
    exitEditState();
    return true;
  },
});

// Commit the gated destination after the edit session ends: pop exits were
// reverted to the edit entry (vue-router restored the URL), so replace that
// entry with the target; push exits navigate for real.
function commitNavTarget(to, pop) {
  if (pop) router.replace(to.fullPath);
  else router.push(to.fullPath);
}

function onSaveChoice(choice) {
  isSaveChangesModalVisible.value = false;
  if (pendingSessionDecision) {
    const resolve = pendingSessionDecision;
    pendingSessionDecision = null;
    resolve(choice);
    return;
  }
  if (pendingNavTarget) {
    const { to, pop } = pendingNavTarget;
    pendingNavTarget = null;
    if (choice === "cancel") return; // pop already reverted: still editing, URL intact
    const commit = () => {
      exitEditState();
      commitNavTarget(to, pop);
    };
    if (choice === "save") {
      saveForNavigation().then((ok) => {
        if (ok) commit();
      });
    } else {
      if (discardOwnedWork()) commit();
    }
    return;
  }
  // New-note path: no gated navigation is pending.
  if (choice === "save") saveHandler(true);
  else if (choice === "discard") {
    if (!discardOwnedWork()) return;
    exitEditState();
    clearDraft();
    router.push({ name: "home" });
  }
}

function setEditMode() {
  newPath.value = note.value.path;
  editBasename.value = basenameOf(newPath.value || "");
  editFolder.value = directoryFromPath(newPath.value);
  unsavedChanges.value = false;
  editorInitialValue.value = getInitialEditorValue();
  // A resumed draft IS unsaved work; a clean load is not.
  noteDirty.value = editorInitialValue.value != note.value.content;
  contentRevision.value = 0;
  pathRevision.value = 0;
  saveOwner.start();
  editorMode.value = pendingEditorMode || defaultEditorMode.value;
  editorInitialLine.value = pendingInitialLine;
  editorLine.value = pendingInitialLine || null;
  pendingEditorMode = null;
  pendingInitialLine = null;
  const push = pendingPush;
  pendingPush = false;
  editMode.value = true;
  refreshDirtyState();
  publish(TOPICS.NOTE_EDIT_START, { path: note.value.path });
  urlSync.writeCurrentFragment(push);
}

function syncTitle() {
  pathRevision.value++;
  newPath.value = joinNotePath(editFolder.value, editBasename.value);
  refreshDirtyState();
}

// -- Title follow + the live tab title ------------------------------------
// The note knows its own title: frontmatter `title:` → first H1 →
// basename. The tab follows the live buffer, even before save.

/** The note's display title, live. */
function currentTitle() {
  const source = editMode.value
    ? currentBuffer()
    : (note.value.content ?? "");
  return displayTitle(source, noteBasename.value);
}

function publishTitle() {
  publish(TOPICS.NOTE_TITLE_CHANGED, { title: currentTitle() });
}

let titleFollowTimer = null;
/** Untouched new-note filename follows the buffer's first H1 (debounced). */
function scheduleTitleFollow() {
  if (!isNewNote.value || titleTouched.value) return;
  if (titleFollowTimer) clearTimeout(titleFollowTimer);
  titleFollowTimer = setTimeout(() => {
    titleFollowTimer = null;
    if (!isNewNote.value || titleTouched.value) return;
    const sanitized = followedBasename(currentBuffer());
    if (sanitized && sanitized !== editBasename.value) {
      editBasename.value = sanitized;
      syncTitle();
    }
  }, 300);
}

/** Title field typed by hand — the follow stops for good. */
function onTitleInput() {
  titleTouched.value = true;
  syncTitle();
}

function getInitialEditorValue() {
  const draftContent = loadDraft();
  return draftContent !== null ? draftContent : note.value.content ?? "";
}

// Note Deletion
async function deleteHandler() {
  if (!await resolveOwnedWork()) return;
  isDeleteModalVisible.value = true;
}

async function deleteConfirmedHandler() {
  if (!await settlePendingWrites() || isContentChanged()) return;
  deleteNote(note.value.path)
    .then(() => {
      publish(TOPICS.NOTE_DELETE, { path: note.value.path });
      exitEditState();
      toast.add(getToastOptions("Note deleted ✓", "Success", "success"));
      router.push({ name: "home" });
    })
    .catch((error) => {
      showNoteError(error, noteOperationError(error));
    });
}

// Note Saving
function saveHandler(close = false) {
  return saveOwner.save(close);
}

function refreshDirtyState() {
  const dirty = isContentChanged();
  unsavedChanges.value = dirty;
  noteDirty.value = dirty;
  setBeforeUnloadConfirmation(dirty);
}

function noteSaveFailure(error) {
  noteDirty.value = true;
  showNoteError(error, noteSaveError(error, queueState.value.failure));
}

function showNoteError(error, mapped) {
  if (mapped) toast.add(getToastOptions(mapped.message, mapped.title, "error"));
  else apiErrorHandler(error, toast);
}

// Note Closure
async function closeHandler() {
  if (!await resolveOwnedWork()) return;
  if (isNewNote.value) {
    exitEditState();
    router.push({ name: "home" });
    return;
  }
  if (window.location.hash === "") {
    // Defensive: the gate normally never leaves edit state against a
    // fragment-less URL.
    exitEditState();
    return;
  }
  // Exit is a navigation to the fragment-less state; the gate decides —
  // clean exits commit, dirty ones wait on Save/Discard/Cancel, and cancel
  // reverts the URL without moving anywhere. Path-string push: hash-only
  // locations re-encode the title's slashes.
  urlSync.writeFragment(null, true);
}

// End the edit session in state only. Callers own the URL: either the
// navigation that triggered the exit commits it (guards), or closeNote
// writes the fragment-less URL explicitly (toggle/Esc close).
function exitEditState() {
  saveOwner.revokeRenamePrompt();
  clearContentChangedTimeout();
  urlSync.clearCaretSyncTimer();
  editMode.value = false;
  editorLine.value = null;
  editorInitialLine.value = null;
  noteDirty.value = false;
  unsavedChanges.value = false;
  setBeforeUnloadConfirmation(false);
  publishTitle();
  publish(TOPICS.NOTE_EDIT_END, { path: note.value.path });
  saveOwner.end();
}

// Persist the work without any navigation of its own — used when a pending
// navigation is gated on it. The gated navigation commits the URL change.
function saveForNavigation() { return saveOwner.saveForNavigation(); }

function closeNote() {
  if (isContentChanged() || queueState.value.unresolved) return;
  const acknowledgedPath = saveOwner.queueState()?.acknowledged?.path;
  exitEditState();
  if (acknowledgedPath) router.push({ path: notePath(acknowledgedPath), hash: "" });
  else router.push({ name: "home" });
}

// Content Change Watcher
function startContentChangedTimeout() {
  clearContentChangedTimeout();
  contentChangedTimeout = setTimeout(contentChangedHandler, 1000);
}

function clearContentChangedTimeout() {
  if (contentChangedTimeout != null) {
    clearTimeout(contentChangedTimeout);
  }
}

function contentChangedHandler() {
  if (isContentChanged()) {
    unsavedChanges.value = true;
    setBeforeUnloadConfirmation(true);
    saveDraft();
  } else {
    unsavedChanges.value = false;
    setBeforeUnloadConfirmation(false);
    clearDraft();
  }
}

// Drafts
function saveDraft() {
  drafts.save(newPath.value, currentBuffer(), contentRevision.value);
}

function clearDraft() {
  drafts.clear();
}

function loadDraft() {
  return drafts.load(newPath.value, contentRevision.value);
}

// Editor action channel: this view owns save/exit/toggle-edit/source-mode
// (they drive note state, not editor state). Input sources — keybinding
// layers today, command palette later — publish the topics; the handlers
// live here.
let editorActionUnsubs = [];
onMounted(() => {
  editorActionUnsubs = [
    subscribe(TOPICS.EDITOR_SAVE, () => { if(isActionAvailable(TOPICS.EDITOR_SAVE))saveHandler(false); }),
    subscribe(TOPICS.EDITOR_SAVE_CLOSE, () => { if(isActionAvailable(TOPICS.EDITOR_SAVE_CLOSE))saveHandler(true); }),
    subscribe(TOPICS.EDITOR_EXIT_EDIT, () => { if(isActionAvailable(TOPICS.EDITOR_EXIT_EDIT))closeHandler(); }),
    subscribe(TOPICS.EDITOR_TOGGLE_EDIT, () => {
      if(!isActionAvailable(TOPICS.EDITOR_TOGGLE_EDIT))return;
      if (editMode.value) {
        closeHandler();
      } else if (canModify.value) {
        editHandler(true);
      }
    }),
    subscribe(TOPICS.EDITOR_TOGGLE_SOURCE_MODE, () => {
      if(!isActionAvailable(TOPICS.EDITOR_TOGGLE_SOURCE_MODE))return;
      if (editMode.value) {
        setEditorMode(
          editorMode.value === "markdown" ? "wysiwyg" : "markdown",
        );
      }
    }),
  ];
});

function createFromWikilink() {
  router.push(newNoteTarget({ path: props.path }));
}

function saveDefaultEditorMode() {
  // Preview unmounts the editor — nothing new to persist (the pref was
  // already written when the user switched into preview).
  if (!editor.value) return;
  const isWysiwygMode = editor.value.isWysiwygMode();
  setDefaultEditorMode(isWysiwygMode ? "wysiwyg" : "markdown");
}

function isContentChanged() {
  if (queueState.value.unresolved) return true;
  if (!editMode.value) return false;
  const acknowledged = saveOwner.queueState()?.acknowledged ?? note.value;
  return newPath.value !== acknowledged.path || currentBuffer() !== (acknowledged.content ?? "");
}

watch(currentResourceIdentity, init);
// URL-driven #view:L navigation while already viewing (same note): the
// route update path doesn't reload the note, so pick up the highlight here.
watch(
  () => route.hash,
  (hash) => {
    if (editMode.value) return;
    const frag = parseFragment(hash);
    viewLine.value = viewLineFromFragment(frag, viewLine.value);
  },
);
// A keybinding-layer switch or a client-plugin toggle recreates the
// WYSIWYG editor (:key above). Capture the current content first so the
// remount keeps the user's work (pre-flush: runs before Vue re-renders
// with the new key).
watch([currentLayerId, clientPluginEpoch], () => {
  if (editMode.value && editorMode.value === "wysiwyg" && editor.value) {
    editorInitialValue.value = currentBuffer();
  }
});
onMounted(() => {
  init();
});
// The content-change debounce can outlive the editor (close/leave within 1s
// of typing); drop it so the callback never dereferences a dead editor.
onBeforeUnmount(() => {
  preview.dispose();
  if (titleFollowTimer) clearTimeout(titleFollowTimer);
  loadGeneration++;
  saveOwner.dispose();
  disposeSessionParticipant();
  if (pendingSessionDecision) {
    pendingSessionDecision("cancel");
    pendingSessionDecision = null;
  }
  clearContentChangedTimeout();
  editorActionUnsubs.forEach((fn) => fn());
  editorActionUnsubs = [];
});
onBeforeRouteUpdate(async (to) => {
  if (!(await gateNavigation(to))) return false;
});
onBeforeRouteLeave(async (to) => {
  if (!(await gateNavigation(to))) return false;
});
</script>
