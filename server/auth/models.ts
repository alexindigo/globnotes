// SPDX-License-Identifier: LGPL-3.0-only

/** Auth request/response models (ported from server/auth/models.py). */

export interface Login {
  username: string;
  password: string;
}

/** OAuth convention: snake_case keys (the Python server used a plain
 * BaseModel for Token on purpose; the client reads `access_token`). */
export interface Token {
  access_token: string;
  token_type: string;
}
