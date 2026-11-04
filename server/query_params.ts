// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The one parser for the REST API's integer query parameters (a page's
 * `limit` and `offset`). A value is a plain decimal of digits only and a
 * safe integer: blank or whitespace, signs, exponents, hex, fractions and
 * values past Number.MAX_SAFE_INTEGER are refused with 422 in the FastAPI
 * shape the API already uses, so nothing coerced or unsafe reaches the
 * index (notes/models.ts pageWindow). Absent means undefined.
 */

import { HttpError } from "@pathfinder/pathfinder";

export function nonNegativeQueryInteger(
  query: URLSearchParams,
  name: string,
): number | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const loc = ["query", name];
  if (/^-\d+$/.test(raw)) {
    throw new HttpError(422, [{
      type: "greater_than_equal",
      loc,
      msg: "Input should be greater than or equal to 0",
      input: raw,
      ctx: { ge: 0 },
    }]);
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value)) {
    throw new HttpError(422, [{
      type: "int_parsing",
      loc,
      msg: "Input should be a valid integer (digits only, at most " +
        `${Number.MAX_SAFE_INTEGER})`,
      input: raw,
    }]);
  }
  return value;
}
