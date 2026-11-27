// SPDX-License-Identifier: LGPL-3.0-only
import { createNote, previewRename, updateNote } from "./api.js";
import { publish, TOPICS } from "./bus/index.js";
import { directoryFromPath } from "./helpers.js";
import { createNoteSaveQueue, NOTE_SAVE_OBSERVATION_MS } from "./noteSaveQueue.js";
import { notePathError } from "./validators.js";
import { requestReauthentication } from "./reauthentication.js";
import { createOperationOwner } from "./operationOwner.js";
import { bindContext, retiredContext } from "./sessionContext.js";

const idleState = () => Object.freeze({ status: "idle", unresolved: false, queued: Object.freeze([]), jobs: Object.freeze([]), canDiscard: true });

/** Per-view save ownership. The FIFO owns writes; live readers and effect
 * callbacks keep this workflow independent of Vue and editor implementations. */
export function createNoteSaveOwner({
  ownerId,
  getState,
  capture = () => bindContext(() => true, () => getState().identity),
  captureAfterAuthentication = capture,
  canSettleRetiredSave = () => false,
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
  changed = () => {},
  refreshDirtyState = () => {},
  invalid = () => {},
  held = () => {},
  failed = () => {},
  draftFailed = () => {},
  saved = () => {},
  requestAuthentication = requestReauthentication,
  authenticationRequired = () => {},
  create = createNote,
  update = updateNote,
  preview = previewRename,
  publish: publishFact = publish,
}) {
  let queue = null;
  let queueSnapshot = idleState();
  let editSession = 0;
  let pendingRenamePrompt = null;
  let authentication = null;
  let routeResult, sessionLifetime = null, ownerScope, authority = null, disposed = false;
  const sent = new WeakMap();
  const pendingDrafts = new Map();
  const readOwnerScope = () => { const state = getState(); return state.ownerScope ?? state.identity; };
  const captureAuthority = current => bindContext(current, () => sessionLifetime, () => getState().canEdit !== false);
  const identityCurrent = () => !!authority?.() && getState().canEdit !== false;
  const requireIdentity = () => { if (!identityCurrent()) throw retiredContext(); };
  const operations = createOperationOwner({ owner: Object.freeze({ ownerId }),
    prepare: intent => ({ value: { ...intent } }),
    dispatch: intent => intent.sourcePath ? update(intent.sourcePath, intent.targetPath, intent.content, intent.fileRefs, intent.baseContent) : create(intent.targetPath, intent.content),
    channels: Object.fromEntries([
      ["note", applyNote], ["path", applyPath], ["content", applyContentAcknowledgement], ["title", publishTitle],
      ["fact", publishFact], ["files", setMovedFiles], ["saved", saved],
      ["draft", complete => withDraftStorage(() => complete?.())],
      ["route", (...args) => { routeResult = urlSync.canonicalSaveRoute(...args); }], ["links", updateRenamedLinks],
    ].map(([name, callback]) => [name, {
      prepare: args => ({ value: [...args] }),
      deliver: args => callback(...args),
    }])),
  });
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
    const current = authority;
    const isCurrent = () => context.isPreparationCurrent() && current?.();
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
    const original = sent.get(snapshot), own = operations;
    const { operation } = original;
    // A same-resource receipt that only echoes the submitted bytes can settle
    // the original FIFO without delivering any retired projection effects.
    if (!identityCurrent() && snapshot.intent === "save" && context.sourcePath === result.path &&
        snapshot.content === result.content && readOwnerScope() === ownerScope && canSettleRetiredSave()) {
      return { baseContent: snapshot.content };
    }
    const effect = (name, ...args) => { if (!own.deliver(operation, name, args)) throw retiredContext(); };
    effect("draft", pendingDrafts.get(snapshot.submissionId));
    const newer = queue.state().queued;
    const current = getState();
    const ownsContent = current.contentRevision === snapshot.contentRevision && !newer.length;
    const ownsPath = current.pathRevision === snapshot.pathRevision && !newer.some(job => job.snapshot.pathRevision > snapshot.pathRevision);
    if (context.sourcePath) aliases.add(context.sourcePath);
    aliases.add(result.path);
    effect("note", result);
    if (ownsPath) effect("path", result.path);
    const live = getBuffer();
    const conflict = result.saveResult?.status === "conflict";
    const merged = result.saveResult?.status === "merged";
    const transformedRename = !conflict && context.sourcePath && context.sourcePath !== result.path && snapshot.content !== result.content;
    // A text diff cannot certify reference coordinates in newer text. Keep it
    // literally and require a decision; only the unchanged sent base takes ACK.
    const rebaseConflict = !!transformedRename && live !== snapshot.content;
    if (!rebaseConflict && (ownsContent || transformedRename || (merged && live === snapshot.content)) && live !== result.content) effect("content", result.content);
    effect("title");
    if (!context.sourcePath || conflict) effect("fact", TOPICS.NOTE_CREATE, { path: result.path });
    else if (context.sourcePath !== result.path) effect("fact", TOPICS.NOTE_RENAME, { oldPath: context.sourcePath, newPath: result.path });
    else effect("fact", TOPICS.NOTE_SAVE, { path: result.path });
    effect("files", result.movedFiles ?? []);
    effect("saved", result, { originalPath: context.sourcePath, snapshot, newer: newer.length > 0 || live !== snapshot.content });
    effect("route", snapshot, result.path); await routeResult;
    if (!conflict && context.sourcePath && context.sourcePath !== result.path) effect("links", context.sourcePath, result.path);
    return { rebaseConflict, baseContent: merged && (newer.length > 0 || live !== snapshot.content) ? snapshot.content : result.content };
  }

  async function releaseSend(snapshot) {
    const original = sent.get(snapshot);
    if (!original) return;
    sent.delete(snapshot);
    await operations.release(original.operation);
  }

  function clearAcknowledgedDrafts(snapshot) {
    if (drafts.captureAcknowledgement) return;
    if (!identityCurrent() || isContentChanged() || queue.state().unresolved) return;
    withDraftStorage(() => drafts.clearAcknowledged(snapshot.draftRevision));
  }

  function withDraftStorage(operation) {
    try { return operation(); }
    catch (error) { draftFailed(error); }
  }

  function persistDraft(content = getBuffer(), current = getState()) {
    if (!identityCurrent()) return;
    // An unadmitted rename target may already hold another editor's draft.
    // Store this edit at its acknowledged path until the rename commits.
    const path = drafts.captureAcknowledgement ? queue?.state().acknowledged?.path ?? current.requestedPath : current.requestedPath;
    return withDraftStorage(() => drafts.base
      ? drafts.save(path, content, current.contentRevision, queue?.baseContent())
      : drafts.save(path, content, current.contentRevision));
  }

  function start(baseContent) {
    revokeRenamePrompt();
    queue?.dispose();
    const current = getState();
    const startedNew = current.isNewNote;
    const sessionId = `${ownerId}:${++editSession}`;
    sessionLifetime = Object.freeze({});
    ownerScope = readOwnerScope();
    authority = captureAuthority(capture());
    pendingDrafts.clear();
    queue = createNoteSaveQueue({
      sessionId,
      baseContent,
      initial: startedNew ? null : { path: current.note.path, content: current.note.content ?? "" },
      changed: snapshot => {
        queueSnapshot = snapshot;
        if (pendingRenamePrompt && !pendingRenamePrompt.isCurrent()) revokeRenamePrompt();
        notify();
        refreshDirtyState();
      },
      prepare,
      send: async (snapshot, context, preparation) => {
        requireIdentity();
        const own = operations, operation = own.operation("outcome", authority);
        sent.set(snapshot, { operation });
        const response = await own.dispatch(operation, { sourcePath: context.sourcePath, targetPath: context.targetPath,
          content: snapshot.content, fileRefs: preparation.fileRefs, baseContent: context.baseContent });
        return response.value;
      },
      acknowledge,
      releaseSend,
      cleanupFailed: error => console.error("Save cleanup failed", error),
      failed: (error, _, failure) => {
        if (failure?.authenticationRequired) recoverAuthentication(failure);
        else if (identityCurrent()) failed(error);
      },
      canResolveLate: (_, result) => identityCurrent() && getBuffer() === result.content && getState().requestedPath === result.path,
      drained: clearAcknowledgedDrafts,
    });
    queueSnapshot = queue.state();
    notify();
    if (!startedNew) aliases.add(current.note.path);
  }

  function submit(intent, attachmentPolicy) {
    if (!queue) return null;
    const current = getState();
    const titleError = notePathError(current.requestedPath);
    if (titleError) {
      invalid(titleError);
      return null;
    }
    const latest = latestSubmitted();
    const contentOnly = intent === "save" && latest;
    const requestedPath = contentOnly ? (latest.requestedPath ?? latest.path) : current.requestedPath;
    const content = getBuffer();
    if (drafts.captureAcknowledgement && content !== queue.state().acknowledged?.content) persistDraft(content, current);
    const completeDraft = drafts.captureAcknowledgement?.(current.contentRevision);
    const receipt = queue.submit({ content, requestedPath,
      contentRevision: current.contentRevision, pathRevision: contentOnly ? (latest.pathRevision ?? Math.max(0, queue.state().acknowledgedPathRevision)) : current.pathRevision,
      draftRevision: current.contentRevision, intent, attachmentPolicy });
    if (completeDraft) {
      pendingDrafts.set(receipt.submissionId, completeDraft);
      void receipt.completion.then(() => { if (pendingDrafts.get(receipt.submissionId) === completeDraft) pendingDrafts.delete(receipt.submissionId); });
    }
    // The same barrier covers every intent. Auth-paused work has a recovery
    // dialog/status already; the non-recovering failure notice would contradict it.
    if (receipt.held && !queue.state().failure?.authenticationRequired) held();
    return receipt;
  }

  function latestSubmitted() {
    const snapshot = queue?.state();
    const pending = snapshot?.queued.at(-1) ?? snapshot?.active;
    // A committed job's returned content/path is authoritative even while its
    // fallible URL/UI integration is pending or paused. Unsent/uncertain jobs
    // retain their literal submitted snapshot instead.
    return pending && !["acknowledging", "acknowledged"].includes(pending.phase)
      ? pending.snapshot : snapshot?.acknowledged;
  }

  function contentNeedsSave() {
    return !!queue && getBuffer() !== latestSubmitted()?.content;
  }

  function observeBuffer() {
    const current = queue?.state();
    if (current && !current.unresolved && getBuffer() === current.acknowledged?.content) queue.adopt(current.acknowledged);
  }

  function save(force = false) {
    if (queue?.state().failure?.authenticationRequired) {
      recoverAuthentication(queue.state().failure);
      // Capture newer typing while the original submission remains first.
      if (contentNeedsSave()) return submit("save", "none");
      return null;
    }
    if (queue?.state().rebaseConflict) {
      const error = notePathError(getState().requestedPath);
      if (error) { invalid(error); return null; }
    }
    queue?.acceptRebaseConflict();
    if (!contentNeedsSave() && (!force || queue?.state().unresolved)) return null;
    return submit("save", "none");
  }

  function recoverAuthentication(failure) {
    const recoveringQueue = queue;
    if (readOwnerScope() !== ownerScope) return;
    if (authentication?.queue === recoveringQueue && authentication.serial === failure.serial) return;
    const own = { queue: recoveringQueue, serial: failure.serial, scope: ownerScope };
    authentication = own;
    authenticationRequired();
    const stillPaused = () => queue === own.queue && queue?.state().failure?.serial === own.serial && readOwnerScope() === own.scope;
    Promise.resolve().then(() => requestAuthentication()).then(accepted => {
      if (authentication !== own) return;
      authentication = null;
      if (!accepted || !stillPaused()) return;
      // This checked, pre-write rejection alone can acquire renewed authority.
      // Every earlier operation retains its own, now-retired capture.
      const renewed = captureAfterAuthentication(own.scope);
      if (!renewed?.() || !stillPaused() || getState().canEdit === false) return;
      authority = captureAuthority(renewed);
      recoveringQueue.resumeAfterAuthentication(own.serial);
    }).catch(error => {
      if (authentication === own) authentication = null;
      if (stillPaused() && identityCurrent()) failed(error);
    });
  }

  function rename() {
    if (!queue) return true;
    const current = getState();
    const error = notePathError(current.requestedPath);
    if (error) { invalid(error); return false; }
    const latest = latestSubmitted();
    // Before creation there is only a requested name, not a file to rename.
    if (!latest) return true;
    const effectivePath = latest.requestedPath === undefined ? latest.path : queue.admittedPath(latest);
    if (current.requestedPath === effectivePath) return true;
    return !!submit("rename", "prompt");
  }

  async function settle() {
    const settlingQueue = queue;
    if (!settlingQueue) return true;
    const before = settlingQueue.state();
    if (before.status === "paused") return before.canDiscard;
    if (before.rebaseConflict && !before.active) return before.canDiscard;
    const result = await settlingQueue.awaitSettled({ deadline: Date.now() + NOTE_SAVE_OBSERVATION_MS });
    return settlingQueue === queue && result.safe === true;
  }

  function discard() {
    if (!queue?.discard()) return false;
    drafts.clear();
    const base = queue.state().acknowledged ?? getState().note;
    restoreContent(base.content ?? "");
    refreshDirtyState();
    return true;
  }

  async function saveForNavigation() {
    if (!queue) return true;
    const savingQueue = queue;
    const receipt = save();
    if ((contentNeedsSave() && !receipt) || receipt?.held) return false;
    const outcome = await savingQueue.awaitSettled({ deadline: Date.now() + NOTE_SAVE_OBSERVATION_MS });
    return savingQueue === queue && outcome.safe && !isContentChanged();
  }

  async function resolve() {
    const resolvingQueue = queue;
    if (!await settle() || resolvingQueue !== queue) return false;
    if (!isContentChanged()) return true;
    const decision = await requestDecision();
    if (resolvingQueue !== queue) return false;
    if (decision === "save") return saveForNavigation();
    if (decision === "discard") return discard();
    return false;
  }

  function dispose() {
    disposed = true;
    end();
    return operations.dispose();
  }

  function end() {
    revokeRenamePrompt();
    queue?.dispose(); sessionLifetime = null;
    queue = null;
    queueSnapshot = idleState();
    pendingDrafts.clear();
    if (!disposed) notify();
  }

  function reset() {
    end();
    aliases.clear();
  }

  return { state, queueState: () => queue?.state(), persistDraft, start, reset, end, dispose,
    adoptAuthority() { if (queue?.state().unresolved || getState().canEdit === false || readOwnerScope() !== ownerScope) return false; authority = captureAuthority(capture()); return true; },
    adopt: note => queue?.adopt(note) ?? false,
    observeBuffer,
    save, rename, latestSubmitted, contentNeedsSave, settle, discard, resolve, saveForNavigation, confirmRename, cancelRename, revokeRenamePrompt,
    ownsPath: path => aliases.has(path) || path === queue?.state().acknowledged?.path };
}
