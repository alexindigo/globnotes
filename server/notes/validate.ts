// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Request-body validation mirroring the Python server's pydantic models
 * (notes/models.py): strip_whitespace + is_valid_note_path as
 * AfterValidators on NoteCreate.path / NoteUpdate.newPath. Failures
 * return FastAPI's 422 shape, not our {detail: string} — the client and
 * the parity harness see the pydantic format.
 */

import { isValidNotePath } from "../helpers.ts";
import { HttpError } from "../http_error.ts";

/** FastAPI/pydantic value-error detail array (pydantic 2.13.4 shape,
 * matching the Python server's exact JSON). */
function valueErrorDetail(
  field: string,
  message: string,
  input: unknown,
): object[] {
  return [
    {
      type: "value_error",
      loc: ["body", field],
      msg: `Value error, ${message}`,
      input,
      ctx: { error: {} },
    },
  ];
}

/** strip_whitespace + is_valid_note_path; throws HttpError(422) with
 * FastAPI's validation-error body on failure. Returns the stripped path. */
export function validateNotePath(value: unknown, field: string): string {
  const stripped = typeof value === "string" ? value.trim() : value;
  try {
    if (typeof stripped !== "string") {
      throw new Error("path must be a string");
    }
    return isValidNotePath(stripped);
  } catch (e) {
    throw new HttpError(
      422,
      valueErrorDetail(field, (e as Error).message, value),
    );
  }
}
