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

// Evidence belongs to a failure, not to whichever report writes last. Capture
// immediately at admission; serialize publication without recapturing old data.
export function createNativeFailureReporter(capture, write) {
  const entries = new Map();
  let reporting = Promise.resolve(), written = false;
  const describe = error => ({ message: String(error), ...(error instanceof AggregateError ? { errors: error.errors.map(describe) } : {}) });
  return {
    report(error) {
      if (entries.has(error)) return reporting;
      const evidence = (async () => {
        try { return structuredClone(await capture()); }
        catch (captureError) { return { observed: { error: String(captureError) } }; }
      })();
      entries.set(error, evidence);
      const admitted = [...entries];
      const publish = async () => {
        const observations = await Promise.all(admitted.map(async ([failure, snapshot]) => ({ error: String(failure), ...await snapshot })));
        await write({ ...observations[0], failures: admitted.map(([failure]) => describe(failure)), observations }, { createNew: !written });
        written = true;
      };
      return reporting = reporting.then(publish, publish);
    },
    settle: () => reporting,
  };
}

// A single owner combines body, report, close and listener-release outcomes.
// No throwing finally block can replace the original case failure.
export async function runNativeCase({ run, reportFailure, close, detach }) {
  let value, primary = [];
  try { value = await run(); }
  catch (error) { primary = [error]; }
  const result = await releaseNativeCase(() => primary.length ? reportFailure(primary[0]) : undefined, [close, detach]);
  result.throwIfFailed(...primary);
  return value;
}

async function releaseNativeCase(report, cleanup) {
  const scope = createOwnershipScope({ failureMessage: "Native diagnostics or cleanup failed" });
  [...cleanup].reverse().forEach(close => scope.defer(() => close()));
  scope.defer(() => report());
  return await scope.releaseAll();
}

// Compatibility entry: callers retain their existing retention decisions and
// rethrow their case error when finalization succeeds. The core owns all release.
/** @param {{ report?: () => unknown, cleanup?: (() => unknown)[], error?: unknown }} [options] */
export async function finalizeNativeCase({ report = () => {}, cleanup = [], error } = {}) {
  // The core is LIFO; this adapter preserves report-first, supplied cleanup order.
  const result = await releaseNativeCase(report, cleanup);
  if (result.errors.length) result.throwIfFailed(...(error === undefined ? [] : [error]));
}
