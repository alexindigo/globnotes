// SPDX-License-Identifier: LGPL-3.0-only
import { openVaultChanges } from "./api.js";
import { publish, TOPICS } from "./bus/index.js";
import { connectionLifetime, createConnectionLifetime } from "./connectionLifetime.js";
import { createOperationOwner } from "./operationOwner.js";
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

/** One reference-counted owner per app; issued operations fence late connections. */
export function createVaultChanges({ open = options => openVaultChanges(options), publish: emit = publish,
  // Resolved at call time, so the page's current timer implementation applies.
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), now = () => Date.now(),
  lifetime = createConnectionLifetime({ setTimer, clearTimer }) } = {}) {
  let owners = 0, seq = 0, attempts = 0, polling = false, pollingSince = 0;
  let pageActive = lifetime.state().active;
  let timer = null, connection = null, connected = false, disposed = false, disposal = null;
  const draining = new Set(), cleanupErrors = [];
  const revisions = new Map();
  const metadataTopics = { conflicts: TOPICS.VAULT_CONFLICTS, drivers: TOPICS.VAULT_DRIVERS };
  const live = () => !disposed && owners > 0 && pageActive;
  function retire() {
    const old = connection; connection = null; connected = false;
    if (!old) return;
    const join = old.dispose();
    draining.add(join);
    join.then(report => { cleanupErrors.push(...report.errors); draining.delete(join); });
  }
  function enterPolling(at) {
    if (polling) return;
    polling = true; pollingSince = at;
  }
  async function connect(continuePoll = false) {
    if (!live()) return;
    retire();
    // Cleanup may reenter restart/acquire; the replacement it installed wins.
    if (connection || !live()) return;
    const mode = polling ? "poll" : "stream";
    // Completed polls continue one observation lifetime. Real reconnects and
    // page/owner restarts must deliver a fresh snapshot even at the same revision.
    if (!continuePoll) revisions.clear();
    let openedAt = null;
    const abort = new AbortController();
    const current = () => live() && connection === operationOwner;
    // Every non-terminal outcome ends here: one timer, a bounded delay.
    const reconnect = reason => {
      if (!current() || timer !== null) return;
      const at = now();
      if (!current() || timer !== null) return;
      let delay;
      if (reason === "poll") {
        enterPolling(at); // The stream request may itself have received JSON.
        // A completed poll is a healthy exchange; the transport paces it.
        attempts = 0; delay = 0;
        if (at - pollingSince >= STREAM_RETRY_MS) polling = false;
      } else {
        if (mode === "stream" && openedAt !== null && at - openedAt >= STABLE_MS) attempts = 0;
        // A stream that broke (not one that ended cleanly) falls back to polling.
        if (mode === "stream" && reason !== "ended") enterPolling(at);
        delay = Math.min(MAX_DELAY_MS, 500 * 2 ** Math.min(attempts++, 6));
      }
      const continuePoll = reason === "poll" && polling;
      // Reserve the slot before an injected timer can reenter. A replacement
      // connection or synchronous firing owns its own slot, never this handle.
      const scheduled = { ready: false, handle: undefined };
      timer = scheduled;
      try {
        const handle = setTimer(() => {
          if (!current() || timer !== scheduled) return;
          timer = null; connect(continuePoll);
        }, delay);
        if (current() && timer === scheduled) {
          scheduled.handle = handle; scheduled.ready = true;
        } else clearTimer(handle);
      } catch (error) {
        if (timer === scheduled) timer = null;
        throw error;
      }
    };
    const operationOwner = createOperationOwner({
      owner: Object.freeze({}),
      dispatch: (options, delivery) => open({ ...options, signal: abort.signal,
        onEvent: value => delivery.deliver("event", value), onClose: reason => delivery.deliver("close", reason) }),
      release: disposer => disposer?.(),
      cancel() {
        const scheduled = timer; timer = null;
        if (scheduled?.ready) clearTimer(scheduled.handle);
        abort.abort();
      },
      channels: {
        event: {
          // Snapshot all event fields before the adapter's final delivery fence.
          prepare(value) { const event = value.event, data = value.data; return { value: { event, data: data && { ...data } } }; },
          deliver({ event, data }) {
            if (Object.hasOwn(metadataTopics, event)) {
              if (!Number.isSafeInteger(data?.revision) || data.revision < 0) throw new Error(`Invalid ${event === "conflicts" ? "conflict" : "driver"} revision`);
              if (data.revision === revisions.get(event)) return;
              revisions.set(event, data.revision);
              emit(metadataTopics[event], { revision: data.revision });
            } else if (event === "reset" || event === "cursor") {
              if (!Number.isSafeInteger(data?.next) || data.next < 0) throw new Error("Invalid vault cursor");
              seq = data.next;
              if (event === "reset") emit(TOPICS.VAULT_RESET, { next: seq });
            } else if (event === "change") {
              if (!Number.isSafeInteger(data?.seq) || data.seq <= seq) return;
              seq = data.seq;
              emit(TOPICS.VAULT_CHANGE, data);
            }
          },
        },
        close: { deliver: reconnect },
      },
    });
    connection = operationOwner;
    const operation = operationOwner.operation();
    try {
      await operationOwner.dispatch(operation, { since: seq, poll: mode === "poll" });
      const opened = now();
      if (current()) { connected = true; openedAt = opened; }
    } catch (error) {
      const status = error?.status;
      if (!current()) return;
      if (TERMINAL_STATUSES.has(status)) { retire(); return; }
      // No HTTP answer at all: the stream path itself failed.
      if (mode === "stream" && status === undefined) {
        const at = now(); if (!current()) return;
        enterPolling(at);
      }
      reconnect(error);
    }
  }
  const unsubscribe = lifetime.subscribe(next => {
    if (pageActive === next) return;
    pageActive = next;
    if (next) connect(); else retire();
  });
  async function settle() {
    await connection?.settle();
    await Promise.all([...draining]);
    return Object.freeze({ errors: Object.freeze([...cleanupErrors]) });
  }
  return {
    suspendDocument: lifetime.suspendDocument,
    resumeDocument: lifetime.resumeDocument,
    setVisible: lifetime.setVisible,
    restart() { if (live()) connect(); },
    settle,
    dispose() {
      if (disposal) return disposal;
      disposed = true; owners = 0;
      disposal = Promise.resolve().then(settle);
      unsubscribe(); retire();
      return disposal;
    },
    acquire() {
      if (disposed) throw new Error("Vault changes owner is disposed");
      if (++owners === 1) connect();
      let released = false;
      return () => { if (released || disposed) return; released = true; if (--owners === 0) retire(); };
    },
    state: () => ({ owners, seq, polling, attempts, visible: lifetime.state().visible, connected }),
  };
}

const vaultChanges = createVaultChanges({ lifetime: connectionLifetime });
export const acquireVaultChanges = () => vaultChanges.acquire();
export const restartVaultChanges = () => vaultChanges.restart();
