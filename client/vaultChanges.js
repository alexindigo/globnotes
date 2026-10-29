// SPDX-License-Identifier: LGPL-3.0-only
import { openVaultChanges } from "./api.js";
import { publish, TOPICS } from "./bus/index.js";

/** One reference-counted owner per app; generations fence late connections. */
export function createVaultChanges({ open = options => openVaultChanges(options), publish: emit = publish,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let owners = 0, generation = 0, seq = 0, attempts = 0, polling = false;
  let documentActive = true;
  let timer = null, close = null, abort = null;
  function retire() {
    generation++;
    clearTimer(timer); timer = null;
    abort?.abort(); abort = null;
    close?.(); close = null;
  }
  async function connect() {
    if (!owners || !documentActive) return;
    retire();
    const own = generation;
    abort = new AbortController();
    const current = () => owners > 0 && documentActive && generation === own;
    const reconnect = reason => {
      if (!current() || timer !== null) return;
      polling = reason === "poll" || reason !== "ended" || polling;
      const delay = reason === "poll" ? 0 : Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6));
      timer = setTimer(() => { timer = null; if (current()) connect(); }, delay);
    };
    try {
      const disposer = await open({ since: seq, poll: polling, signal: abort.signal,
        onEvent({ event, data }) {
          if (!current()) return;
          if (event === "reset" || event === "cursor") {
            if (!Number.isSafeInteger(data?.next) || data.next < 0) throw new Error("Invalid vault cursor");
            seq = data.next;
            if (event === "reset") emit(TOPICS.VAULT_RESET, { next: seq });
          } else if (event === "change") {
            if (!Number.isSafeInteger(data?.seq) || data.seq <= seq) return;
            seq = data.seq; attempts = 0;
            emit(TOPICS.VAULT_CHANGE, data);
          }
        }, onClose: reconnect });
      if (current()) close = disposer;
      else disposer?.();
    } catch (error) {
      if (!current()) return;
      if (error.status === 401 || error.status === 503) { retire(); return; }
      polling = true;
      reconnect(error);
    }
  }
  return {
    suspendDocument() {
      if (!documentActive) return;
      documentActive = false; retire();
    },
    resumeDocument() {
      if (documentActive) return;
      documentActive = true;
      if (owners) connect();
    },
    acquire() {
      if (++owners === 1) connect();
      let released = false;
      return () => { if (released) return; released = true; if (--owners === 0) retire(); };
    },
    state: () => ({ owners, seq, polling }),
  };
}

const vaultChanges = createVaultChanges();
export const acquireVaultChanges = () => vaultChanges.acquire();
// As with the plugin runtime, full-document navigation/BFCache suspension is
// a lifetime boundary even when Vue never unmounts its components.
window.addEventListener("pagehide", () => vaultChanges.suspendDocument());
window.addEventListener("pageshow", () => vaultChanges.resumeDocument());
