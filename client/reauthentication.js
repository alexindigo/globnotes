// SPDX-License-Identifier: LGPL-3.0-only
import { readonly, shallowRef } from "vue";
import { retainUnsavedWork } from "./sessionActions.js";

/** Credential recovery is not navigation or permission to discard work.
 * One owner's callers share a dialog and outcome. Its callbacks belong to that exact
 * request, so a cancelled form's late token cannot acknowledge a replacement. */
export function createReauthentication({ invalidate = () => {}, restored = () => {}, changed = () => {}, report = console.error } = {}) {
  const legacy = Object.freeze({});
  let pending = null, serial = 0;
  const current = entry => pending === entry;
  function finish(entry, accepted) {
    if (!current(entry)) return false;
    pending = null; changed(null); entry.resolve(accepted);
    return true;
  }
  return Object.freeze({
    close(owner) { if (pending?.owner === owner) finish(pending, false); },
    request({ owner = legacy, invalidate: retire = invalidate, restored: restore = restored } = {}) {
      if (pending?.owner === owner) return pending.completion;
      // A legacy refusal cannot take over a prepared recovery. In the other
      // direction retire the old presentation, never lend its restore callback.
      if (pending && owner === legacy) return Promise.resolve(false);
      const previous = pending;
      const entry = { id: ++serial, owner };
      entry.completion = new Promise(resolve => { entry.resolve = resolve; });
      pending = entry;
      if (previous) { previous.resolve(false); changed(null); }
      const isCurrent = () => current(entry);
      const presentation = Object.freeze({ id: entry.id,
        isCurrent,
        cancel: () => finish(entry, false),
        authenticated() {
          if (!current(entry)) return Promise.resolve(false);
          return entry.restoring ??= Promise.resolve().then(() => { if (isCurrent()) return restore(isCurrent); }).catch(report).then(() => finish(entry, true));
        },
      });
      // Retire old credential-owned work before offering a new login.
      Promise.resolve().then(() => { if (isCurrent()) return retire(isCurrent); }).then(() => { if (isCurrent()) changed(presentation); })
        .catch(error => { report(error); finish(entry, false); });
      return entry.completion;
    },
  });
}

const request = shallowRef(null);
export const reauthenticationRequest = readonly(request);
const coordinator = createReauthentication({
  changed: value => { request.value = value; },
  async invalidate(current) {
    retainUnsavedWork();
    const { stopPluginRuntime } = await import("./pluginRuntime.js");
    if (current()) stopPluginRuntime();
  },
  async restored(current) {
    const [{ startPluginRuntime }, { restartVaultChanges }] = await Promise.all([import("./pluginRuntime.js"), import("./vaultChanges.js")]);
    if (current()) restartVaultChanges();
    if (current()) await startPluginRuntime();
  },
});
export const requestReauthentication = () => coordinator.request();
// The capability session has already retired its own runtime; acceptance of
// its new projection is the only path that can install the replacement.
export function createIdentityReauthentication() {
  const owner = Object.freeze({});
  let closed = false;
  return Object.freeze({
    request: () => closed ? Promise.resolve(false) : coordinator.request({ owner, invalidate() {}, restored() {} }),
    close() { closed = true; coordinator.close(owner); },
  });
}
