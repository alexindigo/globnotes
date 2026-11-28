// SPDX-License-Identifier: LGPL-3.0-only
import { AuthenticationError, type InstanceSessions } from "./sessions.ts";
import { AdmissionRefusal } from "./admission_refusal.ts";
import { readRequestJson } from "./request_json.ts";

/** Prepared token adapter. Issued token bytes remain inside their guarded body. */
export function identityTokenHandler(sessions: InstanceSessions) {
  return async (request: Request): Promise<Response> => {
    const signal = request.signal;
    try {
      const issued = await sessions.login(
        await readRequestJson(request),
        signal,
      );
      return new Response(issued.body, {
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      if (!(error instanceof AuthenticationError)) throw error;
      if (!error.code) {
        return new AdmissionRefusal("credentials_refused").response();
      }
      return Response.json({
        message: "Invalid credentials.",
        ...(error.code ? { code: error.code } : {}),
      }, { status: 401 });
    }
  };
}
