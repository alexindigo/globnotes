// SPDX-License-Identifier: LGPL-3.0-only
import { readonly, shallowRef } from "vue";
import { retainUnsavedWork } from "./sessionActions.js";

/** Credential recovery is not navigation or permission to discard work.
 * All callers share one dialog and outcome. Its callbacks belong to that exact
 * request, so a cancelled form's late token cannot acknowledge a replacement. */
export function createReauthentication({ invalidate = () => {}, restored = () => {}, changed = () => {}, report = console.error } = {}) {
  let pending = null, serial = 0;
  const current = entry => pending === entry;
  function finish(entry, accepted) {
    if (!current(entry)) return false;
    pending = null; changed(null); entry.resolve(accepted);
    return true;
  }
  return Object.freeze({
    request() {
      if (pending) return pending.completion;
      const entry = { id: ++serial };
      entry.completion = new Promise(resolve => { entry.resolve = resolve; });
      pending = entry;
      const presentation = Object.freeze({ id: entry.id,
        isCurrent: () => current(entry),
        cancel: () => finish(entry, false),
        authenticated() {
          if (!current(entry)) return Promise.resolve(false);
          return entry.restoring ??= Promise.resolve().then(restored).catch(report).then(() => finish(entry, true));
        },
      });
      // Retire old credential-owned work before offering a new login.
      Promise.resolve().then(invalidate).then(() => { if (current(entry)) changed(presentation); })
        .catch(error => { report(error); finish(entry, false); });
      return entry.completion;
    },
  });
}

const request = shallowRef(null);
export const reauthenticationRequest = readonly(request);
const coordinator = createReauthentication({
  changed: value => { request.value = value; },
  async invalidate() {
    retainUnsavedWork();
    const { stopPluginRuntime } = await import("./pluginRuntime.js");
    stopPluginRuntime();
  },
  async restored() {
    const [{ startPluginRuntime }, { restartVaultChanges }] = await Promise.all([import("./pluginRuntime.js"), import("./vaultChanges.js")]);
    restartVaultChanges();
    await startPluginRuntime();
  },
});
export const requestReauthentication = () => coordinator.request();
