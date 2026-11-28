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
  let canonicalPublication = null, resourceAcknowledgement = null;
  let retired = false;
  const guardedEffects = new WeakMap();
  const stopRoutes = router.afterEach?.(routeCommitted);
  const stopValidation = router.beforeResolve?.(to => {
    const current = guardedEffects.get(to)?.current ??
      (acknowledgementTransition?.fullPath === to.fullPath ? validators.get(acknowledgementTransition) : undefined);
    return current?.() !== false;
  });

  // Every state publication has one-shot guard authority. Save publications
  // additionally carry resource/session authority for the resulting prop update.
  async function writeRoute(fullPath, push, acknowledgement = null, effect, current) {
    const token = { ownerId, fullPath, nonce: createUuid(), guardConsumed: false, changesMode: !!effect, ...acknowledgement };
    acknowledgementTransition = token;
    if (acknowledgement) resourceAcknowledgement = token;
    if (current) validators.set(token, current);
    let applied = false;
    try {
      const settled = push ? router.push(fullPath) : router.replace(fullPath);
      // Real router calls settle asynchronously, after history publication.
      const failure = settled === undefined ? undefined : await settled;
      applied = router.currentRoute.value.fullPath === fullPath;
      if (effect) {
        if (!applied || failure || retired || acknowledgementTransition !== token || !current()) return false;
        effect();
        return true;
      }
      if (acknowledgement && !applied) throw new Error("Save committed, but its canonical route could not be applied. Work is retained.");
    } finally {
      // Failed/duplicated/cancelled writes must not authorize a later visit to
      // the same URL. An older completion cannot retire a newer publication.
      if (acknowledgementTransition === token &&
          (!acknowledgement || !applied || getPath() === token.path)) acknowledgementTransition = null;
      if (resourceAcknowledgement === token && (!applied || getPath() === token.path)) resourceAcknowledgement = null;
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
    if (retired || canonicalPublication || getState().isNewNote) return;
    const hash = serializeFragment(frag);
    const location = getLocation();
    if (location.hash === hash) return;
    const url = appRelativePath(location.pathname, router.options.history.base) + location.search + hash;
    return writeRoute(url, push);
  }

  function writeCurrentFragment(push = false) {
    return writeFragment(currentFragment(), push);
  }

  function changeFragment(fragment, effect, current) {
    if (retired || acknowledgementTransition?.changesMode || !current()) return false;
    clearCaretSyncTimer();
    if (canonicalPublication) {
      const publication = canonicalPublication;
      publication.fragment?.resolve(false);
      return new Promise((resolve, reject) => {
        publication.fragment = { fragment, effect, current, resolve, reject };
      });
    }
    const hash = serializeFragment(fragment), location = getLocation();
    const target = appRelativePath(location.pathname, router.options.history.base) + location.search + hash;
    if (router.currentRoute.value.fullPath === target || getState().isNewNote && router.currentRoute.value.name === "new") {
      effect();
      return true;
    }
    return writeRoute(target, true, null, effect, current);
  }

  const validators = new WeakMap();
  function stageRouteEffect(to, effect, current = () => true) {
    if (retired || !current()) return false;
    guardedEffects.set(to, { effect, current });
    return true;
  }

  function routeCommitted(to, _from, failure) {
    const effect = guardedEffects.get(to);
    guardedEffects.delete(to);
    if (!failure && !retired && effect?.current()) effect.effect?.();
  }

  function dispose() {
    retired = true;
    clearCaretSyncTimer();
    acknowledgementTransition = null;
    resourceAcknowledgement = null;
    canonicalPublication?.fragment?.resolve(false);
    canonicalPublication = null;
    stopValidation?.();
    stopRoutes?.();
  }

  function clearCaretSyncTimer() {
    if (caretSyncTimer != null) {
      clearTimeout(caretSyncTimer);
      caretSyncTimer = null;
    }
  }

  function scheduleCaretSync() {
    clearCaretSyncTimer();
    if (acknowledgementTransition?.changesMode || canonicalPublication || acknowledgementTransition?.submissionId != null || retired) return;
    // Continuous selection state replaces in place, never one entry per key.
    caretSyncTimer = setTimeout(() => {
      caretSyncTimer = null;
      writeCurrentFragment();
    }, 120);
  }

  function state() {
    return { acknowledgementTransition: acknowledgementTransition ? { ...acknowledgementTransition } : null };
  }

  function consumeAcknowledgementGuard(to) {
    if (!acknowledgementTransition) return true;
    acknowledgementTransition.guardConsumed = true;
    const current = validators.get(acknowledgementTransition);
    return to && current ? stageRouteEffect(to, undefined, current) : true;
  }

  function consumeAcknowledgedResource(path, sessionId) {
    const receipt = resourceAcknowledgement;
    if (receipt?.guardConsumed && path === receipt.path && sessionId === receipt.sessionId) {
      if (acknowledgementTransition === receipt) acknowledgementTransition = null;
      resourceAcknowledgement = null;
      return true;
    }
    return false;
  }

  async function canonicalSaveRoute(snapshot, path) {
    const resource = notePath(path);
    const route = router.currentRoute.value;
    // A save acknowledges the resource, not its caret or query. When the
    // resource is unchanged, let the editor's own fragment publication finish.
    if ((route.path ?? route.fullPath.split(/[?#]/, 1)[0]) === resource) return;
    // A rename/create owns the URL until that resource has been published.
    clearCaretSyncTimer();
    const hash = serializeFragment(currentFragment());
    canonicalPublication?.fragment?.resolve(false);
    const publication = { fragment: null };
    canonicalPublication = publication;
    let applied = false;
    try {
      await writeRoute(resource + hash, false, { sessionId: snapshot.sessionId, submissionId: snapshot.submissionId, path });
      applied = true;
    } finally {
      const owns = canonicalPublication === publication;
      if (owns) canonicalPublication = null;
      const intent = publication.fragment;
      if (intent) {
        if (!owns || retired || !applied || !intent.current() || router.currentRoute.value.fullPath !== resource + hash) intent.resolve(false);
        else {
          const target = resource + serializeFragment(intent.fragment);
          if (target === resource + hash) { intent.effect(); intent.resolve(true); }
          else writeRoute(target, true, null, intent.effect, intent.current).then(intent.resolve, intent.reject);
        }
      }
    }
  }

  return {
    state,
    writeFragment,
    writeCurrentFragment,
    changeFragment,
    stageRouteEffect,
    routeCommitted,
    dispose,
    scheduleCaretSync,
    clearCaretSyncTimer,
    consumeAcknowledgementGuard,
    consumeAcknowledgedResource,
    canonicalSaveRoute,
  };
}
