// SPDX-License-Identifier: LGPL-3.0-only

/**
 * POST /_/api/setup — complete first-run setup: disable auth, read-only
 * mode, or create a password. Public by design (it only runs once).
 * Ported from the Python server's post_setup with identical behavior.
 */

import { LocalAuth } from "@server/auth/local.ts";
import { AuthType } from "@server/config.ts";
import { hashPassword } from "@server/helpers.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { logger } from "@server/logger.ts";
import { state } from "@server/state.ts";
import { boundVault, isNamespaced } from "@server/vault.ts";

export const auth = false;

interface SetupRequest {
  mode?: string;
  username?: string;
  password?: string;
  access?: string;
}

const OPEN = new Set(["public", "hidden"]);
const LOCKED = new Set(["private", "secret"]);

export default async function (
  request,
): Promise<{ setupRequired: boolean }> {
  if (!state.config.setupRequired) {
    throw new HttpError(409, "Setup has already been completed.");
  }
  const data = (await request.body.json()) as SetupRequest;
  const config = state.config;
  const namespaced = isNamespaced();
  if (namespaced) {
    if (!data.access || (!OPEN.has(data.access) && !LOCKED.has(data.access))) {
      throw new HttpError(400, "access is required");
    }
    if (OPEN.has(data.access) && data.mode !== "none" && data.mode !== "read_only") {
      throw new HttpError(400, "Public/Hidden access allows none or read_only");
    }
    if (
      LOCKED.has(data.access) && data.mode !== "password"
    ) {
      throw new HttpError(400, "Private/Secret access allows password");
    }
  }
  const access = namespaced ? data.access : undefined;

  if (data.mode === "none") {
    config.saveStoredConfig({ auth_type: AuthType.NONE, access });
    config.authType = AuthType.NONE;
    config.setupRequired = false;
    logger.warning(
      "Authentication disabled via first-run setup. Anyone who can " +
        "reach this server can read and modify notes.",
    );
  } else if (data.mode === "read_only") {
    config.saveStoredConfig({ auth_type: AuthType.READ_ONLY, access });
    config.authType = AuthType.READ_ONLY;
    config.setupRequired = false;
    logger.info(
      "Read-only mode enabled via first-run setup. Notes can be " +
        "browsed and searched but not modified.",
    );
  } else if (data.mode === "password") {
    if (!data.username || !data.password) {
      throw new HttpError(400, "Username and password are required.");
    }
    const secretKey = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    config.saveStoredConfig({
      auth_type: AuthType.PASSWORD,
      username: data.username.toLowerCase(),
      password_hash: await hashPassword(data.password),
      secret_key: secretKey,
      access,
    });
    config.authType = AuthType.PASSWORD;
    config.setupRequired = false;
    state.auth = new LocalAuth(config, boundVault()?.slug ?? "");
  } else {
    // FastAPI rejects a non-Literal mode with 422.
    throw new HttpError(422, "Invalid setup mode.");
  }

  return { setupRequired: config.setupRequired };
}
