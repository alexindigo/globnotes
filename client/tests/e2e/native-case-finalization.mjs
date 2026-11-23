import { createOwnershipScope } from "../../../shared/ownership.js";
import { createFixtureScope, ownFixtureScope } from "../../../tests/helpers/fixture_scope_engine.ts";

// The case retains custody of callback scopes through interruption as well as
// normal return. P03 cancels every child before joining it or closing the fixture.
export function createNativeCaseLifetime(closeFixture) {
  const lifetime = createFixtureScope();
  lifetime.scope.defer(closeFixture);
  let closing;
  return {
    ownScope: scope => ownFixtureScope(lifetime.scope, scope),
    close: () => closing ??= lifetime.close(),
  };
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
