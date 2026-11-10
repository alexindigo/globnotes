// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The single owner of the process environment (configuration input).
 *
 * Server components receive an `Environment` instead of reading `Deno.env`
 * themselves; production uses `processEnvironment`, which reads the real
 * process environment on every lookup exactly as before. Tests inject their
 * own (see tests/helpers/environment.ts), so concurrent test modules — which
 * share one OS process under `deno test --parallel` — never see each other's
 * configuration. The preparatory consumers receive typed snapshots via the
 * temporary config/legacy.ts adapter; logger initialization also receives a level.
 */

export interface Environment {
  get(key: string): string | undefined;
}

export const processEnvironment: Environment = {
  get: (key) => Deno.env.get(key),
};

/** One immutable input record for the layered boundary; consumers do not reread it. */
export function snapshotEnvironment(): Record<string, string> {
  return Object.freeze(Deno.env.toObject());
}
