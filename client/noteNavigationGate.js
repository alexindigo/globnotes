import { editorStateFromFragment, parseFragment, viewLineFromFragment } from "./fragment.js";

export function noteResourceIdentity(path, query) {
  return JSON.stringify(path ? ["note", path] : ["new", query.path ?? "", query.folder ?? ""]);
}

function destinationResourceIdentity(to) {
  if (to.name === "note") return noteResourceIdentity(to.params.path, to.query);
  if (to.name === "new") return noteResourceIdentity(null, to.query);
  return null;
}

/** Pure decision table for a router guard. Effects (including consuming an
 * acknowledgement, editor selection and bounded save settlement) belong to
 * the caller. No state or destination is mutated here.
 */
export function decideNavigation(state, to) {
  const transition = state.acknowledgementTransition;
  if (transition && !transition.guardConsumed && transition.ownerId === state.ownerId && transition.fullPath === to.fullPath &&
      (transition.submissionId == null ||
        (transition.sessionId === state.sessionId && transition.submissionId === state.activeSubmissionId))) {
    return { type: "acknowledge" };
  }

  const frag = parseFragment(to.hash);
  const sameResource = destinationResourceIdentity(to) === state.resourceIdentity;
  if (!state.editMode && !state.queue.unresolved) {
    const target = editorStateFromFragment(frag);
    if (state.canModify && to.name === "note" && sameResource && target) {
      return { type: "enter-edit", ...target };
    }
    if (frag.mode === "view") return { type: "view-line", line: viewLineFromFragment(frag) };
    return { type: "allow" };
  }

  if (sameResource && (to.name === "new" || ["edit", "source"].includes(frag.mode))) {
    if (to.name === "new") return { type: "allow" };
    // Preview's URL remains #source; a source fragment must keep preview mounted.
    return { type: "sync-editor", ...editorStateFromFragment(frag, state.editorMode) };
  }
  if (!state.dirty) return { type: "exit-edit" };
  if (["preparing", "sending"].includes(state.queue.status)) return { type: "settle" };
  return { type: state.queue.canDiscard ? "prompt" : "block" };
}
