// SPDX-License-Identifier: LGPL-3.0-only
import { createNote, previewRename, updateNote } from "./api.js";
import { publish, TOPICS } from "./bus/index.js";
import { directoryFromPath } from "./helpers.js";
import { createNoteSaveQueue, NOTE_SAVE_OBSERVATION_MS } from "./noteSaveQueue.js";
import { notePathError } from "./validators.js";

const idleState = () => Object.freeze({ status: "idle", unresolved: false, queued: Object.freeze([]), jobs: Object.freeze([]), canDiscard: true });

/** Per-view save ownership. The FIFO owns writes; live readers and effect
 * callbacks keep this workflow independent of Vue and editor implementations. */
export function createNoteSaveOwner({
  ownerId,
  getState,
  getBuffer,
  isContentChanged,
  applyNote,
  applyPath,
  applyContentAcknowledgement,
  restoreContent,
  publishTitle,
  setMovedFiles,
  urlSync,
  updateRenamedLinks,
  drafts,
  requestDecision,
  closeNote,
  saveEditorPreference,
  changed = () => {},
  refreshDirtyState = () => {},
  invalid = () => {},
  held = () => {},
  failed = () => {},
  create = createNote,
  update = updateNote,
  preview = previewRename,
  publish: publishFact = publish,
}) {
  let queue = null;
  let queueSnapshot = idleState();
  let editSession = 0;
  let closeIntent = null;
  let pendingRenamePrompt = null;
  const aliases = new Set();

  const state = () => Object.freeze({ queue: queueSnapshot,
    pendingRenamePrompt: pendingRenamePrompt
      ? Object.freeze({ identity: pendingRenamePrompt.identity, refs: pendingRenamePrompt.refs })
      : null });
  const notify = () => changed(state());

  function detachRenamePrompt(prompt) {
    if (!prompt || pendingRenamePrompt !== prompt) return false;
    pendingRenamePrompt = null;
    notify();
    return true;
  }
  function revokeRenamePrompt(prompt = pendingRenamePrompt) {
    if (!detachRenamePrompt(prompt)) return;
    prompt.reject(Object.assign(new Error("Attachment preparation revoked; saves are retained."), { cancelled: true }));
  }
  function confirmRename(strategy, identity) {
    const prompt = pendingRenamePrompt;
    if (!prompt || prompt.identity !== identity || !prompt.isCurrent()) return;
    detachRenamePrompt(prompt);
    prompt.resolve(strategy);
  }
  function cancelRename(identity) {
    const prompt = pendingRenamePrompt;
    if (!prompt || prompt.identity !== identity || !prompt.isCurrent()) return;
    detachRenamePrompt(prompt);
    prompt.reject(Object.assign(new Error("Attachment preparation cancelled; saves are retained."), { cancelled: true }));
  }

  async function prepare(snapshot, context) {
    const preparingQueue = queue;
    const session = editSession;
    const isCurrent = () => context.isPreparationCurrent() && preparingQueue === queue && session === editSession && snapshot.sessionId === preparingQueue.state().sessionId;
    const requireCurrent = () => {
      if (!isCurrent()) throw new Error("Obsolete attachment preparation abandoned.");
    };
    requireCurrent();
    if (!context.sourcePath || snapshot.attachmentPolicy === "none" || directoryFromPath(context.sourcePath) === directoryFromPath(context.targetPath)) return { fileRefs: "none" };
    const refs = await preview(context.sourcePath, context.targetPath);
    requireCurrent();
    if (!Array.isArray(refs)) throw new Error("Invalid rename preview; no write was sent.");
    if (!refs.length) return { fileRefs: "none" };
    // The modal only echoes this token. Queue handles and currentness checks
    // stay private to the owner, so a view cannot bypass its intent methods.
    const identity = Object.freeze({ sessionId: snapshot.sessionId, jobId: snapshot.submissionId });
    requireCurrent();
    const fileRefs = await new Promise((resolve, reject) => {
      requireCurrent();
      pendingRenamePrompt = { identity, refs, isCurrent, resolve, reject };
      notify();
    });
    requireCurrent();
    return { fileRefs };
  }

  async function acknowledge(snapshot, result, context) {
    const newer = queue.state().queued;
    const current = getState();
    const ownsContent = current.contentRevision === snapshot.contentRevision && !newer.length;
    const ownsPath = current.pathRevision === snapshot.pathRevision && !newer.some(job => job.snapshot.pathRevision > snapshot.pathRevision);
    if (context.sourcePath) aliases.add(context.sourcePath);
    aliases.add(result.path);
    applyNote(result);
    if (ownsPath) applyPath(result.path);
    if (ownsContent && getBuffer() !== result.content) applyContentAcknowledgement(result.content);
    publishTitle();
    if (!context.sourcePath) publishFact(TOPICS.NOTE_CREATE, { path: result.path });
    else if (context.sourcePath !== result.path) publishFact(TOPICS.NOTE_RENAME, { oldPath: context.sourcePath, newPath: result.path });
    else publishFact(TOPICS.NOTE_SAVE, { path: result.path });
    setMovedFiles(result.movedFiles ?? []);
    await urlSync.canonicalSaveRoute(snapshot, result.path);
    if (context.sourcePath && context.sourcePath !== result.path) updateRenamedLinks(context.sourcePath, result.path);
  }

  function clearAcknowledgedDrafts(snapshot) {
    if (isContentChanged() || queue.state().unresolved) return;
    drafts.clearAcknowledged(snapshot.draftRevision);
  }

  function start() {
    revokeRenamePrompt();
    queue?.dispose();
    closeIntent = null;
    const current = getState();
    const startedNew = current.isNewNote;
    const sessionId = `${ownerId}:${++editSession}`;
    queue = createNoteSaveQueue({
      sessionId,
      initial: startedNew ? null : { path: current.note.path, content: current.note.content ?? "" },
      changed: snapshot => {
        queueSnapshot = snapshot;
        if (pendingRenamePrompt && !pendingRenamePrompt.isCurrent()) revokeRenamePrompt();
        notify();
        refreshDirtyState();
      },
      prepare,
      send: (snapshot, context, preparation) => context.sourcePath
        ? update(context.sourcePath, context.targetPath, snapshot.content, preparation.fileRefs)
        : create(context.targetPath, snapshot.content),
      acknowledge,
      failed: error => { closeIntent = null; failed(error); },
      canResolveLate: (_, result) => getBuffer() === result.content && getState().requestedPath === result.path,
      drained: snapshot => {
        clearAcknowledgedDrafts(snapshot);
        if (closeIntent) {
          closeIntent = null;
          resolve("Save and close").then(ok => { if (ok && queue?.state().sessionId === sessionId) closeNote(); });
        } else if (startedNew && snapshot.intent === "save" && !isContentChanged()) closeNote();
      },
    });
    queueSnapshot = queue.state();
    notify();
    if (!startedNew) aliases.add(current.note.path);
  }

  function submit(intent, attachmentPolicy) {
    const current = getState();
    const titleError = notePathError(current.requestedPath);
    if (titleError) {
      invalid(titleError);
      return null;
    }
    const receipt = queue.submit({ content: getBuffer(), requestedPath: current.requestedPath,
      contentRevision: current.contentRevision, pathRevision: current.pathRevision,
      draftKey: current.requestedPath, draftRevision: current.contentRevision, intent, attachmentPolicy });
    if (receipt.held) held();
    return receipt;
  }

  function save(close = false) {
    saveEditorPreference();
    const receipt = submit(close ? "save-close" : "save", "prompt");
    if (receipt && close && !receipt.held) closeIntent = receipt.submissionId;
    return receipt;
  }

  async function settle() {
    const settlingQueue = queue;
    if (!settlingQueue) return true;
    const before = settlingQueue.state();
    if (before.status === "paused") return before.canDiscard;
    const result = await settlingQueue.awaitSettled({ deadline: Date.now() + NOTE_SAVE_OBSERVATION_MS });
    return settlingQueue === queue && result.safe === true;
  }

  function discard() {
    if (!queue?.discard()) return false;
    drafts.clear();
    const base = queue.state().acknowledged ?? getState().note;
    applyPath(base.path);
    restoreContent(base.content ?? "");
    refreshDirtyState();
    return true;
  }

  async function saveForNavigation() {
    saveEditorPreference();
    const savingQueue = queue;
    const receipt = submit("session", "none");
    if (!receipt || receipt.held) return false;
    const outcome = await savingQueue.awaitSettled({ deadline: Date.now() + NOTE_SAVE_OBSERVATION_MS });
    return savingQueue === queue && outcome.safe && !isContentChanged();
  }

  async function resolve() {
    if (!await settle()) return false;
    if (!isContentChanged()) return true;
    const decision = await requestDecision();
    if (decision === "save") return saveForNavigation();
    if (decision === "discard") return discard();
    return false;
  }

  function dispose() {
    revokeRenamePrompt();
    queue?.dispose();
  }

  function end() {
    dispose();
    queue = null;
    queueSnapshot = idleState();
    notify();
  }

  function reset() {
    end();
    aliases.clear();
  }

  return { state, queueState: () => queue?.state(), start, reset, end, dispose,
    save, settle, discard, resolve, saveForNavigation, confirmRename, cancelRename, revokeRenamePrompt,
    ownsPath: path => aliases.has(path) || path === queue?.state().acknowledged?.path };
}
