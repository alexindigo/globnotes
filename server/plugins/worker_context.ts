// SPDX-License-Identifier: LGPL-3.0-only
import { AsyncLocalStorage } from "node:async_hooks";
import type { InvocationReference } from "./contracts.ts";

interface Scope {
  reference: InvocationReference;
  open: boolean;
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
  const scope = { reference, open: true };
  return await storage.run(scope, async () => {
    try {
      return await callback();
    } finally {
      scope.open = false;
    }
  });
}
export function revokeWorkerContext(): void {
  if (background) background.open = false;
}
