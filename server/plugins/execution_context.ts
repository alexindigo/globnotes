// SPDX-License-Identifier: LGPL-3.0-only
import type { InvocationReference } from "./contracts.ts";
import { createUuid } from "../../shared/uuid.ts";
import type { ViewerAuthority } from "../auth/authority.ts";
import {
  createOwnershipScope,
  type OwnershipScope,
} from "../../shared/ownership.js";

export type ReleaseOutcome = { status: "settled" } | { status: "aborted" };
export interface ExecutionProvenance {
  readonly pre: boolean;
  readonly viewer?: ViewerAuthority;
  readonly causal: Readonly<{ parentId?: string; depth: number }>;
}
export interface ExecutionContext {
  readonly resources: OwnershipScope;
  readonly provenance: ExecutionProvenance;
  retained?: boolean;
  parentId?: string;
  readonly reference: InvocationReference;
  open: boolean;
  release: Promise<ReleaseOutcome>;
  settle(outcome: ReleaseOutcome): void;
  close(outcome: ReleaseOutcome): void;
}

/** Host-owned record. IDs correlate execution, never confer manifest grants. */
export function executionContext(
  kind: InvocationReference["kind"],
  { pre, viewer, causal }: ExecutionProvenance,
): ExecutionContext {
  const resources = createOwnershipScope();
  let resolve!: (outcome: ReleaseOutcome) => void;
  let settled = false;
  const context: ExecutionContext = {
    resources,
    provenance: Object.freeze({
      pre,
      viewer,
      causal: Object.freeze({ parentId: causal.parentId, depth: causal.depth }),
    }),
    reference: Object.freeze({ id: createUuid(), kind, pre }),
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
      resources.retire();
      context.settle(outcome);
    },
  };
  return context;
}
