// SPDX-License-Identifier: LGPL-3.0-only
import { reactive, readonly } from "vue";
import { copyText } from "./clipboard.js";
import { createOperationOwner } from "./operationOwner.js";

/** Display and echo the issued candidate; all verification stays on the server. */
export function createAuthenticatorEnrollment({ enrol, capture = () => () => true, copy = copyText, owner: identity = Object.freeze({}) }) {
  const fields = reactive({ candidate: null, busy: false, copying: false, error: "", feedback: "" });
  let serial = 0, disposed = false;
  let issuance = Promise.resolve();
  const current = value => !disposed && value.serial === serial && value.current();
  const owner = createOperationOwner({ owner: identity,
    prepare(intent) {
      const value = { ...intent, args: [...(intent.args ?? [])] };
      if (!current(value)) void owner.release(value.operation);
      return { value };
    }, dispatch(intent) { return intent.kind === "copy" ? copy(intent.secret) : enrol(...intent.args); },
    channels: {
      candidate: { prepare(value) {
        const prepared = { ...value, candidate: { ...value.candidate } };
        if (!current(prepared)) void owner.release(prepared.operation);
        return { value: prepared };
      }, deliver(value) { fields.candidate = value.candidate; } },
      feedback: { prepare(value) { if (!current(value)) void owner.release(value.operation); return { value }; },
        deliver(value) { fields[value.kind === "copy" ? "feedback" : "error"] = value.message; } },
    },
  });
  function clear() { serial++; fields.candidate = null; fields.busy = false; fields.error = ""; fields.feedback = ""; }
  function start(...args) {
    clear(); if (disposed) return Promise.resolve(false);
    const requested = { kind: "enrol", serial, current: capture(), args };
    fields.busy = true;
    const result = issuance.then(async () => {
      if (!current(requested)) return false;
      const operation = owner.operation(), intent = { ...requested, operation };
      try {
        const result = await owner.dispatch(operation, intent);
        return owner.deliver(operation, "candidate", { ...intent, candidate: result.value });
      } catch {
        owner.deliver(operation, "feedback", { ...intent, message: "Could not prepare the authenticator. Please try again." }); return false;
      } finally { if (intent.serial === serial) fields.busy = false; await owner.release(operation); }
    });
    issuance = result.catch(() => false);
    return result;
  }
  async function copyKey() {
    if (disposed || fields.copying || !fields.candidate) return false;
    const operation = owner.operation(), intent = { kind: "copy", serial, current: capture(), secret: fields.candidate.secret, operation };
    fields.copying = true;
    try {
      await owner.dispatch(operation, intent);
      return owner.deliver(operation, "feedback", { ...intent, message: "Setup key copied." });
    } catch {
      owner.deliver(operation, "feedback", { ...intent, message: "Could not copy the setup key. Please try again." }); return false;
    } finally { fields.copying = false; await owner.release(operation); }
  }
  return { state: readonly(fields), start, clear, copyKey, async settle() { await issuance; return owner.settle(); },
    dispose() { disposed = true; clear(); return owner.dispose(); } };
}
