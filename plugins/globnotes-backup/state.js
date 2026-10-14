// SPDX-License-Identifier: LGPL-3.0-only
let owner;
export function bind(value) { owner = value; }
export function status() {
  return owner ? owner.status() : { completed: 0, skipped: 0, failed: 0, pendingRecovery: false, lastError: { code: "backup_unavailable" } };
}
