// SPDX-License-Identifier: LGPL-3.0-only
/** Manual expiry must perform the real timer's release before the host callback,
 * exactly as ObservedClock does when the deadline expires naturally. */
export function manualExpiry(cancel: () => void, callback: () => void) {
  return () => {
    cancel();
    callback();
  };
}
