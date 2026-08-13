<template>
  <!-- Confirm Deletion Modal -->
  <ConfirmModal
    v-model="isDeleteModalVisible"
    title="Confirm Deletion"
    :message="`Are you sure you want to delete the note '${note.title}'?`"
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
    @confirm="saveHandler((close = true))"
    @reject="closeNote"
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
    <!-- Header (sits outside the scrollable content) -->
    <div>
      <div class="flex flex-col-reverse md:flex-row md:items-baseline">
        <!-- Title -->
        <div class="min-w-0 grow">
          <div class="truncate text-3xl leading-[1.6em]">
            <span v-show="!editMode" :title="note.title">{{
              noteBasename
            }}</span>
            <input
              v-show="editMode"
              v-model.trim="newTitle"
              class="w-full bg-theme-background outline-none"
              placeholder="Title"
            />
          </div>
          <div
            v-show="!editMode && noteDirName"
            class="truncate pt-1 text-sm text-theme-text-muted"
            :title="note.title"
          >
            <template v-for="(crumb, i) in noteDirBreadcrumbs" :key="i">
              <span v-if="crumb.ellipsis">…/</span>
              <RouterLink
                v-else
                :to="folderTarget(crumb.folder)"
                class="hover:text-theme-text hover:underline"
                >{{ crumb.label }}/</RouterLink
              >
            </template>
          </div>
        </div>

        <!-- Buttons -->
        <div class="flex shrink-0 self-end md:self-end print:hidden">
          <!-- Delete Button -->
          <CustomButton
            v-show="canModify && !isNewNote"
            label="Delete"
            :iconPath="mdilDelete"
            @click="deleteHandler"
          />
          <!-- Save Button -->
          <CustomButton
            v-show="editMode"
            label="Save"
            :iconPath="mdilContentSave"
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
            :isOn="editMode"
            class="ml-1"
            @click="toggleEditModeHandler"
          />
        </div>
      </div>

      <hr v-if="!editMode" class="mt-2 mb-4 border-theme-border" />
    </div>

    <!-- Content (scrolls internally; the header never moves) -->
    <div class="min-h-0 flex-1 overflow-y-auto print:overflow-visible">
      <ToastViewer
        v-if="!editMode"
        :initialValue="note.content"
        class="toast-viewer pb-4"
      />
      <ToastEditor
        v-if="editMode"
        ref="toastEditor"
        :initialValue="getInitialEditorValue()"
        :initialEditType="loadDefaultEditorMode()"
        :addImageBlobHook="addImageBlobHook"
        @change="startContentChangedTimeout"
        @keydown="keydownHandler"
      />
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
import { mdiNoteOffOutline } from "@mdi/js";
import { mdilContentSave, mdilDelete } from "@mdi/light-js";
import Mousetrap from "mousetrap";
import { useToast } from "primevue/usetoast";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { onBeforeRouteUpdate, useRoute, useRouter } from "vue-router";

import {
  apiErrorHandler,
  createNote,
  deleteNote,
  getNote,
  updateNote,
  uploadFile,
} from "../api.js";
import { Note } from "../classes.js";
import ConfirmModal from "../components/ConfirmModal.vue";
import CustomButton from "../components/CustomButton.vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import Toggle from "../components/Toggle.vue";
import ToastEditor from "../components/toastui/ToastEditor.vue";
import ToastViewer from "../components/toastui/ToastViewer.vue";
import { authTypes, params } from "../constants.js";
import { useGlobalStore } from "../globalStore.js";
import {
  directoryFromTitle,
  getToastOptions,
  nextUntitledTitle,
} from "../helpers.js";
import { refreshNoteIndex } from "../noteIndex.js";
import { notePath } from "../notePath.js";
import { isCurrentTokenStored } from "../tokenStorage.js";

const props = defineProps({
  title: String,
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
const isNewNote = computed(() => !props.title);
const loadingIndicator = ref();
const note = ref({});
const noteDirName = computed(() =>
  directoryFromTitle(note.value.title || props.title || ""),
);
const noteBasename = computed(() => {
  const title = note.value.title || props.title || "";
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
const newTitle = ref();
const toast = useToast();
const toastEditor = ref();
const unsavedChanges = ref(false);

function init() {
  // Return if we already have the note e.g. When we rename a note, the route prop would change but we’d already have the note.
  if (props.title && props.title == note.value.title) {
    return;
  }
  loadingIndicator.value.setLoading();
  if (props.title) {
    getNote(props.title)
      .then((data) => {
        note.value = data;
        loadingIndicator.value.setLoaded();
      })
      .catch((error) => {
        if (error.response?.status === 404) {
          loadingIndicator.value.setFailed("Note not found", mdiNoteOffOutline);
        } else {
          loadingIndicator.value.setFailed();
          apiErrorHandler(error, toast);
        }
      });
  } else {
    const folder = route.query.folder || "";
    const explicitTitle = route.query.title;
    let prefillTitle;
    if (explicitTitle) {
      prefillTitle = explicitTitle;
    } else {
      prefillTitle = nextUntitledTitle(
        globalStore.noteTitles || [],
        folder,
      );
    }
    newTitle.value = prefillTitle;
    note.value = new Note({ title: prefillTitle });
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
    editHandler();
  }
}

function editHandler() {
  const draftContent = loadDraft();
  if (draftContent) {
    isDraftModalVisible.value = true;
  } else {
    setEditMode();
  }
}

function setEditMode() {
  newTitle.value = note.value.title;
  unsavedChanges.value = false;
  editMode.value = true;
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
  deleteNote(note.value.title)
    .then(() => {
      refreshNoteIndex();
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

  // Empty Title Validation
  if (!newTitle.value) {
    toast.add(
      getToastOptions("Cannot save note without a title.", "Invalid", "error"),
    );
    return;
  }

  // Invalid Character Validation
  if (reservedFilenameCharacters.test(newTitle.value)) {
    badFilenameToast("Title");
    return;
  }

  // Save Note
  let newContent = toastEditor.value.getMarkdown();
  if (isNewNote.value) {
    saveNew(newTitle.value, newContent, close);
  } else {
    saveExisting(newTitle.value, newContent, close);
  }
}

function saveNew(newTitle, newContent, close = false) {
  createNote(newTitle, newContent)
    .then((data) => {
      clearDraft();
      note.value = data;
      refreshNoteIndex();
      router
        .push(notePath(note.value.title))
        .then(() => {
          // Wait for the route to be updated before setting edit mode to false
          // as the route is used to determine the action.
          noteSaveSuccess(close);
        });
    })
    .catch(noteSaveFailure);
}

function saveExisting(newTitle, newContent, close = false) {
  // Return if no changes
  if (newTitle == note.value.title && newContent == note.value.content) {
    noteSaveSuccess(close);
    return;
  }

  const oldTitle = note.value.title;
  updateNote(oldTitle, newTitle, newContent)
    .then((data) => {
      clearDraft();
      note.value = data;
      if (oldTitle != data.title) {
        refreshNoteIndex();
      }
      router.replace(notePath(note.value.title));
      noteSaveSuccess(close);
    })
    .catch(noteSaveFailure);
}

function noteSaveFailure(error) {
  if (error.response?.status === 409) {
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
  if (close) {
    closeNote();
  }
  setBeforeUnloadConfirmation(false);
  toast.add(getToastOptions("Note saved successfully ✓", "Success", "success"));
}

// Note Closure
function closeHandler() {
  if (isContentChanged()) {
    isSaveChangesModalVisible.value = true;
  } else {
    closeNote();
  }
}

function closeNote() {
  clearDraft();
  editMode.value = false;
  if (isNewNote.value) {
    router.push({ name: "home" });
  } else {
    editMode.value = false;
  }
}

// Image Upload
function addImageBlobHook(file, callback) {
  const altTextInputValue = document.getElementById(
    "toastuiAltTextInput",
  )?.value;

  // Upload the image then use the callback to insert the URL into the editor
  postAttachment(file).then(function (data) {
    if (data) {
      // If the user has entered an alt text, use it. Otherwise, use the filename returned by the API.
      const altText = altTextInputValue ? altTextInputValue : data.filename;
      callback(data.url, altText);
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
  const content = toastEditor.value.getMarkdown();
  const userHasPersistedToken = isCurrentTokenStored();
  const draftKey = newTitle.value;
  if (content && draftKey) {
    if (userHasPersistedToken) {
      localStorage.setItem(draftKey, content);
    } else {
      sessionStorage.setItem(draftKey, content);
    }
  }
}

function clearDraft() {
  const draftKey = newTitle.value;
  if (draftKey) {
    localStorage.removeItem(draftKey);
    sessionStorage.removeItem(draftKey);
  }
}

function loadDraft() {
  const draftKey = newTitle.value;
  if (!draftKey) return null;
  const localDraft = localStorage.getItem(draftKey);
  const sessionDraft = sessionStorage.getItem(draftKey);
  return localDraft || sessionDraft;
}

// Keyboard Shortcuts
// 'e' to edit
Mousetrap.bind("e", () => {
  if (editMode.value === false && canModify.value) {
    editHandler();
  }
});

function keydownHandler(event) {
  // Ctrl + Enter to save
  if ((event.ctrlKey || event.metaKey) && event.key == "Enter") {
    saveHandler((close = false));
  }
  // Escape to exit edit mode
  if (event.key == "Escape") {
    closeHandler();
  }
}

// Helpers
function noteDirectory() {
  // The directory of the note being edited (falling back to the note being
  // viewed), so uploads land beside the note.
  return directoryFromTitle(newTitle.value || props.title || "");
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
  const isWysiwygMode = toastEditor.value.isWysiwygMode();
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
  return (
    newTitle.value != note.value.title ||
    toastEditor.value.getMarkdown() != note.value.content
  );
}

watch(() => props.title, init);
onMounted(init);
onBeforeRouteUpdate((to) => {
  if (!to.params.title) init();
});
</script>
