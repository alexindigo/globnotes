// SPDX-License-Identifier: LGPL-3.0-only
import type { PluginHost, WorkSettlement } from "../../server/plugins/host.ts";
import {
  describe,
  done,
  type Observation,
  pending,
  waitUntil,
} from "./wait.ts";

/** Only admission/publication without a product bound uses readiness. Once the
 * owner admits bounded work, its real completion/deadline cancels that phase's
 * readiness wait. No timer here competes with an admitted invocation. */
function ownedObservation<S extends WorkSettlement>(
  observe: () => S,
  label: string,
) {
  let owner: object | undefined;
  return () => {
    const current = observe();
    if (owner && current.owner !== owner) {
      throw new Error(
        `${label}: ${current.failure ?? "owner replaced before settlement"}`,
      );
    }
    owner ??= current.owner;
    return current;
  };
}

export async function ownerSettled<S>(
  observe: () => WorkSettlement & { state: S },
  settled: (state: S) => boolean,
  label: string,
): Promise<S> {
  const currentObservation = ownedObservation(observe, label);
  for (;;) {
    const current = currentObservation();
    if (settled(current.state)) return current.state;
    if (current.pending) {
      await current.completion;
      continue;
    }
    await waitUntil(async () => {
      const before = currentObservation();
      if (before.pending || settled(before.state)) return done();
      await before.changed;
      const after = currentObservation();
      return after.pending || settled(after.state)
        ? done()
        : pending(after.state);
    }, { label: `${label}: admission/publication` });
  }
}

/** An existing call bounds a fixture milestone too. If the call ends first,
 * missing the marker is a failed assertion, never permission to wait for later work. */
export function workMilestone<T>(
  completion: Promise<unknown>,
  milestone: Promise<T>,
  label: string,
): Promise<T> {
  return Promise.race([
    milestone,
    completion.then(() => {
      throw new Error(
        `${label}: product work settled without the expected milestone`,
      );
    }),
  ]);
}

/** Before admission there is no whole-work bound. After admission, a native
 * descriptor/RPC milestone races only that captured owner's completion. */
export async function ownerMilestone<T>(
  observe: () => WorkSettlement,
  milestone: Promise<T>,
  label: string,
): Promise<T> {
  const currentObservation = ownedObservation(observe, label);
  let reached = false;
  const marked = milestone.then((value) => {
    reached = true;
    return value;
  });
  marked.catch(() => undefined);
  for (;;) {
    const current = currentObservation();
    if (current.failure) throw new Error(current.failure);
    if (reached) return await marked;
    if (current.pending) {
      return await workMilestone(
        current.completion.then(() => {
          const final = currentObservation();
          if (final.failure) throw new Error(final.failure);
        }),
        marked,
        label,
      );
    }
    await waitUntil(async () => {
      const before = currentObservation();
      if (before.failure) throw new Error(before.failure);
      if (reached || before.pending) return done();
      await Promise.race([before.changed, marked]);
      const after = currentObservation();
      if (after.failure) throw new Error(after.failure);
      return reached || after.pending
        ? done()
        : pending({ pending: after.pending });
    }, { label: `${label}: admission` });
  }
}

/** Observe an intermediate consumer while its already-admitted work remains
 * pending. The captured product result/deadline, not a harness timer, bounds
 * these reads. Successful settlement gets one final observation, never a new
 * work cohort. This does not retry the operation being observed. */
export async function duringWork<T>(
  completion: Promise<void>,
  probe: () => Promise<Observation<T>>,
  label: string,
): Promise<T> {
  const terminal = completion.then(() => ({ settled: true as const }));
  for (;;) {
    const attempt = probe();
    const next = await Promise.race([
      terminal,
      attempt.then((observation) => ({ observation })),
    ]);
    const observation = "observation" in next
      ? next.observation
      : await attempt;
    if (observation.kind === "done") return observation.value;
    if (observation.kind === "failed") {
      throw new Error(
        `${label}: ${observation.reason}; ${describe(observation.state)}`,
      );
    }
    if ("settled" in next) {
      throw new Error(
        `${label}: product work settled without the expected outcome; ${
          describe(observation.state)
        }`,
      );
    }
  }
}

/** Includes the real bounded replacement initialization, not its unbounded
 * permission/source admission. Failure is terminal, never an absent predicate. */
export async function hostInitialized(host: PluginHost): Promise<void> {
  const state = await ownerSettled(
    () => {
      const work = host.settlement(["startup"]);
      return {
        ...work,
        state: { available: host.available, failure: work.failure },
      };
    },
    (state) => state.available || !!state.failure,
    "plugin host initialization",
  );
  if (state.failure) throw new Error(state.failure);
}
