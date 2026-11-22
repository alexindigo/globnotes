// SPDX-License-Identifier: LGPL-3.0-only
import QRCode from "qrcode";
import {
  checkStoredTotpCode,
  createTotpCandidate,
  storedTotpManualSecret,
  type StoredTotpSecret,
} from "./credentials.ts";
import { createOwnershipScope } from "../../shared/ownership.js";
import { HttpError } from "@pathfinder/pathfinder";

export interface TotpEnrollmentBundle {
  readonly key: string;
  readonly secret: string;
  readonly uri: string;
  readonly qr: string;
}
export type EnrollmentRenderer = (uri: string) => Promise<string>;
/** Display label only: any accepted login, including one with an unpaired
 * surrogate, encodes. The stored login itself is never rewritten. */
function displayLabel(username: string): string {
  return encodeURIComponent(username.toWellFormed());
}
/** Presentation only. The credential aggregate owns issuance and generation. */
export async function renderAccountTotpEnrollment(
  username: string,
  candidate: StoredTotpSecret,
  render: EnrollmentRenderer = (uri) => QRCode.toDataURL(uri, { margin: 1 }),
): Promise<TotpEnrollmentBundle> {
  const secret = storedTotpManualSecret(candidate);
  const uri = `otpauth://totp/globnotes:${
    displayLabel(username)
  }?secret=${secret}&issuer=globnotes`;
  return Object.freeze({ key: secret, secret, uri, qr: await render(uri) });
}

/** Presentation convenience for fixtures. This does not issue enrollment
 * authority: production confirmation requires the current service candidate. */
export async function totpEnrolment(
  username: string,
): Promise<TotpEnrollmentBundle> {
  return await renderAccountTotpEnrollment(username, createTotpCandidate());
}

type LegacyLane = "setup" | "access";
interface LegacyAttempt {
  readonly lane: LegacyLane;
  readonly scope: ReturnType<typeof createOwnershipScope>;
  secret?: StoredTotpSecret;
  key?: string;
  ready: boolean;
}
function replaced(): never {
  throw new HttpError(422, "Authenticator enrollment was replaced.");
}
/** Temporary active-legacy adapter only. Account candidates remain exclusively
 * inside the credential aggregate. Deleted with the old routes at cutover. */
export class LegacyTotpEnrollments {
  readonly #render?: EnrollmentRenderer;
  // The echoed service-issued key identifies one attempt, never a shared lane.
  // A peer's issuance or save has no custody over that attempt.
  readonly #pending = new Map<string, LegacyAttempt>();
  constructor(render?: EnrollmentRenderer) {
    this.#render = render;
  }
  async issue(lane: LegacyLane, username: string) {
    if (lane !== "setup" && lane !== "access") {
      throw new HttpError(422, "Invalid enrollment scope.");
    }
    const attempt: LegacyAttempt = {
      lane,
      scope: createOwnershipScope(),
      ready: false,
    };
    try {
      const candidate = await attempt.scope.acquire(
        () => createTotpCandidate(),
        () => {
          attempt.secret = undefined;
          attempt.key = undefined;
        },
      );
      attempt.scope.assertCurrent();
      attempt.secret = candidate.value;
      attempt.key = storedTotpManualSecret(candidate.value);
      if (this.#pending.has(attempt.key)) replaced();
      this.#pending.set(attempt.key, attempt);
      const bundle = await renderAccountTotpEnrollment(
        username,
        candidate.value,
        this.#render,
      );
      if (this.#pending.get(attempt.key) !== attempt) replaced();
      attempt.scope.assertCurrent();
      attempt.ready = true;
      return bundle;
    } catch (error) {
      if (attempt.key && this.#pending.get(attempt.key) === attempt) {
        this.#pending.delete(attempt.key);
      }
      (await attempt.scope.releaseAll()).throwIfFailed(error);
      throw error;
    }
  }
  confirm(lane: LegacyLane, key: unknown, code: unknown) {
    const attempt = typeof key === "string"
      ? this.#pending.get(key)
      : undefined;
    if (
      !attempt?.secret || !attempt.ready || attempt.lane !== lane ||
      typeof key !== "string" || attempt.key !== key
    ) throw new HttpError(422, "Invalid authenticator enrolment.");
    if (
      typeof code !== "string" || !checkStoredTotpCode(code, attempt.secret)
    ) {
      throw new HttpError(
        400,
        lane === "setup"
          ? !code
            ? "A current authenticator code is required to enable TOTP."
            : "That code doesn't match this key - wait for a fresh code and try again."
          : "Confirm the new authenticator with its current six-digit code before changing access.",
      );
    }
    const assertCurrent = () => {
      if (this.#pending.get(key) !== attempt || attempt.key !== key) {
        replaced();
      }
      attempt.scope.assertCurrent();
    };
    assertCurrent();
    return Object.freeze({
      key,
      encoding: "base32" as const,
      assertCurrent,
      complete: () => this.#discard(attempt),
    });
  }
  async discard(lane: LegacyLane, key: string) {
    const attempt = this.#pending.get(key);
    if (attempt?.lane === lane) await this.#discard(attempt);
  }
  async #discard(attempt: LegacyAttempt) {
    if (attempt.key && this.#pending.get(attempt.key) === attempt) {
      this.#pending.delete(attempt.key);
      attempt.scope.retire();
      (await attempt.scope.releaseAll()).throwIfFailed();
    }
  }
}
const legacyOwners = new WeakMap<object, LegacyTotpEnrollments>();
export function pendingTotpEnrollments(owner: object): LegacyTotpEnrollments {
  let pending = legacyOwners.get(owner);
  if (!pending) legacyOwners.set(owner, pending = new LegacyTotpEnrollments());
  return pending;
}
