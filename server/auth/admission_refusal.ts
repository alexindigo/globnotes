// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";

const refusals = {
  credentials_refused: [401, "Invalid authentication credentials."],
  operation_not_permitted: [403, "This account cannot perform that operation."],
  setup_required: [503, "setup_required"],
  mutation_authority_required: [
    401,
    "API mutation request authority is required.",
  ],
} as const;

/** Issued when admission or a pre-effect authority fence refused the operation.
 * A generic HTTP status (including an unrelated 401/403/503) isn't this proof. */
export class AdmissionRefusal extends HttpError {
  constructor(readonly code: keyof typeof refusals) {
    const [status, detail] = refusals[code];
    super(
      status,
      detail,
      code === "credentials_refused"
        ? { "WWW-Authenticate": "Bearer" }
        : undefined,
    );
  }
  response() {
    return Response.json({ detail: this.detail, code: this.code }, {
      status: this.status,
      headers: this.headers,
    });
  }
}

/** Pathfinder's generic HttpError renderer emits detail only. Encode typed
 * refusals before that boundary; all unrelated errors retain their normal path. */
export function deliverAdmissionRefusals<Args extends unknown[], O>(
  handler: (...args: Args) => O,
) {
  return async (...args: Args): Promise<Awaited<O> | Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof AdmissionRefusal) return error.response();
      throw error;
    }
  };
}
