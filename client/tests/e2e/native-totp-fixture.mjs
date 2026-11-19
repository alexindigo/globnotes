// Test-owned time at the real verifier, never a product clock or response mock.
import { authenticatorCode, TOTP_STEP_MS } from "../../../tests/helpers/totp.ts";
import { resolve } from "node:path";

const LOGIN_STEP_CANDIDATES = 4;

export async function createNativeTotpClock(directory, epochMs = Date.now()) {
  directory = resolve(directory);
  let now = Math.floor(epochMs / TOTP_STEP_MS) * TOTP_STEP_MS + TOTP_STEP_MS - 1;
  const file = `${directory}/authenticator-time.json`, preload = `${directory}/authenticator-time.mjs`;
  await Deno.writeTextFile(file, JSON.stringify(now), { createNew: true });
  await Deno.writeTextFile(preload, `Date.now = () => JSON.parse(Deno.readTextFileSync(${JSON.stringify(file)}));\n`, { createNew: true });
  const clock = {
    denoArgs: ["--preload", preload], now: () => now,
    code: (secret, offset = 0) => authenticatorCode(secret, now + offset * TOTP_STEP_MS),
    // Move before choosing input; the owned verifier then stays frozen through
    // authentication. No request interception or adjacent-window fallback.
    async loginCode(secret, consumed) {
      const used = new Set(consumed);
      for (let steps = 1; steps <= LOGIN_STEP_CANDIDATES; steps++) {
        const code = await clock.code(secret, steps);
        if (used.has(code)) continue;
        clock.advanceStep(steps);
        return code;
      }
      throw Error("Every candidate login code was already consumed");
    },
    advanceStep(steps = 1) {
      const next = now + steps * TOTP_STEP_MS;
      Deno.writeTextFileSync(`${file}.next`, JSON.stringify(next));
      Deno.renameSync(`${file}.next`, file);
      now = next;
    },
  };
  return clock;
}
