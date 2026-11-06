// SPDX-License-Identifier: LGPL-3.0-only
import { openVaultChanges } from "./api.js";
import { publish, TOPICS } from "./bus/index.js";

/** Reconnect delays grow from 500 ms and never exceed this. */
export const MAX_DELAY_MS = 30_000;
/** A stream that stayed open this long proved the path healthy: the next
 * reconnect starts the backoff over (a proxy idle timeout is not a fault). */
export const STABLE_MS = 30_000;
/** Polling is a fallback after a stream failure, never a final mode: after
 * this long the stream is tried again. */
export const STREAM_RETRY_MS = 60_000;
/** A hidden tab keeps its stream this long, then releases it and catches up
 * from its cursor when it is shown again. On plain HTTP (HTTP/1.1, Axiom 1)
 * every open stream holds one of the browser's few connections per host, so
 * only visible tabs hold one. */
export const HIDDEN_GRACE_MS = 10_000;
/** Answers that retrying cannot change: authentication (401, 403), a server
 * without this endpoint (404, 405, 410, 501), a request it rejects (400).
 * Every other failure (network errors, 408, 429, 5xx including a proxy's
 * 503 during a restart) is retried with the bounded backoff. */
export const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 405, 410, 501]);

/** One reference-counted owner per app; generations fence late connections. */
export function createVaultChanges({ open = options => openVaultChanges(options), publish: emit = publish,
  // Resolved at call time, so the page's current timer implementation applies.
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), now = () => Date.now() } = {}) {
  let owners = 0, generation = 0, seq = 0, attempts = 0, polling = false, pollingSince = 0;
  let documentActive = true, visible = true, hiddenTimer = null;
  let timer = null, close = null, abort = null;
  const live = () => owners > 0 && documentActive && visible;
  function retire() {
    generation++;
    clearTimer(timer); timer = null;
    abort?.abort(); abort = null;
    close?.(); close = null;
  }
  function enterPolling() {
    if (polling) return;
    polling = true; pollingSince = now();
  }
  async function connect() {
    if (!live()) return;
    retire();
    const own = generation, mode = polling ? "poll" : "stream";
    let openedAt = null;
    abort = new AbortController();
    const current = () => live() && generation === own;
    // Every non-terminal outcome ends here: one timer, a bounded delay.
    const reconnect = reason => {
      if (!current() || timer !== null) return;
      let delay;
      if (reason === "poll") {
        // A completed poll is a healthy exchange; the transport paces it.
        attempts = 0; delay = 0;
        if (now() - pollingSince >= STREAM_RETRY_MS) polling = false;
      } else {
        if (mode === "stream" && openedAt !== null && now() - openedAt >= STABLE_MS) attempts = 0;
        // A stream that broke (not one that ended cleanly) falls back to polling.
        if (mode === "stream" && reason !== "ended") enterPolling();
        delay = Math.min(MAX_DELAY_MS, 500 * 2 ** Math.min(attempts++, 6));
      }
      timer = setTimer(() => { timer = null; if (current()) connect(); }, delay);
    };
    try {
      const disposer = await open({ since: seq, poll: mode === "poll", signal: abort.signal,
        onEvent({ event, data }) {
          if (!current()) return;
          if (event === "reset" || event === "cursor") {
            if (!Number.isSafeInteger(data?.next) || data.next < 0) throw new Error("Invalid vault cursor");
            seq = data.next;
            if (event === "reset") emit(TOPICS.VAULT_RESET, { next: seq });
          } else if (event === "change") {
            if (!Number.isSafeInteger(data?.seq) || data.seq <= seq) return;
            seq = data.seq;
            emit(TOPICS.VAULT_CHANGE, data);
          }
        }, onClose: reconnect });
      if (current()) { close = disposer; openedAt = now(); }
      else disposer?.();
    } catch (error) {
      if (!current()) return;
      if (TERMINAL_STATUSES.has(error?.status)) { retire(); return; }
      // No HTTP answer at all: the stream path itself failed.
      if (mode === "stream" && error?.status === undefined) enterPolling();
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
    /** Page visibility: hidden releases the stream after HIDDEN_GRACE_MS;
     * shown reconnects at once from the accepted cursor. */
    setVisible(next) {
      if (next) {
        clearTimer(hiddenTimer); hiddenTimer = null;
        if (visible) return;
        visible = true;
        if (owners) connect();
        return;
      }
      if (!visible || hiddenTimer !== null) return;
      hiddenTimer = setTimer(() => { hiddenTimer = null; visible = false; retire(); }, HIDDEN_GRACE_MS);
    },
    acquire() {
      if (++owners === 1) connect();
      let released = false;
      return () => { if (released) return; released = true; if (--owners === 0) retire(); };
    },
    state: () => ({ owners, seq, polling, attempts, visible, connected: close !== null }),
  };
}

const vaultChanges = createVaultChanges();
export const acquireVaultChanges = () => vaultChanges.acquire();
// As with the plugin runtime, full-document navigation/BFCache suspension is
// a lifetime boundary even when Vue never unmounts its components.
window.addEventListener("pagehide", () => vaultChanges.suspendDocument());
window.addEventListener("pageshow", () => vaultChanges.resumeDocument());
const syncVisibility = () => vaultChanges.setVisible(document.visibilityState !== "hidden");
document.addEventListener("visibilitychange", syncVisibility);
syncVisibility();
