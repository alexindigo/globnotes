// SPDX-License-Identifier: LGPL-3.0-only

/** HTTP error carrying a status code and FastAPI-compatible `detail`. */
export class HttpError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}
