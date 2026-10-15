// SPDX-License-Identifier: LGPL-3.0-only
import { computed, nextTick, reactive, readonly, ref, shallowRef } from "vue";
import { createUuid } from "../shared/uuid.ts";
import { apiErrorHandler, deleteNote, getNote } from "./api.js";
import { Note } from "./classes.js";
import { authTypes, params } from "./constants.js";
import { directoryFromPath, getToastOptions, nextUntitledPath } from "./helpers.js";
import { editorStateFromFragment, parseFragment, viewLineFromFragment } from "./fragment.js";
import { publish, subscribe, TOPICS } from "./bus/index.js";
import { isActionAvailable } from "./modalState.js";
import { defaultEditorMode, setDefaultEditorMode } from "./editorPreferences.js";
import { basenameOf, encodeRewriteFiles, joinNotePath, newNoteTarget, notePath, pathBreadcrumbs } from "./notePath.js";
import { displayTitle, followedBasename } from "./noteTitle.js";
import { createNoteDraftStore } from "./noteDrafts.js";
import { createNotePreview } from "./notePreview.js";
import { createNoteUrlSync } from "./noteUrlSync.js";
import { decideNavigation, noteResourceIdentity } from "./noteNavigationGate.js";
import { setBeforeUnloadConfirmation } from "./unloadGuard.js";
import { registerSessionParticipant } from "./sessionActions.js";
import { createNoteSaveOwner } from "./noteSaveOwner.js";
import { createNoteRenameLinks } from "./noteRenameLinks.js";
import { createNoteAttachments } from "./noteAttachments.js";
import { noteOperationError, noteSaveError } from "./noteErrors.js";

/** Owns a mounted note's workflow. Views supply route/context readers, effects
 * and an editor port; all decisions and buffer ownership remain here. */
export function createNoteController({
  getContext, router, toast = { add() {} },
  read = getNote, remove = deleteNote,
  getLocation = () => window.location,
  defer = nextTick,
  publish: publishFact = publish, subscribe: subscribeAction = subscribe,
  actionAvailable = isActionAvailable,
  registerParticipant = registerSessionParticipant,
  setUnload = setBeforeUnloadConfirmation,
  drafts = createNoteDraftStore(),
  previewFactory = createNotePreview,
  saveOwnerFactory = createNoteSaveOwner,
  renameLinksFactory = createNoteRenameLinks,
  attachmentsFactory = createNoteAttachments,
  getEditorPreference = () => defaultEditorMode.value,
  saveEditorPreference = setDefaultEditorMode,
  failed = error => apiErrorHandler(error, toast),
  ownerId = createUuid(),
}) {
  const canModify = computed(() => getContext().authType != authTypes.readOnly);
  const isNewNote = computed(() => !getContext().path);
  const editMode = ref(false);
  const isSaveChangesModalVisible = ref(false);
  const isDeleteModalVisible = ref(false);
  const isDraftModalVisible = ref(false);
  const isNoteNotFound = ref(false);
  const loadStatus = ref("loading");
  const note = ref({});
  const newPath = ref();
  const editBasename = ref("");
  const editFolder = ref("");
  const titleTouched = ref(false);
  const folderDatalistOptions = computed(() => {
    const dirs = new Set();
    for (const path of getContext().notePaths || []) {
      const dir = directoryFromPath(path);
      if (dir) dirs.add(dir);
    }
    return [...dirs].sort();
  });
  const noteDirName = computed(() => directoryFromPath(note.value.path || getContext().path || ""));
  const noteBasename = computed(() => {
    const path = note.value.path || getContext().path || "";
    return noteDirName.value ? basenameOf(path) : path;
  });
  const noteDirBreadcrumbs = computed(() => pathBreadcrumbs(noteDirName.value));
  const saveOwnerState = shallowRef({ pendingRenamePrompt: null });
  const renameAssetsModalVisible = computed(() => !!saveOwnerState.value.pendingRenamePrompt);
  const renameRefs = computed(() => saveOwnerState.value.pendingRenamePrompt?.refs ?? []);
  const renamePromptIdentity = computed(() => saveOwnerState.value.pendingRenamePrompt?.identity ?? null);
  const lastMovedFiles = ref([]);
  const rewriteScanLink = computed(() => {
    const files = lastMovedFiles.value;
    return files.length ? `/_/search?${params.searchTerm}=*&rewriteFiles=${encodeRewriteFiles(files)}` : "";
  });
  const notify = (message, title, severity) => toast.add(getToastOptions(message, title, severity));
  const { updateRenamedLinks } = renameLinksFactory({
    ownsPath: path => saveOwner.ownsPath(path),
    updated: count => notify(`Updated links in ${count} note(s).`, "Links updated", "success"),
  });
  const { addImageBlobHook } = attachmentsFactory({
    getState: () => ({ requestedPath: newPath.value, path: getContext().path }),
    notify: ({ title, message, severity }) => notify(message, title, severity), failed,
  });
  // The port exposes editor capabilities, never a component or its DOM/state.
  let editor = null;
  const editorMode = ref(getEditorPreference());
  const editorInitialValue = ref("");
  let pendingEditorMode = null, pendingInitialLine = null, pendingPush = false;
  const editorInitialLine = ref(null);
  const editorLine = ref(null);
  const previewHtml = ref("");
  const preview = previewFactory({ changed: ({ html }) => { previewHtml.value = html; } });
  const viewLine = ref(null);
  const unsavedChanges = ref(false);
  const noteDirty = ref(false);
  const contentRevision = ref(0), pathRevision = ref(0);
  const queueState = shallowRef({ status: "idle", unresolved: false, queued: [], jobs: [], canDiscard: true });
  const saving = computed(() => ["preparing", "sending"].includes(queueState.value.status));
  const saveFeedback = computed(() => queueState.value.status === "paused"
    ? `Saving paused at submission ${queueState.value.failure?.submissionId}. ${queueState.value.queued.length} held saves; current edits are retained. ${queueState.value.failure?.certainty === 'unknown' ? 'The write outcome is unknown; do not resend it.' : queueState.value.failure?.certainty === 'known-committed' ? 'The write committed; its UI integration failed. Do not resend it.' : ''} ${queueState.value.failure?.message ?? ''}`
    : saving.value ? `Saving… ${queueState.value.queued.length} queued.` : "");
  const saveChangesMessage = computed(() => queueState.value.unresolved
    ? "Save work is retained. Discard removes queued saves and current unsaved changes only when all sent writes have a known outcome."
    : "Do you want to save your changes?");
  let applyingAcknowledgement = false, loadGeneration = 0;
  let contentChangedTimeout = null, titleFollowTimer = null;
  let pendingNavTarget = null, pendingSessionDecision = null, pendingDecisionPromise = null;
  const resourceIdentity = computed(() => noteResourceIdentity(getContext().path, getContext().query));
  const urlSync = createNoteUrlSync({
    router, ownerId, getLocation, getPath: () => getContext().path,
    getState: () => ({ isNewNote: isNewNote.value, editMode: editMode.value,
      editorMode: editorMode.value, editorLine: editorLine.value, viewLine: viewLine.value }),
  });
  const saveOwner = saveOwnerFactory({
    ownerId,
    getState: () => ({ note: note.value, isNewNote: isNewNote.value, requestedPath: newPath.value,
      contentRevision: contentRevision.value, pathRevision: pathRevision.value }),
    getBuffer: currentBuffer, isContentChanged: isDirty,
    applyNote: result => { note.value = new Note(result); },
    applyPath: path => { newPath.value = path; editBasename.value = basenameOf(path ?? ""); editFolder.value = directoryFromPath(path ?? ""); },
    applyContentAcknowledgement: content => {
      if (!editor) editorInitialValue.value = content;
      else if (editor.applyAcknowledgement) {
        applyingAcknowledgement = true;
        try { editor.applyAcknowledgement(content); }
        finally { applyingAcknowledgement = false; }
      }
    },
    restoreContent: content => {
      editorInitialValue.value = content;
      applyingAcknowledgement = true;
      try { editor?.setMarkdown(content); }
      finally { applyingAcknowledgement = false; }
    },
    publishTitle, setMovedFiles: files => { lastMovedFiles.value = files; },
    urlSync, updateRenamedLinks, drafts, requestDecision: requestNoteDecision, closeNote,
    saveEditorPreference: saveDefaultEditorMode,
    changed: state => { saveOwnerState.value = state; queueState.value = state.queue; },
    refreshDirtyState,
    invalid: message => notify(message, "Invalid", "error"),
    held: () => notify("This Save was captured and held. The queue is paused; no retry or resume was performed.", "Save held", "error"),
    failed: noteSaveFailure,
  });

  function registerEditor(port) { editor = port; }
  function currentBuffer() {
    const snapshot = editor?.getSnapshot?.();
    if (snapshot) return snapshot.ready ? snapshot.content : editorInitialValue.value;
    return editor ? editor.getMarkdown() : editorInitialValue.value;
  }
  function setEditorMode(mode, writeUrl = true) {
    if (mode === editorMode.value) return;
    urlSync.clearCaretSyncTimer();
    if (editorMode.value === "preview") preview.cancel();
    editorInitialValue.value = currentBuffer();
    editorMode.value = mode;
    saveEditorPreference(mode);
    publishFact(TOPICS.EDITOR_MODE_CHANGE, { mode });
    editorLine.value = null; editorInitialLine.value = null;
    if (writeUrl) urlSync.writeCurrentFragment(true);
    if (mode === "preview") schedulePreviewRefresh();
  }
  function onEditorInput() {
    if (applyingAcknowledgement) return;
    contentRevision.value++;
    noteDirty.value = true;
    refreshDirtyState(); startContentChangedTimeout(); schedulePreviewRefresh(); scheduleTitleFollow(); publishTitle();
  }
  function schedulePreviewRefresh() {
    preview.schedule({ isActive: () => editorMode.value === "preview", getBuffer: () => editorInitialValue.value });
  }
  function onSourceSelection(line) { editorLine.value = line; urlSync.scheduleCaretSync(); }

  function init() {
    if (urlSync.consumeAcknowledgedResource(getContext().path, saveOwner.queueState()?.sessionId)) return;
    clearEditTimers();
    saveOwner.reset();
    const generation = ++loadGeneration, resource = resourceIdentity.value;
    const isCurrentLoad = () => generation === loadGeneration && resource === resourceIdentity.value;
    drafts.release();
    isNoteNotFound.value = false; loadStatus.value = "loading";
    if (getContext().path) {
      return read(getContext().path).then(data => {
        if (!isCurrentLoad()) return;
        note.value = data; refreshDirtyState(); loadStatus.value = "loaded"; publishTitle(); enterEditFromFragment();
        viewLine.value = viewLineFromFragment(parseFragment(getLocation().hash));
      }).catch(error => {
        if (!isCurrentLoad()) return;
        if (error.response?.status === 404) { isNoteNotFound.value = true; loadStatus.value = "loaded"; }
        else { loadStatus.value = "failed"; failed(error); }
      });
    }
    const folder = getContext().query.folder || "", explicitTitle = getContext().query.path;
    const prefillTitle = explicitTitle || nextUntitledPath(getContext().notePaths || [], folder);
    newPath.value = prefillTitle; note.value = new Note({ path: prefillTitle });
    editMode.value = false; titleTouched.value = false;
    return defer(() => {
      if (!isCurrentLoad()) return;
      editHandler(); loadStatus.value = "loaded"; publishTitle();
    });
  }
  function toggleEditModeHandler() { if (editMode.value) closeHandler(); else editHandler(true); }
  function editHandler(pushUrl = false) {
    pendingPush = pushUrl;
    if (!newPath.value && note.value.path) newPath.value = note.value.path;
    if (loadDraft()) isDraftModalVisible.value = true;
    else setEditMode();
  }
  function enterEditFromFragment(frag = parseFragment(getLocation().hash)) {
    const target = editorStateFromFragment(frag);
    if (!target || !canModify.value) return;
    pendingEditorMode = target.mode; pendingInitialLine = target.line; editHandler();
  }
  async function gateNavigation(to) {
    const saveState = saveOwner.queueState();
    const action = decideNavigation({ ...urlSync.state(), ownerId,
      sessionId: saveState?.sessionId, activeSubmissionId: saveState?.active?.submissionId,
      resourceIdentity: resourceIdentity.value, editMode: editMode.value, editorMode: editorMode.value,
      canModify: canModify.value, queue: queueState.value, dirty: isDirty() }, to);
    if (action.type === "acknowledge") { urlSync.consumeAcknowledgementGuard(); return true; }
    if (action.type === "allow") return true;
    if (action.type === "enter-edit") { pendingEditorMode = action.mode; pendingInitialLine = action.line; editHandler(); return true; }
    if (action.type === "view-line") { viewLine.value = action.line; return true; }
    if (action.type === "sync-editor") {
      if (editorMode.value !== action.mode) setEditorMode(action.mode, false);
      if (action.line) { await defer(); editor?.selectLine?.(action.line); }
      return true;
    }
    if (action.type === "exit-edit") { exitEditState(); return true; }
    const navWasPop = getLocation().hash === to.hash;
    const target = { to, pop: navWasPop, sessionId: saveOwner.queueState()?.sessionId };
    pendingNavTarget = target;
    if (action.type === "settle") {
      settlePendingWrites().then(ok => {
        if (pendingNavTarget !== target || target.sessionId !== saveOwner.queueState()?.sessionId) return;
        if (!ok) { pendingNavTarget = null; return; }
        if (isDirty()) isSaveChangesModalVisible.value = true;
        else { pendingNavTarget = null; exitEditState(); commitNavTarget(to, navWasPop); }
      });
    } else if (action.type === "prompt") isSaveChangesModalVisible.value = true;
    else pendingNavTarget = null;
    return false;
  }
  function requestNoteDecision() {
    if (pendingDecisionPromise) return pendingDecisionPromise;
    isSaveChangesModalVisible.value = true;
    pendingDecisionPromise = new Promise(resolve => { pendingSessionDecision = resolve; })
      .finally(() => { pendingDecisionPromise = null; });
    return pendingDecisionPromise;
  }
  function settlePendingWrites() { return saveOwner.settle(); }
  function discardOwnedWork() { return saveOwner.discard(); }
  function resolveOwnedWork() { return saveOwner.resolve(); }
  const disposeSessionParticipant = registerParticipant("note", {
    hasUnsavedChanges: isDirty, settlePending: settlePendingWrites, requestDecision: requestNoteDecision,
    save: saveForNavigation,
    discard: () => { if (!discardOwnedWork()) return false; exitEditState(); return true; },
  });
  function commitNavTarget(to, pop) { if (pop) router.replace(to.fullPath); else router.push(to.fullPath); }
  function onSaveChoice(choice) {
    isSaveChangesModalVisible.value = false;
    if (pendingSessionDecision) {
      const resolve = pendingSessionDecision; pendingSessionDecision = null; resolve(choice); return;
    }
    if (pendingNavTarget) {
      const { to, pop } = pendingNavTarget; pendingNavTarget = null;
      if (choice === "cancel") return;
      const commit = () => { exitEditState(); commitNavTarget(to, pop); };
      if (choice === "save") saveForNavigation().then(ok => { if (ok) commit(); });
      else if (discardOwnedWork()) commit();
      return;
    }
    if (choice === "save") saveHandler(true);
    else if (choice === "discard") {
      if (!discardOwnedWork()) return;
      exitEditState(); clearDraft(); router.push({ name: "home" });
    }
  }
  function setEditMode() {
    newPath.value = note.value.path;
    editBasename.value = basenameOf(newPath.value || ""); editFolder.value = directoryFromPath(newPath.value);
    unsavedChanges.value = false; editorInitialValue.value = getInitialEditorValue();
    noteDirty.value = editorInitialValue.value != note.value.content;
    contentRevision.value = 0; pathRevision.value = 0; saveOwner.start();
    editorMode.value = pendingEditorMode || getEditorPreference();
    editorInitialLine.value = pendingInitialLine; editorLine.value = pendingInitialLine || null;
    pendingEditorMode = null; pendingInitialLine = null;
    const push = pendingPush; pendingPush = false;
    editMode.value = true; refreshDirtyState();
    publishFact(TOPICS.NOTE_EDIT_START, { path: note.value.path }); urlSync.writeCurrentFragment(push);
  }
  function syncTitle() {
    pathRevision.value++; newPath.value = joinNotePath(editFolder.value, editBasename.value); refreshDirtyState();
  }
  function publishTitle() {
    const source = editMode.value ? currentBuffer() : (note.value.content ?? "");
    publishFact(TOPICS.NOTE_TITLE_CHANGED, { title: displayTitle(source, noteBasename.value) });
  }
  function scheduleTitleFollow() {
    if (!isNewNote.value || titleTouched.value) return;
    if (titleFollowTimer) clearTimeout(titleFollowTimer);
    titleFollowTimer = setTimeout(() => {
      titleFollowTimer = null;
      if (!isNewNote.value || titleTouched.value) return;
      const sanitized = followedBasename(currentBuffer());
      if (sanitized && sanitized !== editBasename.value) { editBasename.value = sanitized; syncTitle(); }
    }, 300);
  }
  function onTitleInput() { titleTouched.value = true; syncTitle(); }
  function getInitialEditorValue() { const draftContent = loadDraft(); return draftContent !== null ? draftContent : note.value.content ?? ""; }
  async function deleteHandler() { if (!await resolveOwnedWork()) return; isDeleteModalVisible.value = true; }
  async function deleteConfirmedHandler() {
    if (!await settlePendingWrites() || isDirty()) return;
    return remove(note.value.path).then(() => {
      publishFact(TOPICS.NOTE_DELETE, { path: note.value.path }); exitEditState();
      notify("Note deleted ✓", "Success", "success"); router.push({ name: "home" });
    }).catch(error => showNoteError(error, noteOperationError(error)));
  }
  function saveHandler(close = false) { return saveOwner.save(close); }
  function refreshDirtyState() {
    const dirty = isDirty(); unsavedChanges.value = dirty; noteDirty.value = dirty; setUnload(dirty);
  }
  function noteSaveFailure(error) { noteDirty.value = true; showNoteError(error, noteSaveError(error, queueState.value.failure)); }
  function showNoteError(error, mapped) { if (mapped) notify(mapped.message, mapped.title, "error"); else failed(error); }
  async function closeHandler() {
    if (!await resolveOwnedWork()) return;
    if (isNewNote.value) { exitEditState(); router.push({ name: "home" }); return; }
    if (getLocation().hash === "") { exitEditState(); return; }
    urlSync.writeFragment(null, true);
  }
  function exitEditState() {
    saveOwner.revokeRenamePrompt(); clearEditTimers();
    editMode.value = false; editorLine.value = null; editorInitialLine.value = null;
    noteDirty.value = false; unsavedChanges.value = false; setUnload(false);
    publishTitle(); publishFact(TOPICS.NOTE_EDIT_END, { path: note.value.path }); saveOwner.end();
  }
  function saveForNavigation() { return saveOwner.saveForNavigation(); }
  function closeNote() {
    if (isDirty() || queueState.value.unresolved) return;
    const acknowledgedPath = saveOwner.queueState()?.acknowledged?.path;
    exitEditState();
    if (acknowledgedPath) router.push({ path: notePath(acknowledgedPath), hash: "" });
    else router.push({ name: "home" });
  }
  function startContentChangedTimeout() { clearContentChangedTimeout(); contentChangedTimeout = setTimeout(contentChangedHandler, 1000); }
  function clearContentChangedTimeout() {
    if (contentChangedTimeout != null) clearTimeout(contentChangedTimeout);
    contentChangedTimeout = null;
  }
  // Every edit-session boundary retires the same owned delayed work. Preview
  // cancellation also fences an already-started render without blocking re-entry.
  function clearEditTimers() {
    clearContentChangedTimeout();
    if (titleFollowTimer != null) clearTimeout(titleFollowTimer);
    titleFollowTimer = null;
    urlSync.clearCaretSyncTimer();
    preview.cancel();
  }
  function contentChangedHandler() {
    if (isDirty()) { unsavedChanges.value = true; setUnload(true); drafts.save(newPath.value, currentBuffer(), contentRevision.value); }
    else { unsavedChanges.value = false; setUnload(false); clearDraft(); }
  }
  function clearDraft() { drafts.clear(); }
  function loadDraft() { return drafts.load(newPath.value, contentRevision.value); }
  let editorActionUnsubs = [];
  function mount() {
    editorActionUnsubs = [
      subscribeAction(TOPICS.EDITOR_SAVE, () => { if (actionAvailable(TOPICS.EDITOR_SAVE)) saveHandler(false); }),
      subscribeAction(TOPICS.EDITOR_SAVE_CLOSE, () => { if (actionAvailable(TOPICS.EDITOR_SAVE_CLOSE)) saveHandler(true); }),
      subscribeAction(TOPICS.EDITOR_EXIT_EDIT, () => { if (actionAvailable(TOPICS.EDITOR_EXIT_EDIT)) closeHandler(); }),
      subscribeAction(TOPICS.EDITOR_TOGGLE_EDIT, () => {
        if (!actionAvailable(TOPICS.EDITOR_TOGGLE_EDIT)) return;
        if (editMode.value) closeHandler(); else if (canModify.value) editHandler(true);
      }),
      subscribeAction(TOPICS.EDITOR_TOGGLE_SOURCE_MODE, () => {
        if (!actionAvailable(TOPICS.EDITOR_TOGGLE_SOURCE_MODE)) return;
        if (editMode.value) setEditorMode(editorMode.value === "markdown" ? "wysiwyg" : "markdown");
      }),
    ];
    return init();
  }
  function createFromWikilink() { router.push(newNoteTarget({ path: getContext().path })); }
  function saveDefaultEditorMode() { if (editor) saveEditorPreference(editor.isWysiwygMode() ? "wysiwyg" : "markdown"); }
  function isDirty() {
    if (queueState.value.unresolved) return true;
    if (!editMode.value) return false;
    const acknowledged = saveOwner.queueState()?.acknowledged ?? note.value;
    return newPath.value !== acknowledged.path || currentBuffer() !== (acknowledged.content ?? "");
  }
  function routeHashChanged(hash) { if (!editMode.value) viewLine.value = viewLineFromFragment(parseFragment(hash), viewLine.value); }
  function captureEditorForRemount() { if (editMode.value && editorMode.value === "wysiwyg" && editor) editorInitialValue.value = currentBuffer(); }
  function dispose() {
    clearEditTimers();
    preview.dispose();
    loadGeneration++; saveOwner.dispose(); disposeSessionParticipant();
    if (pendingSessionDecision) { pendingSessionDecision("cancel"); pendingSessionDecision = null; }
    editorActionUnsubs.forEach(fn => fn()); editorActionUnsubs = [];
  }
  const state = readonly(reactive({
    canModify, isNewNote, editMode, isSaveChangesModalVisible, isDeleteModalVisible, isDraftModalVisible,
    isNoteNotFound, loadStatus, note, editBasename, editFolder, folderDatalistOptions,
    noteDirName, noteBasename, noteDirBreadcrumbs, renameAssetsModalVisible, renameRefs, renamePromptIdentity,
    lastMovedFiles, rewriteScanLink, editorMode, editorInitialValue, editorInitialLine, viewLine,
    previewHtml, unsavedChanges, saving, saveFeedback, saveChangesMessage, resourceIdentity,
  }));
  return { state, mount, init, dispose, registerEditor, isDirty, currentBuffer, gateNavigation,
    routeHashChanged, captureEditorForRemount, addImageBlobHook,
    toggleEditModeHandler, setEditorMode, onEditorInput, onSourceSelection, setEditMode,
    syncTitle, onTitleInput, deleteHandler, deleteConfirmedHandler, saveHandler, onSaveChoice,
    clearDraft, createFromWikilink,
    confirmRename: saveOwner.confirmRename, cancelRename: saveOwner.cancelRename,
    setBasename: value => { editBasename.value = value; },
    setFolder: value => { editFolder.value = value; },
    setDecisionVisible(kind, value) {
      const decisions = { save: isSaveChangesModalVisible, delete: isDeleteModalVisible, draft: isDraftModalVisible };
      decisions[kind].value = value;
    },
  };
}
