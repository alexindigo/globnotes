// SPDX-License-Identifier: LGPL-3.0-only

/** One page owner for every long-lived connection, on HTTP and HTTPS alike.
 * Short tab switches keep connections; hidden pages release them after 10 s.
 * pagehide is an immediate lifetime boundary (including BFCache). Consumers
 * fence retired work and catch up through their own protocol on resume. */
export const HIDDEN_GRACE_MS = 10_000;

export function createConnectionLifetime({
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id),
} = {}) {
  let documentActive = true, visible = true, hiddenTimer = null;
  const listeners = new Set();
  const active = () => documentActive && visible;
  function change(update) {
    const before = active(); update();
    if (before !== active()) for (const listener of [...listeners]) listener(active());
  }
  return Object.freeze({
    state: () => ({ active: active(), visible, documentActive }),
    subscribe(listener) { listeners.add(listener); listener(active()); return () => listeners.delete(listener); },
    suspendDocument() { change(() => { documentActive = false; }); },
    resumeDocument() { change(() => { documentActive = true; }); },
    setVisible(next) {
      if (next) {
        clearTimer(hiddenTimer); hiddenTimer = null;
        change(() => { visible = true; });
      } else if (visible && hiddenTimer === null) {
        hiddenTimer = setTimer(() => {
          hiddenTimer = null;
          change(() => { visible = false; });
        }, HIDDEN_GRACE_MS);
      }
    },
  });
}

export const connectionLifetime = createConnectionLifetime();
window.addEventListener("pagehide", () => connectionLifetime.suspendDocument());
window.addEventListener("pageshow", () => connectionLifetime.resumeDocument());
const syncVisibility = () => connectionLifetime.setVisible(document.visibilityState !== "hidden");
document.addEventListener("visibilitychange", syncVisibility);
syncVisibility();
