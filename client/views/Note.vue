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
    message="Do you want to save your changes?"
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
      v-model:visible="renameAssetsModalVisible"
      :refs="renameRefs"
      @confirm="onRenameDialogConfirm"
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
              @input="syncTitle"
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
                :to="folderTarget(crumb.folder)"
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
            :iconPath="tabSave"
            @click="saveHandler((close = false))"
            class="relative ml-1"
          >
            <!-- Unsaved Changes Indicator -->
            <div
              v-show="unsavedChanges"
              class="absolute right-1 h-1.5 w-1.5 rounded-full bg-theme-brand"
            ></div>
          </CustomButton>
          <!-- Edit Toggle -->
          <Toggle
            v-if="canModify"
            label="Edit"
            :iconPath="tabEdit"
            :isOn="editMode"
            class="ml-1"
            @click="toggleEditModeHandler"
          />
        </div>
      </div>

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
import { tabSave, tabTrash, tabEdit } from "../icons.js";
import Icon from "../components/Icon.vue";
import { useToast } from "primevue/usetoast";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from "vue-router";

import {
  apiErrorHandler,
  createNote,
  deleteNote,
  getNote,
  getNotes,
  getPlugins,
  previewRename,
  renderBuffer,
  updateNote,
  uploadFile,
} from "../api.js";
import { disabledPluginIds } from "../pluginSettings.js";
import { Note } from "../classes.js";
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
import { rewriteRenamedLinks } from "../links.js";
import {
  directoryFromPath,
  getToastOptions,
  nextUntitledPath,
} from "../helpers.js";
import { parseFragment, serializeFragment } from "../fragment.js";
import { publish, subscribe, TOPICS } from "../bus/index.js";
import { currentLayerId } from "../keybindings/store.js";
import { clientPluginEpoch } from "../pluginLoader.js";
import { notePath } from "../notePath.js";
import { notePathError } from "../validators.js";
import { isCurrentTokenStored } from "../tokenStorage.js";

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
  const title = note.value.path || props.path || "";
  const dir = noteDirName.value;
  return dir ? title.slice(dir.length + 1) : title;
});
// The path as breadcrumb links; each section links to its folder view.
// Long paths keep two sections on each side of a non-linked ellipsis.
const noteDirBreadcrumbs = computed(() => {
  const dir = noteDirName.value;
  if (!dir) {
    return [];
  }
  const parts = dir.split("/");
  const toCrumb = (label, i) => ({
    label,
    folder: parts.slice(0, i + 1).join("/"),
  });
  if (dir.length <= 60) {
    return parts.map(toCrumb);
  }
  const lead = parts.slice(0, 2).map(toCrumb);
  const trail = parts
    .slice(-2)
    .map((label, i) => toCrumb(label, parts.length - 2 + i));
  return [...lead, { ellipsis: true }, ...trail];
});

function folderTarget(folder) {
  return {
    name: "search",
    query: { [params.searchTerm]: "*", [params.folder]: folder },
  };
}
const reservedFilenameCharacters = /[<>:"\\|?*]/;
const route = useRoute();
const router = useRouter();
const newPath = ref();
const editBasename = ref("");
const editFolder = ref("");
const folderDatalistId = "folder-datalist";
const renameAssetsModalVisible = ref(false);
const renameRefs = ref([]);
let resolveRenameDialog = null;
const lastMovedFiles = ref([]);
const rewriteScanLink = computed(() => {
  const files = lastMovedFiles.value;
  if (!files.length) return "";
  const param = encodeURIComponent(JSON.stringify(files));
  return `/_/search?${params.searchTerm}=*&rewriteFiles=${param}`;
});
const toast = useToast();
const editor = ref();
const editorKey = computed(
  () => `${currentLayerId.value}:${clientPluginEpoch.value}`,
);
const editorMode = ref(loadDefaultEditorMode());
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
// View-mode line-link target (from the #view:L fragment) — read by
// ServerViewer's highlight.
const viewLine = ref(null);

function setEditorMode(mode, writeUrl = true) {
  if (mode === editorMode.value) return;
  clearCaretSyncTimer();
  // Transfer content across the remount; persist the pref immediately.
  if (editor.value) {
    editorInitialValue.value = editor.value.getMarkdown();
  }
  editorMode.value = mode;
  if (mode !== "preview") {
    // Preview is a view over the buffer, not a persisted editor pref.
    localStorage.setItem("defaultEditorMode", mode);
  }
  publish(TOPICS.EDITOR_MODE_CHANGE, { mode });
  // The caret doesn't transfer across editors; the fresh editor reports
  // its own selection once the user interacts with it.
  editorLine.value = null;
  editorInitialLine.value = null;
  if (writeUrl) writeFragment(currentFragment(), true);
  if (mode === "preview") schedulePreviewRefresh();
}

function currentFragment() {
  if (!editMode.value) return { mode: "view", line: viewLine.value };
  if (editorMode.value === "wysiwyg") return { mode: "edit" };
  return { mode: "source", line: editorLine.value };
}

// Fragment-only URL changes navigate via path STRINGS (which preserve the
// title's real slashes) rather than hash-only location objects (which make
// vue-router re-serialize the title param into %2F) or raw history calls
// (which corrupt vue-router's history.state position bookkeeping). The gate
// below guards every such navigation.
function writeFragment(frag, push = false) {
  // New notes live at /_/new — no note path to attach a fragment to.
  if (isNewNote.value) return;
  const hash = serializeFragment(frag);
  if (window.location.hash === hash) return;
  const url = window.location.pathname + window.location.search + hash;
  if (push) router.push(url);
  else router.replace(url);
}

// Caret/selection sync is continuous state — always replace in place,
// never a history entry per keystroke.
function syncNoteFragment(frag) {
  writeFragment(frag, false);
}

function onEditorInput() {
  noteDirty.value = true;
  startContentChangedTimeout();
  schedulePreviewRefresh();
}

// Preview refresh: debounced server render of the UNSAVED buffer. The
// rendered HTML reflects the editor exactly (plugins + disabled switches
// honored like the GET path) — the preview never lies about unsaved work.
let previewTimer = null;
async function schedulePreviewRefresh() {
  if (editorMode.value !== "preview") return;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    previewTimer = null;
    if (editorMode.value !== "preview") return;
    // The buffer was captured into editorInitialValue at switch time —
    // the editor is unmounted while the preview is up.
    try {
      const plugins = await getPlugins();
      previewHtml.value = await renderBuffer(
        editorInitialValue.value,
        disabledPluginIds(plugins),
      );
    } catch (e) {
      previewHtml.value = '<p class="render-error">Preview render failed.</p>';
    }
  }, 400);
}

function onSourceSelection(line) {
  editorLine.value = line;
  // State now; URL shortly — debounced so typing doesn't churn the router
  // once per keystroke.
  if (caretSyncTimer != null) clearTimeout(caretSyncTimer);
  caretSyncTimer = setTimeout(() => {
    caretSyncTimer = null;
    syncNoteFragment(currentFragment());
  }, 120);
}
const unsavedChanges = ref(false);
// Event-driven dirty state: the WYSIWYG serializer rewrites bytes on every
// round-trip without the user changing anything, so diffing editor text
// against the server copy false-positives. Change events are the truth.
const noteDirty = ref(false);
let caretSyncTimer = null;

function clearCaretSyncTimer() {
  if (caretSyncTimer != null) {
    clearTimeout(caretSyncTimer);
    caretSyncTimer = null;
  }
}

function init() {
  // Return if we already have the note e.g. When we rename a note, the route prop would change but we’d already have the note.
  if (props.path && props.path == note.value.path) {
    return;
  }
  isNoteNotFound.value = false;
  loadingIndicator.value.setLoading();
  if (props.path) {
    getNote(props.path)
      .then((data) => {
        note.value = data;
        loadingIndicator.value.setLoaded();
        enterEditFromFragment();
        // View-mode line links: #view:L highlights the rendered lines.
        const frag = parseFragment(window.location.hash);
        viewLine.value = frag.mode === "view" ? frag.line : null;
      })
      .catch((error) => {
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
    nextTick(() => {
      editHandler();
      loadingIndicator.value.setLoaded();
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
  if (!frag.mode || frag.mode === "view" || !canModify.value) return;
  pendingEditorMode = frag.mode === "edit" ? "wysiwyg" : "markdown";
  pendingInitialLine = frag.line || null;
  editHandler();
}

// --- Navigation gate ----------------------------------------------------
// The URL may only leave an edit state once that state change is resolved.
// Every router-driven navigation (links, back/forward, programmatic) passes
// through here BEFORE the URL commits: clean exits commit immediately; dirty
// exits wait on the Save/Discard/Cancel modal; cancel reverts the URL and
// keeps the session exactly where it was.
function isStayingInEditState(to) {
  if (to.name !== "note") return false;
  if (to.params.path !== note.value.path) return false;
  return !!parseFragment(to.hash).mode;
}

async function gateNavigation(to) {
  if (!editMode.value) {
    // (Re-)enter edit when the destination URL carries an edit fragment —
    // forward into an edit entry, or any fragment navigation while viewing.
    const toFrag = parseFragment(to.hash);
    if (
      canModify.value &&
      to.name === "note" &&
      to.params.path === note.value.path &&
      toFrag.mode &&
      toFrag.mode !== "view"
    ) {
      pendingEditorMode = toFrag.mode === "edit" ? "wysiwyg" : "markdown";
      pendingInitialLine = toFrag.line || null;
      editHandler();
    } else if (toFrag.mode === "view") {
      // View-mode line link: highlight, no edit entry.
      viewLine.value = toFrag.line;
    }
    return true;
  }
  if (isStayingInEditState(to)) {
    // URL-driven transition between edit states (back/forward across edit
    // entries, address-bar fragment edits): align the state to the URL —
    // never write the URL back.
    const frag = parseFragment(to.hash);
    const targetMode = frag.mode === "edit" ? "wysiwyg" : "markdown";
    // Preview's URL stays #source by design — a #source fragment while
    // previewing must not yank the user back into the source editor.
    if (!(frag.mode === "source" && editorMode.value === "preview")) {
      if (editorMode.value !== targetMode) setEditorMode(targetMode, false);
    }
    if (frag.mode === "source" && frag.line) {
      await nextTick();
      editor.value?.selectLine?.(frag.line);
    }
    return true;
  }
  if (!isContentChanged()) {
    exitEditState();
    return true;
  }
  // Dirty exit: stash the destination and block. For a browser pop, the
  // guard abort makes vue-router revert to the history entry the user was
  // on — whose URL is exactly the edit fragment, no manual repair needed.
  // For a push the address never committed. Either way the modal drives
  // the actual transition; Cancel leaves everything exactly as it was.
  const navWasPop = window.location.hash === to.hash;
  pendingNavTarget = { to, pop: navWasPop };
  isSaveChangesModalVisible.value = true;
  return false;
}

// --- Save-changes modal (Save / Discard / Cancel) ------------------------
// Shown either by the navigation gate (a destination is pending) or by the
// new-note toggle-off path (no navigation pending).
let pendingNavTarget = null;

// Commit the gated destination after the edit session ends: pop exits were
// reverted to the edit entry (vue-router restored the URL), so replace that
// entry with the target; push exits navigate for real.
function commitNavTarget(to, pop) {
  if (pop) router.replace(to.fullPath);
  else router.push(to.fullPath);
}

function onSaveChoice(choice) {
  isSaveChangesModalVisible.value = false;
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
      clearDraft();
      commit();
    }
    return;
  }
  // New-note path: no gated navigation is pending.
  if (choice === "save") saveHandler(true);
  else if (choice === "discard") {
    exitEditState();
    clearDraft();
    router.push({ name: "home" });
  }
}

function setEditMode() {
  newPath.value = note.value.path;
  editBasename.value = newPath.value
    ? newPath.value.slice(newPath.value.lastIndexOf("/") + 1)
    : "";
  editFolder.value = directoryFromPath(newPath.value);
  unsavedChanges.value = false;
  editorInitialValue.value = getInitialEditorValue();
  // A resumed draft IS unsaved work; a clean load is not.
  noteDirty.value = editorInitialValue.value != note.value.content;
  editorMode.value = pendingEditorMode || loadDefaultEditorMode();
  editorInitialLine.value = pendingInitialLine;
  editorLine.value = pendingInitialLine || null;
  pendingEditorMode = null;
  pendingInitialLine = null;
  const push = pendingPush;
  pendingPush = false;
  editMode.value = true;
  publish(TOPICS.NOTE_EDIT_START, { path: note.value.path });
  writeFragment(currentFragment(), push);
}

function syncTitle() {
  newPath.value = editFolder.value
    ? editFolder.value + "/" + editBasename.value
    : editBasename.value;
}

function getInitialEditorValue() {
  const draftContent = loadDraft();
  return draftContent ? draftContent : note.value.content;
}

// Note Deletion
function deleteHandler() {
  isDeleteModalVisible.value = true;
}

function deleteConfirmedHandler() {
  deleteNote(note.value.path)
    .then(() => {
      publish(TOPICS.NOTE_DELETE, { path: note.value.path });
      exitEditState();
      toast.add(getToastOptions("Note deleted ✓", "Success", "success"));
      router.push({ name: "home" });
    })
    .catch((error) => {
      apiErrorHandler(error, toast);
    });
}

// Note Saving
function saveHandler(close = false) {
  // Save Default Editor Mode
  saveDefaultEditorMode();

  const titleError = notePathError(newPath.value);
  if (titleError) {
    toast.add(getToastOptions(titleError, "Invalid", "error"));
    return;
  }

  // Content is on its way out; noteSaveFailure restores the flag if the
  // save doesn't land.
  noteDirty.value = false;

  // Save Note
  let newContent = editor.value.getMarkdown();
  if (isNewNote.value) {
    saveNew(newPath.value, newContent, close);
  } else {
    saveExisting(newPath.value, newContent, close);
  }
}

function saveNew(newPath, newContent, close = false) {
  createNote(newPath, newContent)
    .then((data) => {
      clearDraft();
      note.value = data;
      publish(TOPICS.NOTE_CREATE, { path: newPath });
      router
        .push(notePath(note.value.path))
        .then(() => {
          // Wait for the route to be updated before setting edit mode to false
          // as the route is used to determine the action.
          noteSaveSuccess(close);
        });
    })
    .catch(noteSaveFailure);
}

// After a rename, the client drives link updates across the vault: find
// referencing notes via search, rewrite their links client-side, and resave
// each via the normal update API. The server stays a pure file mechanism —
// it never rewrites other notes as a rename side effect. Best-effort.
async function updateRenamedLinks(oldPath, newPath) {
  try {
    const results = await getNotes(oldPath, undefined, undefined, undefined, true);
    const candidates = results
      .map((r) => r.path)
      .filter((t) => t !== oldPath && t !== newPath);
    let updated = 0;
    for (const title of candidates) {
      const other = await getNote(title);
      const newContent = rewriteRenamedLinks(
        other.content,
        oldPath,
        newPath,
        title,
      );
      if (newContent !== other.content) {
        await updateNote(title, title, newContent);
        updated++;
      }
    }
    if (updated > 0) {
      toast.add(
        getToastOptions(
          `Updated links in ${updated} note(s).`,
          "Links updated",
          "success",
        ),
      );
    }
  } catch (e) {
    // Link updates are best-effort; the rename itself already succeeded.
    console.error("link update failed", e);
  }
}

function saveExisting(newPath, newContent, close = false) {
  if (newPath == note.value.path && newContent == note.value.content) {
    noteSaveSuccess(close);
    return;
  }

  const oldPath = note.value.path;
  const oldDir = directoryFromPath(oldPath);
  const newDir = directoryFromPath(newPath);
  const folderChanged = oldDir !== newDir;

  const doSave = (fileRefs = "none") => {
    updateNote(oldPath, newPath, newContent, fileRefs)
      .then((data) => {
        clearDraft();
        note.value = data;
        // The server may have rewritten content during the save (rename
        // link/attachment strategies) — sync the open editor with it.
        if (
          editMode.value &&
          editor.value &&
          editor.value.getMarkdown() !== data.content
        ) {
          editor.value.setMarkdown(data.content);
        }
        if (oldPath != data.path) {
          publish(TOPICS.NOTE_RENAME, { oldPath, newPath: data.path });
        } else {
          publish(TOPICS.NOTE_SAVE, { path: data.path });
        }
        // Carry the fragment inside the same navigation so a rename can
        // neither drop it nor race a follow-up replaceState.
        router.replace({
          path: notePath(note.value.path),
          hash: close ? "" : serializeFragment(currentFragment()),
        });
        noteSaveSuccess(close);

        // Client drives link updates: the server is a pure mechanism.
        // Find notes referencing the old title and resave them with
        // rewritten links.
        if (oldPath !== data.path) {
          updateRenamedLinks(oldPath, data.path);
        }

        lastMovedFiles.value = data.movedFiles || [];
        if (data.movedFiles && data.movedFiles.length > 0) {
          const text =
            data.movedFiles.length === 1
              ? "1 file moved. Check referencing notes if needed."
              : `${data.movedFiles.length} files moved. Check referencing notes if needed.`;
          toast.add(
            getToastOptions(text, "Files moved", "success"),
          );
        }
      })
      .catch(noteSaveFailure);
  };

  if (folderChanged) {
    previewRename(oldPath, newPath)
      .then((refs) => {
        if (refs.length > 0) {
          renameRefs.value = refs;
          renameAssetsModalVisible.value = true;
          resolveRenameDialog = (strategy) => {
            if (strategy) doSave(strategy);
            resolveRenameDialog = null;
          };
        } else {
          doSave("none");
        }
      })
      .catch(() => doSave("none"));
  } else {
    doSave("none");
  }
}

function onRenameDialogConfirm(strategy) {
  renameAssetsModalVisible.value = false;
  if (resolveRenameDialog) {
    resolveRenameDialog(strategy);
  }
}

function noteSaveFailure(error) {
  noteDirty.value = true;
  if (error.response?.status === 400) {
    toast.add(
      getToastOptions(
        error.response.data?.detail || "Invalid note title.",
        "Invalid",
        "error",
      ),
    );
  } else if (error.response?.status === 409) {
    toast.add(
      getToastOptions(
        "A note with this title already exists. Please try again with a new title.",
        "Duplicate",
        "error",
      ),
    );
  } else if (error.response?.status === 413) {
    entityTooLargeToast("note");
  } else {
    apiErrorHandler(error, toast);
  }
}

function noteSaveSuccess(close = false) {
  unsavedChanges.value = false;
  noteDirty.value = false;
  if (close) {
    closeNote();
  } else {
    syncNoteFragment(currentFragment());
  }
  setBeforeUnloadConfirmation(false);
  toast.add(getToastOptions("Note saved successfully ✓", "Success", "success"));
}

// Note Closure
function closeHandler() {
  if (isNewNote.value) {
    // New notes live at /_/new — no note URL to gate against.
    if (isContentChanged()) {
      isSaveChangesModalVisible.value = true;
    } else {
      exitEditState();
      clearDraft();
      router.push({ name: "home" });
    }
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
  router.push(window.location.pathname + window.location.search);
}

// End the edit session in state only. Callers own the URL: either the
// navigation that triggered the exit commits it (guards), or closeNote
// writes the fragment-less URL explicitly (toggle/Esc close).
function exitEditState() {
  clearContentChangedTimeout();
  clearCaretSyncTimer();
  editMode.value = false;
  editorLine.value = null;
  editorInitialLine.value = null;
  noteDirty.value = false;
  unsavedChanges.value = false;
  setBeforeUnloadConfirmation(false);
  publish(TOPICS.NOTE_EDIT_END, { path: note.value.path });
}

// Persist the work without any navigation of its own — used when a pending
// navigation is gated on it. The gated navigation commits the URL change.
async function saveForNavigation() {
  saveDefaultEditorMode();
  const titleError = notePathError(newPath.value);
  if (titleError) {
    toast.add(getToastOptions(titleError, "Invalid", "error"));
    return false;
  }
  const newContent = editor.value.getMarkdown();
  try {
    if (isNewNote.value) {
      note.value = await createNote(newPath.value, newContent);
      publish(TOPICS.NOTE_CREATE, { path: newPath.value });
    } else {
      const oldPath = note.value.path;
      // "none": the rename-assets dialog cannot stack on the save modal;
      // attachments stay put and the link rewrite pass still runs below.
      note.value = await updateNote(
        oldPath,
        newPath.value,
        newContent,
        "none",
      );
      if (oldPath !== note.value.path) {
        publish(TOPICS.NOTE_RENAME, { oldPath, newPath: note.value.path });
        updateRenamedLinks(oldPath, note.value.path);
      } else {
        publish(TOPICS.NOTE_SAVE, { path: note.value.path });
      }
    }
    clearDraft();
    toast.add(getToastOptions("Note saved successfully ✓", "Success", "success"));
    return true;
  } catch (error) {
    noteSaveFailure(error);
    return false;
  }
}

function closeNote() {
  clearContentChangedTimeout();
  clearDraft();
  editMode.value = false;
  if (isNewNote.value) {
    router.push({ name: "home" });
  } else {
    editorLine.value = null;
    noteDirty.value = false;
    unsavedChanges.value = false;
    setBeforeUnloadConfirmation(false);
    writeFragment({ mode: null }, true);
  }
}

// Image Upload
function addImageBlobHook(file, callback) {
  // Upload the image, then the callback inserts the markdown into the
  // editor (alt text falls back to the uploaded filename).
  postAttachment(file).then(function (data) {
    if (data) {
      callback(data.url, data.filename);
    }
  });
}

function postAttachment(file) {
  // Invalid Character Validation
  if (reservedFilenameCharacters.test(file.name)) {
    badFilenameToast("Title");
    return;
  }

  // Uploading Toast
  toast.add(getToastOptions("Uploading attachment..."));

  // Upload the attachment
  return uploadFile(file, noteDirectory())
    .then((data) => {
      publish(TOPICS.FILE_UPLOAD, { name: file.name });
      // Success Toast
      toast.add(
        getToastOptions(
          "Attachment uploaded successfully ✓",
          "Success",
          "success",
        ),
      );
      return data;
    })
    .catch((error) => {
      if (error.response?.status === 409) {
        // Note: The current implementation will append a datetime to the filename if it already exists.
        // Error Toast
        toast.add(
          getToastOptions(
            "An attachment with this filename already exists.",
            "Duplicate",
            "error",
          ),
        );
      } else if (error.response?.status == 413) {
        entityTooLargeToast("attachment");
      } else {
        apiErrorHandler(error, toast);
      }
    });
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
  const content = editor.value?.getMarkdown();
  const userHasPersistedToken = isCurrentTokenStored();
  const draftKey = newPath.value;
  if (content && draftKey) {
    if (userHasPersistedToken) {
      localStorage.setItem(draftKey, content);
    } else {
      sessionStorage.setItem(draftKey, content);
    }
  }
}

function clearDraft() {
  const draftKey = newPath.value;
  if (draftKey) {
    localStorage.removeItem(draftKey);
    sessionStorage.removeItem(draftKey);
  }
}

function loadDraft() {
  const draftKey = newPath.value;
  if (!draftKey) return null;
  const localDraft = localStorage.getItem(draftKey);
  const sessionDraft = sessionStorage.getItem(draftKey);
  return localDraft || sessionDraft;
}

// Editor action channel: this view owns save/exit/toggle-edit/source-mode
// (they drive note state, not editor state). Input sources — keybinding
// layers today, command palette later — publish the topics; the handlers
// live here.
let editorActionUnsubs = [];
onMounted(() => {
  editorActionUnsubs = [
    subscribe(TOPICS.EDITOR_SAVE, () => saveHandler(false)),
    subscribe(TOPICS.EDITOR_SAVE_CLOSE, () => saveHandler(true)),
    subscribe(TOPICS.EDITOR_EXIT_EDIT, () => closeHandler()),
    subscribe(TOPICS.EDITOR_TOGGLE_EDIT, () => {
      if (editMode.value) {
        closeHandler();
      } else if (canModify.value) {
        editHandler(true);
      }
    }),
    subscribe(TOPICS.EDITOR_TOGGLE_SOURCE_MODE, () => {
      if (editMode.value) {
        setEditorMode(
          editorMode.value === "markdown" ? "wysiwyg" : "markdown",
        );
      }
    }),
  ];
});

function createFromWikilink() {
  router.push({ name: "new", query: { path: props.path } });
}

// Helpers
function noteDirectory() {
  // The directory of the note being edited (falling back to the note being
  // viewed), so uploads land beside the note.
  return directoryFromPath(newPath.value || props.path || "");
}

function entityTooLargeToast(entityName) {
  toast.add(
    getToastOptions(
      `This ${entityName} is too large. Please try again with a smaller ${entityName} or adjust your server configuration.`,
      "Failure",
      "error",
    ),
  );
}

function badFilenameToast(entityName) {
  toast.add(
    getToastOptions(
      'Due to filename restrictions, the following characters are not allowed: <>:"\\|?*',
      `Invalid ${entityName}`,
      "error",
    ),
  );
}

function setBeforeUnloadConfirmation(enable = true) {
  if (enable) {
    window.onbeforeunload = () => {
      return true;
    };
  } else {
    window.onbeforeunload = null;
  }
}

function saveDefaultEditorMode() {
  const isWysiwygMode = editor.value.isWysiwygMode();
  localStorage.setItem(
    "defaultEditorMode",
    isWysiwygMode ? "wysiwyg" : "markdown",
  );
}

function loadDefaultEditorMode() {
  const defaultWysiwygMode = localStorage.getItem("defaultEditorMode");
  return defaultWysiwygMode || "markdown";
}

function isContentChanged() {
  return newPath.value != note.value.path || noteDirty.value;
}

watch(() => props.path, init);
// URL-driven #view:L navigation while already viewing (same note): the
// route update path doesn't reload the note, so pick up the highlight here.
watch(
  () => route.hash,
  (hash) => {
    if (editMode.value) return;
    const frag = parseFragment(hash);
    if (frag.mode === "view") viewLine.value = frag.line;
    else if (!frag.mode) viewLine.value = null;
  },
);
// A keybinding-layer switch or a client-plugin toggle recreates the
// WYSIWYG editor (:key above). Capture the current content first so the
// remount keeps the user's work (pre-flush: runs before Vue re-renders
// with the new key).
watch([currentLayerId, clientPluginEpoch], () => {
  if (editMode.value && editorMode.value === "wysiwyg" && editor.value) {
    editorInitialValue.value = editor.value.getMarkdown();
  }
});
onMounted(() => {
  init();
});
// The content-change debounce can outlive the editor (close/leave within 1s
// of typing); drop it so the callback never dereferences a dead editor.
onBeforeUnmount(() => {
  clearContentChangedTimeout();
  editorActionUnsubs.forEach((fn) => fn());
  editorActionUnsubs = [];
});
onBeforeRouteUpdate(async (to) => {
  if (!(await gateNavigation(to))) return false;
  if (!to.params.path) init();
});
onBeforeRouteLeave(async (to) => {
  if (!(await gateNavigation(to))) return false;
});
</script>
