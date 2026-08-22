// SPDX-License-Identifier: LGPL-3.0-only

/** HTTP error carrying a status code, FastAPI-compatible `detail` (string
 * for app errors, or the pydantic validation array for 422s), and
 * optional response headers (e.g. WWW-Authenticate on 401s). */
export class HttpError extends Error {
  status: number;
  detail: unknown;
  headers: Record<string, string>;

  constructor(
    status: number,
    detail: unknown,
    headers: Record<string, string> = {},
  ) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}
