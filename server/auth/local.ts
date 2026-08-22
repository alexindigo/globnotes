// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Local username/password (and optional TOTP) authentication.
 * Ported from the Python server's auth/local/local.py with identical
 * semantics: env credentials win over stored config, HS256 JWTs, TOTP
 * codes append to the plaintext password, TOTP codes are single-use.
 */

import { jwtVerify, SignJWT } from "jose";
import { totp } from "otplib";
import { encodeBase32 } from "@std/encoding/base32";
import QRCode from "qrcode";

import { AuthType, type GlobalConfig } from "../config.ts";
import { getEnv, timingSafeEqual, verifyPassword } from "../helpers.ts";
import { logger } from "../logger.ts";
import type { Login, Token } from "./models.ts";

const JWT_ALGORITHM = "HS256";

export class LocalAuth {
  readonly username: string;
  /** Plaintext password from env (takes precedence over the stored hash). */
  private readonly password: string | null;
  private readonly passwordHash: string | null;
  private readonly secretKey: string;
  private readonly sessionExpiryDays: number;
  readonly isTotpEnabled: boolean;
  private totpSecret = "";
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

    // TOTP (env-configured only)
    this.isTotpEnabled = false;
    if (globalConfig.authType === AuthType.TOTP) {
      if (!this.password) {
        logger.error("GLOBNOTES_PASSWORD must be set when using TOTP auth.");
        Deno.exit(1);
      }
      this.isTotpEnabled = true;
      // The env value is raw text; the server base32-encodes it (same as
      // pyotp's b32encode in the Python server).
      this.totpSecret = encodeBase32(
        new TextEncoder().encode(
          getEnv("GLOBNOTES_TOTP_KEY", { mandatory: true }),
        ),
      );
    }
  }

  async login(data: Login): Promise<Token> {
    const usernameCorrect = timingSafeEqual(
      this.username,
      (data.username ?? "").toLowerCase(),
    );

    let passwordCorrect: boolean;
    let currentTotp: string | null = null;
    if (this.isTotpEnabled) {
      currentTotp = totp.generate(this.totpSecret);
      passwordCorrect = timingSafeEqual(
        this.password + currentTotp,
        data.password ?? "",
      );
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
        (!this.isTotpEnabled || currentTotp !== this.lastUsedTotp))
    ) {
      throw new Error("Incorrect login credentials.");
    }
    if (this.isTotpEnabled) {
      this.lastUsedTotp = currentTotp;
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

  /** Print the TOTP enrolment QR code + manual key at startup
   * (same as the Python server). Call after construction. */
  async displayTotpEnrolment(): Promise<void> {
    const unpaddedSecret = this.totpSecret.replace(/=+$/, "");
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
