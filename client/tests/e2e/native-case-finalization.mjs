// Reporting must never own whether resources are released. Callers supply their
// existing retention decisions; every requested cleanup is attempted in order.
export async function finalizeNativeCase({ report = () => {}, cleanup = [], error } = {}) {
  const failures = [];
  try {
    await report();
  } catch (failure) {
    failures.push(failure);
  } finally {
    for (const close of cleanup) {
      try { await close(); }
      catch (failure) { failures.push(failure); }
    }
  }
  // A pending/previous case error remains caller-owned when finalization works.
  if (!failures.length) return;
  if (error !== undefined && !failures.includes(error)) failures.unshift(error);
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, "Native diagnostics or cleanup failed", { cause: failures[0] });
}
