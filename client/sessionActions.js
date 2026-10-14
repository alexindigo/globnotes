// SPDX-License-Identifier: LGPL-3.0-only

/** Guarded session handoff coordinator. The Note view (or any dirty
 * participant) registers its own unsaved-state/save/discard callbacks
 * using its existing logic; the coordinator requests permission but never
 * reads editor internals. Logout and the optional access wizard resolve
 * every participant BEFORE credentials clear or access changes. */

const participants = new Map();
let resolution = null;

export function registerSessionParticipant(id, callbacks) {
  participants.get(id)?.abandon();
  let resolveAbandoned;
  const entry = {
    callbacks, active: true,
    abandoned: new Promise(resolve => { resolveAbandoned = resolve; }),
    abandon() {
      if (!entry.active) return;
      entry.active = false;
      resolveAbandoned("cancel");
    },
  };
  participants.set(id, entry);
  return () => {
    entry.abandon();
    if (participants.get(id) === entry) participants.delete(id);
  };
}

/** Resolve one participant: "save" | "discard" | "cancel" — the
 * participant's own UI decides (its confirmation modal); cancel aborts
 * the whole handoff and preserves credentials and work. */
async function collectAndResolve(action) {
  const decisions = [];
  const admitted = [...participants.entries()];
  const current = (id, entry) => entry.active && participants.get(id) === entry;
  for (const [id, entry] of admitted) {
    if (!current(id, entry)) return "cancel";
    const { callbacks } = entry;
    if (callbacks.settlePending) {
      const settled = await Promise.race([callbacks.settlePending(action), entry.abandoned.then(() => false)]);
      if (!current(id, entry) || settled !== true) return "cancel";
    }
    if (typeof callbacks.hasUnsavedChanges === "function" &&
      !callbacks.hasUnsavedChanges()) {
      continue;
    }
    const decision = await Promise.race([callbacks.requestDecision(action), entry.abandoned]);
    if (!current(id, entry) || !["save", "discard"].includes(decision)) return "cancel";
    decisions.push({ id, entry, decision });
  }
  // Permission collection never mutates a buffer. Finish every Save before
  // applying any explicit Discard, so a later rejection cannot erase work.
  for (const { id, entry, decision } of decisions) {
    if (!current(id, entry)) return "cancel";
    if (decision === "save") {
      if (typeof entry.callbacks.save !== "function" || await Promise.race([entry.callbacks.save(), entry.abandoned.then(() => false)]) !== true) return "cancel";
      if (!current(id, entry)) return "cancel";
    }
  }
  for (const { id, entry, decision } of decisions) {
    if (!current(id, entry)) return "cancel";
    if (decision === "discard" && await entry.callbacks.discard?.() === false) return "cancel";
  }
  for (const [id, entry] of admitted) {
    if (!current(id, entry)) return "cancel";
    if (entry.callbacks.settlePending && await Promise.race([entry.callbacks.settlePending(action), entry.abandoned.then(() => false)]) !== true) return "cancel";
    if (entry.callbacks.settlePending && entry.callbacks.hasUnsavedChanges?.()) return "cancel";
  }
  return "proceed";
}

export function resolveParticipants(action) {
  if (resolution) return resolution;
  resolution = collectAndResolve(action).catch(() => "cancel").finally(() => { resolution = null; });
  return resolution;
}

/** True when any participant reports unsaved work. */
export function hasUnsavedWork() {
  for (const { callbacks } of participants.values()) {
    if (typeof callbacks.hasUnsavedChanges === "function" &&
      callbacks.hasUnsavedChanges()) {
      return true;
    }
  }
  return false;
}
