// SPDX-License-Identifier: LGPL-3.0-only

/**
 * POST /_/api/token — log in, receive a bearer token. Public by design
 * (it IS the login). Mirrors the Python server's quirks:
 *   - auth type none/read_only → the route was never registered → 404
 *   - setup incomplete → route exists but no auth instance → 400
 */

import { login_failed } from "@server/api_messages.ts";
import type { Login, Token } from "@server/auth/models.ts";
import { AuthType } from "@server/config.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

export const auth = false;

export default async function (request): Promise<Token> {
  if (
    state.config.authType === AuthType.NONE ||
    state.config.authType === AuthType.READ_ONLY
  ) {
    throw new HttpError(404, "Not Found");
  }
  if (state.auth === null) {
    throw new HttpError(400, "Authentication is not enabled.");
  }
  const data = (await request.body.json()) as Login;
  try {
    return await state.auth.login(data);
  } catch {
    throw new HttpError(401, login_failed);
  }
}
