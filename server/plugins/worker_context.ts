// SPDX-License-Identifier: LGPL-3.0-only
import { AsyncLocalStorage } from "node:async_hooks";
import type { InvocationReference } from "./contracts.ts";

interface Scope {
  reference: InvocationReference;
  open: boolean;
  admissions?: Promise<unknown>[];
}
const storage = new AsyncLocalStorage<Scope>();
let background: Scope | null = null;

export function setBackgroundContext(reference: InvocationReference): void {
  background = { reference, open: true };
}
export function currentWorkerContext(): InvocationReference {
  const scope = storage.getStore();
  if (!scope?.open) {
    throw new Error("plugin invocation context is unavailable or closed");
  }
  return scope.reference;
}
export function runBackground<T>(callback: () => T): T {
  if (!background?.open) throw new Error("plugin generation context revoked");
  return storage.run(background, callback);
}
export async function runInvocation<T>(
  reference: InvocationReference,
  callback: () => Promise<T>,
): Promise<T> {
  const scope: Scope = { reference, open: true, admissions: [] };
  return await storage.run(scope, async () => {
    try {
      const value = await callback();
      while (scope.admissions!.length) {
        const results = await Promise.allSettled(scope.admissions!.splice(0));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      return value;
    } finally {
      while (scope.admissions!.length) {
        await Promise.allSettled(scope.admissions!.splice(0));
      }
      scope.open = false;
    }
  });
}
export function registrationPending(admission: Promise<unknown>): void {
  const scope = storage.getStore();
  if (!scope?.open || !scope.admissions) {
    throw new Error("registration context closed");
  }
  scope.admissions.push(admission);
  admission.catch(() => undefined);
}
export function revokeWorkerContext(): void {
  if (background) background.open = false;
}
