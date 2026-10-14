// SPDX-License-Identifier: LGPL-3.0-only

/**
 * POST /_/api/setup — complete first-run setup: disable auth, read-only
 * mode, or create a password. Public by design (it only runs once).
 * Ported from the Python server's post_setup with identical behavior.
 */

import {
  checkTotpCode,
  LocalAuth,
  totpSecretFromRawKey,
} from "@server/auth/local.ts";
import { AuthType, StoredConfigConflict } from "@server/config.ts";
import { hashPassword } from "@server/helpers.ts";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { logger } from "@server/logger.ts";
import { state } from "@server/state.ts";

export const auth = false;

interface SetupRequest {
  mode?: string;
  username?: string;
  password?: string;
  /** Wizard TOTP enrolment: the minted key echoed back, plus the current
   * code proving the user recorded it. Both absent ⇒ plain password. */
  totpKey?: string;
  totpCode?: string;
  readOnlySettings?: boolean;
}

export default async function (
  request: PathfinderRequest,
): Promise<{ setupRequired: boolean }> {
  if (!state.config.setupRequired) {
    throw new HttpError(409, "Setup has already been completed.");
  }
  const data = (await request.body.json()) as SetupRequest;
  logger.info(
    `Setup attempt: mode=${data.mode} ` +
      `username=${data.username ?? "(none)"} ` +
      `passwordLength=${data.password?.length ?? 0}`,
  );
  const config = state.config;
  const snapshot = config.captureStoredConfig();
  const base = snapshot.raw === null ? null : JSON.parse(snapshot.raw);
  if (JSON.stringify(base) !== JSON.stringify(config.storedConfig)) {
    throw new HttpError(
      409,
      "Configuration changed before setup; deployment bytes retained.",
    );
  }
  if (
    data.readOnlySettings !== undefined &&
    typeof data.readOnlySettings !== "boolean"
  ) throw new HttpError(422, "readOnlySettings must be a boolean.");
  const complete = async () => {
    if (state.config !== config || !config.setupRequired) {
      throw new HttpError(409, "Setup has already been completed.");
    }
    try {
      config.assertStoredConfigUnchanged(snapshot);
      if (data.mode === "none") {
        config.saveStoredConfig({
          ...base,
          auth_type: AuthType.NONE,
          read_only_settings: data.readOnlySettings ?? false,
        }, snapshot);
        config.authType = AuthType.NONE;
        config.setupRequired = false;
        logger.warning(
          "Authentication disabled via first-run setup. Anyone who can " +
            "reach this server can read and modify notes.",
        );
      } else if (data.mode === "read_only") {
        config.saveStoredConfig({
          ...base,
          auth_type: AuthType.READ_ONLY,
        }, snapshot);
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
        let authType: AuthType = AuthType.PASSWORD;
        if (data.totpKey !== undefined) {
          // The code is verified BEFORE anything is persisted — a mismatch
          // leaves setup pending so the wizard stays open.
          if (!data.totpCode) {
            throw new HttpError(
              400,
              "A current authenticator code is required to enable TOTP.",
            );
          }
          if (
            !checkTotpCode(data.totpCode, totpSecretFromRawKey(data.totpKey))
          ) {
            throw new HttpError(
              400,
              "That code doesn't match this key — wait for a fresh code and try again.",
            );
          }
          authType = AuthType.TOTP;
        }
        const secretKey = [...crypto.getRandomValues(new Uint8Array(32))]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const passwordHash = await hashPassword(data.password);
        if (state.config !== config || !config.setupRequired) {
          throw new HttpError(
            409,
            "Setup changed while password preparation was pending.",
          );
        }
        config.saveStoredConfig({
          ...base,
          auth_type: authType,
          username: data.username.toLowerCase(),
          password_hash: passwordHash,
          secret_key: secretKey,
          ...(data.totpKey !== undefined ? { totp_key: data.totpKey } : {}),
        }, snapshot);
        config.authType = authType;
        config.setupRequired = false;
        state.auth = new LocalAuth(config);
        if (authType === AuthType.TOTP) {
          // The enrolment code is spent — don't accept it as a first login.
          state.auth.markTotpUsed(data.totpCode!);
        }
      } else {
        // FastAPI rejects a non-Literal mode with 422.
        throw new HttpError(422, "Invalid setup mode.");
      }
    } catch (err) {
      if (err instanceof StoredConfigConflict) {
        throw new HttpError(
          409,
          "Configuration changed while setup was pending; original deployment retained.",
        );
      }
      if (err instanceof HttpError) throw err;
      logger.error(
        `Setup failed (${data.mode}): ${
          err instanceof Error ? err.stack : err
        }`,
      );
      throw err;
    }

    logger.info(`Setup completed: mode=${data.mode}`);
    // New access policy: invalidate captured epochs, then start eligible
    // service contributions for the completed vault.
    state.lifecycle?.bumpEpoch();
    state.plugins?.runtime?.reconcile().catch((e) =>
      logger.error(`plugin runtime reconciliation failed: ${e}`)
    );
    return { setupRequired: config.setupRequired };
  };
  return state.lifecycle
    ? await state.lifecycle.gate.run(complete)
    : await complete();
}
