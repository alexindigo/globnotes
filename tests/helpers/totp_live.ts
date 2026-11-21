// SPDX-License-Identifier: LGPL-3.0-only
/** Legacy live-clock convenience. Every runtime import is an inventoried A09
 * migration, never a public fallback on the explicit-time reference facade. */
import {
  TOTP_STEP_MS,
  totpStep,
  unusedWindowCode as explicitWindowCode,
} from "./totp.ts";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
export async function settledTotpNow(
  { consumedAtStep, marginMs = 5_000 }: {
    consumedAtStep?: number;
    marginMs?: number;
  } = {},
): Promise<number> {
  for (;;) {
    const now = Date.now(), step = totpStep(now);
    const remaining = (step + 1) * TOTP_STEP_MS - now;
    if (remaining > marginMs && step !== (consumedAtStep ?? NaN) + 1) {
      return now;
    }
    await sleep(remaining + 50);
  }
}
export async function unusedWindowCode(
  secret: string,
  consumed: Iterable<string>,
  epochMs?: number,
  verifiedAtMs?: number,
): Promise<string> {
  return await explicitWindowCode(
    secret,
    consumed,
    epochMs ?? await settledTotpNow(),
    verifiedAtMs,
  );
}
