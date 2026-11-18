// Test-owned time at the real verifier, never a product clock or response mock.
import { authenticatorCode, TOTP_STEP_MS } from "../../../tests/helpers/totp.ts";
import { resolve } from "node:path";

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
      clock.advanceStep();
      const code = await clock.code(secret);
      if (new Set(consumed).has(code)) throw Error("Current-step login code was already consumed");
      return code;
    },
    advanceStep() {
      now += TOTP_STEP_MS;
      Deno.writeTextFileSync(`${file}.next`, JSON.stringify(now));
      Deno.renameSync(`${file}.next`, file);
    },
  };
  return clock;
}
