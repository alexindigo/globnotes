// SPDX-License-Identifier: LGPL-3.0-only
import { openVaultChanges } from "./api.js";
import { publish, TOPICS } from "./bus/index.js";
import { connectionLifetime, createConnectionLifetime } from "./connectionLifetime.js";
export { HIDDEN_GRACE_MS } from "./connectionLifetime.js";

/** Reconnect delays grow from 500 ms and never exceed this. */
export const MAX_DELAY_MS = 30_000;
/** A stream that stayed open this long proved the path healthy: the next
 * reconnect starts the backoff over (a proxy idle timeout is not a fault). */
export const STABLE_MS = 30_000;
/** Polling is a fallback after a stream failure, never a final mode: after
 * this long the stream is tried again. */
export const STREAM_RETRY_MS = 60_000;
/** Answers that retrying cannot change: authentication (401, 403), a server
 * without this endpoint (404, 405, 410, 501), a request it rejects (400).
 * Every other failure (network errors, 408, 429, 5xx including a proxy's
 * 503 during a restart) is retried with the bounded backoff. */
export const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 405, 410, 501]);

/** One reference-counted owner per app; generations fence late connections. */
export function createVaultChanges({ open = options => openVaultChanges(options), publish: emit = publish,
  // Resolved at call time, so the page's current timer implementation applies.
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), now = () => Date.now(),
  lifetime = createConnectionLifetime({ setTimer, clearTimer }) } = {}) {
  let owners = 0, generation = 0, seq = 0, attempts = 0, polling = false, pollingSince = 0;
  let pageActive = lifetime.state().active;
  let timer = null, close = null, abort = null, conflictRevision = null;
  const live = () => owners > 0 && pageActive;
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
  async function connect(continuePoll = false) {
    if (!live()) return;
    retire();
    const own = generation, mode = polling ? "poll" : "stream";
    // Completed polls continue one observation lifetime. Real reconnects and
    // page/owner restarts must deliver a fresh snapshot even at the same revision.
    if (!continuePoll) conflictRevision = null;
    let openedAt = null;
    abort = new AbortController();
    const current = () => live() && generation === own;
    // Every non-terminal outcome ends here: one timer, a bounded delay.
    const reconnect = reason => {
      if (!current() || timer !== null) return;
      let delay;
      if (reason === "poll") {
        enterPolling(); // The stream request may itself have received JSON.
        // A completed poll is a healthy exchange; the transport paces it.
        attempts = 0; delay = 0;
        if (now() - pollingSince >= STREAM_RETRY_MS) polling = false;
      } else {
        if (mode === "stream" && openedAt !== null && now() - openedAt >= STABLE_MS) attempts = 0;
        // A stream that broke (not one that ended cleanly) falls back to polling.
        if (mode === "stream" && reason !== "ended") enterPolling();
        delay = Math.min(MAX_DELAY_MS, 500 * 2 ** Math.min(attempts++, 6));
      }
      const continuePoll = reason === "poll" && polling;
      timer = setTimer(() => { timer = null; if (current()) connect(continuePoll); }, delay);
    };
    try {
      const disposer = await open({ since: seq, poll: mode === "poll", signal: abort.signal,
        onEvent({ event, data }) {
          if (!current()) return;
          if (event === "conflicts") {
            if (!Number.isSafeInteger(data?.revision) || data.revision < 0) throw new Error("Invalid conflict revision");
            if (data.revision === conflictRevision) return;
            conflictRevision = data.revision;
            emit(TOPICS.VAULT_CONFLICTS, { revision: conflictRevision });
          } else if (event === "reset" || event === "cursor") {
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
  lifetime.subscribe(next => {
    if (pageActive === next) return;
    pageActive = next;
    if (next) connect(); else retire();
  });
  return {
    suspendDocument: lifetime.suspendDocument,
    resumeDocument: lifetime.resumeDocument,
    setVisible: lifetime.setVisible,
    restart() { if (live()) connect(); },
    acquire() {
      if (++owners === 1) connect();
      let released = false;
      return () => { if (released) return; released = true; if (--owners === 0) retire(); };
    },
    state: () => ({ owners, seq, polling, attempts, visible: lifetime.state().visible, connected: close !== null }),
  };
}

const vaultChanges = createVaultChanges({ lifetime: connectionLifetime });
export const acquireVaultChanges = () => vaultChanges.acquire();
export const restartVaultChanges = () => vaultChanges.restart();
