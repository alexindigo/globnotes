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
    if (push) router.push(url);
    else router.replace(url);
  }

  function writeCurrentFragment(push = false) {
    writeFragment(currentFragment(), push);
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
    acknowledgementTransition.guardConsumed = true;
  }

  function consumeAcknowledgedResource(path, sessionId) {
    if (acknowledgementTransition?.guardConsumed && path === acknowledgementTransition.path && sessionId === acknowledgementTransition.sessionId) {
      acknowledgementTransition = null;
      return true;
    }
    return false;
  }

  async function canonicalSaveRoute(snapshot, path) {
    const hash = serializeFragment(currentFragment());
    const fullPath = notePath(path) + hash;
    if (router.currentRoute.value.fullPath === fullPath) return;
    const token = { ownerId, sessionId: snapshot.sessionId, submissionId: snapshot.submissionId, fullPath, path, nonce: createUuid(), guardConsumed: false };
    acknowledgementTransition = token;
    await router.replace(fullPath);
    if (router.currentRoute.value.fullPath !== fullPath) throw new Error("Save committed, but its canonical route could not be applied. Work is retained.");
    if (getPath() === path && acknowledgementTransition === token) acknowledgementTransition = null;
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
