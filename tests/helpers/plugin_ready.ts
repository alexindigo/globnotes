// SPDX-License-Identifier: LGPL-3.0-only

/** In-process initialization follows the host's bounded startup cohort. Only
 * unbounded admission/publication and status-only sources use readiness. */

import { done, failed, pending, waitUntil } from "./wait.ts";
import type { WorkSettlement } from "../../server/plugins/host.ts";
import { ownerMilestone, ownerSettled } from "./product_settlement.ts";

interface StatusSource<S extends { status: string }> {
  status(id: string): S | null | undefined;
  settlement?(id: string): WorkSettlement & { status: S | null | undefined };
}

/** A native initialization milestone can precede full heartbeat qualification. */
export function pluginMilestone<S extends { status: string }, T>(
  runtime: {
    settlement(id: string): WorkSettlement & { status: S | null | undefined };
  },
  id: string,
  milestone: Promise<T>,
  label: string,
): Promise<T> {
  return ownerMilestone(
    () => {
      const snapshot = runtime.settlement(id);
      return {
        ...snapshot,
        failure: snapshot.failure ??
          (snapshot.status?.status === "failed"
            ? `plugin '${id}' failed: ${JSON.stringify(snapshot.status)}`
            : null),
      };
    },
    milestone,
    label,
  );
}

/** Enablement can still be in policy/admission before a startup owner exists.
 * Unlike pluginSettled's terminal-state assertion, wait for that admission too. */
export async function pluginReady<S extends { status: string }>(
  runtime: {
    settlement(id: string): WorkSettlement & { status: S | null | undefined };
  },
  id: string,
): Promise<S> {
  const state = await ownerSettled(
    () => {
      const snapshot = runtime.settlement(id);
      return { ...snapshot, state: snapshot.status };
    },
    (state) => state?.status === "ready" || state?.status === "failed",
    `plugin '${id}' ready`,
  );
  if (state?.status !== "ready") {
    throw new Error(`plugin '${id}' failed: ${JSON.stringify(state)}`);
  }
  return state;
}

/** Wait until plugin `id` is no longer "starting" and return its status.
 * With `expect`, settling in any other state fails at once with the full
 * status (diagnostics included). */
export async function pluginSettled<S extends { status: string }>(
  runtime: StatusSource<S>,
  id: string,
  expect?: "ready" | "failed",
): Promise<S | null | undefined> {
  if (runtime.settlement) {
    const state = await ownerSettled(
      () => {
        const snapshot = runtime.settlement!(id);
        return { ...snapshot, state: snapshot.status };
      },
      (state) => state?.status !== "starting",
      `plugin '${id}' initialization`,
    );
    if (expect && state?.status !== expect) {
      throw new Error(
        `plugin '${id}' is ${state?.status ?? "absent"}, expected ${expect}: ${
          JSON.stringify(state)
        }`,
      );
    }
    return state;
  }
  // A status-only source has not provided an authoritative bounded-work signal.
  return waitUntil(() => {
    const status = runtime.status(id);
    if (status?.status === "starting") return pending(status);
    if (expect && status?.status !== expect) {
      return failed(
        `plugin '${id}' is ${status?.status ?? "absent"}, expected ${expect}`,
        status,
      );
    }
    return done(status);
  }, { label: `plugin '${id}' settled${expect ? ` (${expect})` : ""}` });
}

export { catalogPluginReady } from "./catalog_work.ts";
