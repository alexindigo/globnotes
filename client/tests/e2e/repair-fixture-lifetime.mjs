// Ownership boundaries shared by the native repair driver and its contracts.
import { OwnershipError } from "../../../shared/ownership.js";

export function repairRequestHandler(scope, handle) {
  return async request => {
    try {
      return (await scope.admit(signal => handle(request, signal))).value;
    } catch (error) {
      if (scope.signal.aborted && (error === scope.signal.reason || error instanceof OwnershipError)) {
        return new Response("Repair fixture retired", { status: 503 });
      }
      throw error;
    }
  };
}

export function prepareRepairFixture(lifetime, construct, reportFailure) {
  return lifetime.prepare(async scope => {
    try {
      return await construct(scope);
    } catch (error) {
      // Report while the constructing scope still owns its live sessions.
      try {
        await reportFailure(error);
      } catch (reportError) {
        throw new AggregateError([error, reportError], "Repair preparation and failure report failed", { cause: error });
      }
      throw error;
    }
  });
}
