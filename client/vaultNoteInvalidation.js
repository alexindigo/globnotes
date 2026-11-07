// SPDX-License-Identifier: LGPL-3.0-only
import { subscribe as subscribeToBus, TOPICS } from "./bus/index.js";

/** List projections consume all hub peers through the existing stream facts.
 * One synchronous group schedules one snapshot refresh, retired on disposal.
 * App's vault connection owner supplies transport; this opens no connection. */
export function subscribeVaultNotes(refresh, { subscribe = subscribeToBus } = {}) {
  let disposed = false, queued = false;
  function invalidate(entry) {
    if (entry && !entry.path?.endsWith(".md") && !entry.oldPath?.endsWith(".md")) return;
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!disposed) Promise.resolve().then(refresh).catch(() => {});
    });
  }
  const releases = [subscribe(TOPICS.VAULT_CHANGE, invalidate), subscribe(TOPICS.VAULT_RESET, () => invalidate())];
  return () => { disposed = true; releases.forEach(release => release()); };
}
