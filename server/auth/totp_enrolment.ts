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
  // One slot per issuer for this config owner; the login is only a QR label.
  readonly #pending = new Map<LegacyLane, LegacyAttempt>();
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
    const previous = this.#pending.get(lane);
    this.#pending.set(lane, attempt);
    try {
      if (previous) (await previous.scope.releaseAll()).throwIfFailed();
      if (this.#pending.get(lane) !== attempt) replaced();
      const candidate = await attempt.scope.acquire(
        () => createTotpCandidate(),
        () => {
          attempt.secret = undefined;
          attempt.key = undefined;
        },
      );
      if (this.#pending.get(lane) !== attempt) replaced();
      attempt.scope.assertCurrent();
      attempt.secret = candidate.value;
      attempt.key = storedTotpManualSecret(candidate.value);
      const bundle = await renderAccountTotpEnrollment(
        username,
        candidate.value,
        this.#render,
      );
      if (this.#pending.get(lane) !== attempt) replaced();
      attempt.scope.assertCurrent();
      attempt.ready = true;
      return bundle;
    } catch (error) {
      if (this.#pending.get(lane) === attempt) this.#pending.delete(lane);
      (await attempt.scope.releaseAll()).throwIfFailed(error);
      throw error;
    }
  }
  confirm(lane: LegacyLane, key: unknown, code: unknown) {
    const attempt = this.#pending.get(lane);
    if (
      !attempt?.secret || !attempt.ready ||
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
      if (this.#pending.get(lane) !== attempt || attempt.key !== key) {
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
    const attempt = this.#pending.get(lane);
    if (attempt?.key === key) await this.#discard(attempt);
  }
  async #discard(attempt: LegacyAttempt) {
    if (this.#pending.get(attempt.lane) === attempt) {
      this.#pending.delete(attempt.lane);
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
