// SPDX-License-Identifier: LGPL-3.0-only

/** Patched Mousetrap instance. The global-bind semantics (bindGlobal:
 * shortcuts fire inside inputs) are applied HERE to the exact class this
 * module exports — chunk splitting can never hand a consumer an unpatched
 * copy. Mirrors mousetrap-global-bind v1.6.5, inlined for identity. */

import Mousetrap from "mousetrap";

const globalCallbacks = {};
const originalStopCallback = Mousetrap.prototype.stopCallback;

Mousetrap.prototype.stopCallback = function (e, element, combo, sequence) {
  if (this.paused) return true;
  if (globalCallbacks[combo] || globalCallbacks[sequence]) return false;
  return originalStopCallback.call(this, e, element, combo);
};

Mousetrap.prototype.bindGlobal = function (keys, callback, action) {
  this.bind(keys, callback, action);
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) globalCallbacks[key] = true;
};

Mousetrap.init();

export default Mousetrap;
