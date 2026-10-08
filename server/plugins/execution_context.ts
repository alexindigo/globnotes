// SPDX-License-Identifier: LGPL-3.0-only
import type { InvocationReference } from "./contracts.ts";

export type ReleaseOutcome = { status: "settled" } | { status: "aborted" };
export interface ExecutionContext {
  reference: InvocationReference;
  causal: { parentId?: string; depth: number };
  open: boolean;
  release: Promise<ReleaseOutcome>;
  settle(outcome: ReleaseOutcome): void;
  close(outcome: ReleaseOutcome): void;
}

/** Host-owned record. IDs correlate execution, never confer manifest grants. */
export function executionContext(
  kind: InvocationReference["kind"],
  pre: boolean,
  causal: ExecutionContext["causal"] = { depth: 0 },
): ExecutionContext {
  let resolve!: (outcome: ReleaseOutcome) => void;
  let settled = false;
  const context: ExecutionContext = {
    reference: Object.freeze({ id: crypto.randomUUID(), kind, pre }),
    causal: Object.freeze({ parentId: causal.parentId, depth: causal.depth }),
    open: true,
    release: new Promise((yes) => {
      resolve = yes;
    }),
    settle(outcome) {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    },
    close(outcome) {
      context.open = false;
      context.settle(outcome);
    },
  };
  return context;
}
