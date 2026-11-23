import { createOwnershipScope } from "../../../shared/ownership.js";
import { createFixtureScope, retainFixtureScope } from "../../../tests/helpers/fixture_scope_engine.ts";

// The case retains custody of callback scopes through interruption as well as
// normal return. P03 cancels every child before joining it or closing the fixture.
export function createNativeCaseLifetime(closeFixture) {
  const lifetime = createFixtureScope();
  lifetime.scope.defer(closeFixture);
  let closing;
  return {
    ownScope: scope => retainFixtureScope(lifetime.scope, scope),
    close: () => closing ??= lifetime.close(),
  };
}

// Both normal and signal-driven close publish teardown failures before their
// caller can finish the case (or exit the process).
export async function closeNativeCase(close, reportFailure, settleReports = () => {}) {
  try { await close(); }
  catch (error) {
    try { await reportFailure(error); }
    catch (reportError) {
      throw new AggregateError([error, reportError], "Native teardown and failure report failed", { cause: error });
    }
    throw error;
  }
  await settleReports();
}

// Compatibility entry: callers retain their existing retention decisions and
// rethrow their case error when finalization succeeds. The core owns all release.
/** @param {{ report?: () => unknown, cleanup?: (() => unknown)[], error?: unknown }} [options] */
export async function finalizeNativeCase({ report = () => {}, cleanup = [], error } = {}) {
  const scope = createOwnershipScope({ failureMessage: "Native diagnostics or cleanup failed" });
  // The core is LIFO; this adapter preserves report-first, supplied cleanup order.
  [...cleanup].reverse().forEach(close => scope.defer(() => close()));
  scope.defer(() => report());
  const result = await scope.releaseAll();
  if (result.errors.length) result.throwIfFailed(...(error === undefined ? [] : [error]));
}
