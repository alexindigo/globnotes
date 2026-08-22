// SPDX-License-Identifier: LGPL-3.0-only

/** HTTP error carrying a status code, FastAPI-compatible `detail`, and
 * optional response headers (e.g. WWW-Authenticate on 401s). */
export class HttpError extends Error {
  status: number;
  detail: string;
  headers: Record<string, string>;

  constructor(
    status: number,
    detail: string,
    headers: Record<string, string> = {},
  ) {
    super(detail);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}
