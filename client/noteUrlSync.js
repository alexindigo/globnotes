import { createUuid } from "../shared/uuid.ts";
import { serializeFragment } from "./fragment.js";
import { appRelativePath, notePath } from "./notePath.js";

/** State-to-URL owner. Readers preserve the live state at each write/timer fire;
 * router path strings retain literal slashes and router history bookkeeping.
 */
export function createNoteUrlSync({
  router,
  ownerId,
  getState,
  getPath,
  getLocation = () => window.location,
}) {
  let caretSyncTimer = null;
  let acknowledgementTransition = null;

  // Every state publication has one-shot guard authority. Save publications
  // additionally carry resource/session authority for the resulting prop update.
  async function writeRoute(fullPath, push, acknowledgement = null) {
    const token = { ownerId, fullPath, nonce: createUuid(), guardConsumed: false, ...acknowledgement };
    acknowledgementTransition = token;
    let applied = false;
    try {
      if (push) await router.push(fullPath);
      else await router.replace(fullPath);
      applied = router.currentRoute.value.fullPath === fullPath;
      if (acknowledgement && !applied) throw new Error("Save committed, but its canonical route could not be applied. Work is retained.");
    } finally {
      // Failed/duplicated/cancelled writes must not authorize a later visit to
      // the same URL. An older completion cannot retire a newer publication.
      if (acknowledgementTransition === token &&
          (!acknowledgement || !applied || getPath() === token.path)) acknowledgementTransition = null;
    }
  }

  function currentFragment() {
    const state = getState();
    if (!state.editMode) return { mode: "view", line: state.viewLine };
    if (state.editorMode === "wysiwyg") return { mode: "edit" };
    return { mode: "source", line: state.editorLine };
  }

  function writeFragment(frag, push = false) {
    // New notes live at /_/new — no note path to attach a fragment to.
    if (getState().isNewNote) return;
    const hash = serializeFragment(frag);
    const location = getLocation();
    if (location.hash === hash) return;
    const url = appRelativePath(location.pathname, router.options.history.base) + location.search + hash;
    return writeRoute(url, push);
  }

  function writeCurrentFragment(push = false) {
    return writeFragment(currentFragment(), push);
  }

  function clearCaretSyncTimer() {
    if (caretSyncTimer != null) {
      clearTimeout(caretSyncTimer);
      caretSyncTimer = null;
    }
  }

  function scheduleCaretSync() {
    clearCaretSyncTimer();
    // Continuous selection state replaces in place, never one entry per key.
    caretSyncTimer = setTimeout(() => {
      caretSyncTimer = null;
      writeCurrentFragment();
    }, 120);
  }

  function state() {
    return { acknowledgementTransition: acknowledgementTransition ? { ...acknowledgementTransition } : null };
  }

  function consumeAcknowledgementGuard() {
    if (acknowledgementTransition) acknowledgementTransition.guardConsumed = true;
  }

  function consumeAcknowledgedResource(path, sessionId) {
    if (acknowledgementTransition?.submissionId != null && acknowledgementTransition.guardConsumed && path === acknowledgementTransition.path && sessionId === acknowledgementTransition.sessionId) {
      acknowledgementTransition = null;
      return true;
    }
    return false;
  }

  async function canonicalSaveRoute(snapshot, path) {
    const hash = serializeFragment(currentFragment());
    const fullPath = notePath(path) + hash;
    if (router.currentRoute.value.fullPath === fullPath) return;
    await writeRoute(fullPath, false, { sessionId: snapshot.sessionId, submissionId: snapshot.submissionId, path });
  }

  return {
    state,
    writeFragment,
    writeCurrentFragment,
    scheduleCaretSync,
    clearCaretSyncTimer,
    consumeAcknowledgementGuard,
    consumeAcknowledgedResource,
    canonicalSaveRoute,
  };
}
