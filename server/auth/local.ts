// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Local username/password (and optional TOTP) authentication.
 * Ported from the Python server's auth/local/local.py with identical
 * semantics: env credentials win over stored config, HS256 JWTs, TOTP
 * codes append to the plaintext password, TOTP codes are single-use.
 */

import { jwtVerify, SignJWT } from "jose";
import { totp } from "otplib";
import { hotpCreateHmacKey, KeyEncodings } from "otplib/core.js";
import { decodeBase32, encodeBase32 } from "@std/encoding/base32";
import QRCode from "qrcode";

import { AuthType, type GlobalConfig } from "../config.ts";
import { getEnv, timingSafeEqual, verifyPassword } from "../helpers.ts";
import { logger } from "../logger.ts";
import type { Login, Token } from "./models.ts";

const JWT_ALGORITHM = "HS256";

/** Raw key (the env-var / storedConfig form) → unpadded base32 secret —
 * the string an authenticator enrols. Single derivation path so the login
 * check and the wizard enrolment can never drift apart. */
export function totpSecretFromRawKey(rawKey: string): string {
  return encodeBase32(new TextEncoder().encode(rawKey)).replace(/=+$/, "");
}

/** Authenticators decode the QR's base32 secret before computing HMAC.
 * Keep those bytes intact, including short env keys, and accept +/-1 step. */
export function checkTotpCode(code: string, unpaddedSecret: string): boolean {
  const verifier = totp.clone();
  verifier.options = {
    encoding: KeyEncodings.HEX,
    window: 1,
    // TOTP's default repeats short keys; HMAC must use the enrolled bytes.
    createHmacKey: hotpCreateHmacKey,
  };
  const padded = unpaddedSecret.padEnd(
    Math.ceil(unpaddedSecret.length / 8) * 8,
    "=",
  );
  const key = [...decodeBase32(padded)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return verifier.check(code, key);
}

export class LocalAuth {
  readonly username: string;
  /** Plaintext password from env (takes precedence over the stored hash). */
  private readonly password: string | null;
  private readonly passwordHash: string | null;
  private readonly secretKey: string;
  private readonly sessionExpiryDays: number;
  readonly isTotpEnabled: boolean;
  /** True when the TOTP key came from GLOBNOTES_TOTP_KEY (not wizard). */
  readonly totpKeyFromEnv: boolean;
  private totpSecret = "";
  private unpaddedTotpSecret = "";
  private lastUsedTotp: string | null = null;

  constructor(globalConfig: GlobalConfig) {
    // Credentials come from environment variables when set (env always
    // wins), otherwise from the stored first-run setup config.
    const stored = globalConfig.storedConfig ?? {};
    this.username = (getEnv("GLOBNOTES_USERNAME") || stored.username || "")
      .toLowerCase();
    this.password = getEnv("GLOBNOTES_PASSWORD") || null;
    this.passwordHash = this.password ? null : (stored.password_hash ?? null);
    this.secretKey = getEnv("GLOBNOTES_SECRET_KEY") || stored.secret_key || "";
    if (
      !this.username || !(this.password || this.passwordHash) || !this.secretKey
    ) {
      logger.error(
        "Login credentials must be provided via environment " +
          "variables or the first-run setup wizard.",
      );
      Deno.exit(1);
    }
    this.sessionExpiryDays = Number(
      getEnv("GLOBNOTES_SESSION_EXPIRY_DAYS", { castInt: true, default: 30 }),
    );

    // TOTP — key from the environment, falling back to the stored
    // first-run setup config (wizard enrolment persists it there). Env
    // still wins; the raw value is base32-encoded for use (same as
    // pyotp's b32encode in the Python server).
    this.isTotpEnabled = false;
    this.totpKeyFromEnv = false;
    if (globalConfig.authType === AuthType.TOTP) {
      if (!this.password && !this.passwordHash) {
        logger.error(
          "TOTP auth requires a password (GLOBNOTES_PASSWORD or " +
            "the stored first-run setup hash).",
        );
        Deno.exit(1);
      }
      const envKey = getEnv("GLOBNOTES_TOTP_KEY");
      const rawKey = envKey || stored.totp_key;
      if (!rawKey) {
        logger.error(
          "TOTP auth requires GLOBNOTES_TOTP_KEY or a wizard-enrolled key.",
        );
        Deno.exit(1);
      }
      this.isTotpEnabled = true;
      this.totpKeyFromEnv = !!envKey;
      this.totpSecret = encodeBase32(new TextEncoder().encode(rawKey));
      // Authenticators enrol the UNPADDED form (the QR/manual key strips
      // padding) — check against the same string, stripped once here.
      this.unpaddedTotpSecret = this.totpSecret.replace(/=+$/, "");
    }
  }

  async login(data: Login): Promise<Token> {
    const usernameCorrect = timingSafeEqual(
      this.username,
      (data.username ?? "").toLowerCase(),
    );

    let passwordCorrect: boolean;
    let submittedTotp: string | null = null;
    if (this.isTotpEnabled) {
      // The client appends the 6-digit code to the password — verify them
      // separately (a shared string compare would couple a code typo to a
      // password failure and vice versa). The password half is plaintext
      // when env-provided, the stored hash when wizard-enrolled.
      const submitted = data.password ?? "";
      submittedTotp = submitted.slice(-6);
      const pass = submitted.slice(0, -6);
      const codeOk = checkTotpCode(submittedTotp, this.unpaddedTotpSecret);
      const passOk = this.password !== null
        ? timingSafeEqual(this.password, pass)
        : await verifyPassword(pass, this.passwordHash!);
      passwordCorrect = passOk && codeOk;
    } else if (this.password !== null) {
      passwordCorrect = timingSafeEqual(this.password, data.password ?? "");
    } else {
      passwordCorrect = await verifyPassword(
        data.password ?? "",
        this.passwordHash!,
      );
    }

    if (
      !(usernameCorrect && passwordCorrect &&
        (!this.isTotpEnabled || submittedTotp !== this.lastUsedTotp))
    ) {
      logger.warning(
        `Login rejected: usernameCorrect=${usernameCorrect} ` +
          `passwordCorrect=${passwordCorrect} ` +
          `isTotpEnabled=${this.isTotpEnabled} ` +
          `passwordLength=${(data.password ?? "").length}`,
      );
      throw new Error("Incorrect login credentials.");
    }
    if (this.isTotpEnabled) {
      // Single-use: an immediate replay of the accepted code is rejected
      // (one slot deep — a double-submit guard, per the Python server).
      this.lastUsedTotp = submittedTotp;
    }

    return {
      access_token: await this.#createAccessToken(),
      token_type: "bearer",
    };
  }

  /** Validate a bearer token; throws on missing/invalid/expired. */
  async validateToken(token: string | null | undefined): Promise<void> {
    if (!token) throw new Error("no token");
    const key = new TextEncoder().encode(this.secretKey);
    const { payload } = await jwtVerify(token, key);
    const sub = payload.sub;
    if (!sub || sub.toLowerCase() !== this.username) {
      throw new Error("wrong subject");
    }
  }

  async #createAccessToken(): Promise<string> {
    const key = new TextEncoder().encode(this.secretKey);
    const exp = Math.floor(Date.now() / 1000) +
      this.sessionExpiryDays * 86_400;
    return await new SignJWT({ sub: this.username })
      .setProtectedHeader({ alg: JWT_ALGORITHM })
      .setExpirationTime(exp)
      .sign(key);
  }

  /** Prime the single-use guard with a code already consumed elsewhere
   * (wizard enrolment), so it can't be replayed as a first login. */
  markTotpUsed(code: string): void {
    if (this.isTotpEnabled) this.lastUsedTotp = code;
  }

  /** Print the TOTP enrolment QR code + manual key at startup
   * (same as the Python server). Call after construction. */
  async displayTotpEnrolment(): Promise<void> {
    const unpaddedSecret = this.unpaddedTotpSecret;
    const uri =
      `otpauth://totp/globnotes:${encodeURIComponent(this.username)}` +
      `?secret=${unpaddedSecret}&issuer=globnotes`;
    const qr = await QRCode.toString(uri, { type: "terminal", small: true });
    console.log(
      "\nScan this QR code with your TOTP app of choice",
      "e.g. Authy or Google Authenticator:\n",
      qr,
      `\nOr manually enter this key: ${unpaddedSecret}\n`,
    );
  }
}
