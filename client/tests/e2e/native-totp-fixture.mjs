// Test-owned time at the real verifier, never a product clock or response mock.
import { authenticatorCode, TOTP_STEP_MS } from "../../../tests/helpers/totp.ts";
import { resolve } from "node:path";
import { createFixtureClock } from "../../../tests/helpers/fixture_clock.ts";
import { bootstrapFixtureEpoch } from "../../../tests/helpers/fixture_epoch.ts";
import { createFixtureScope } from "../../../tests/helpers/fixture_scope_engine.ts";

const LOGIN_STEP_CANDIDATES = 4;

export async function createNativeTotpClock(directory, epochMs = bootstrapFixtureEpoch(), options = {}) {
  const lifetime = createFixtureScope();
  return await lifetime.prepare(async scope => {
  directory = resolve(directory);
  const published = (await scope.acquire(() => createFixtureClock(directory, "authenticator-clock", Math.floor(epochMs / TOTP_STEP_MS) * TOTP_STEP_MS + TOTP_STEP_MS - 1, options), clock => clock.close())).value;
  scope.onCancel(() => published.close());
  const preload = `${directory}/authenticator-time.mjs`;
  await scope.admit(() => Deno.writeTextFile(preload, `import { fixtureClockReader } from ${JSON.stringify(new URL("../../../tests/helpers/fixture_clock.ts", import.meta.url).href)};\nDate.now = fixtureClockReader(${JSON.stringify(published.directory)});\n`, { createNew: true }));
  // Select and publish as one owned operation; explicit advances use the same lane.
  let tail = Promise.resolve();
  const enqueue = operation => {
    const previous = tail;
    const next = scope.admit(() => previous.then(() => {
      scope.assertCurrent();
      return operation();
    })).then(result => result.value);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  const clock = {
    denoArgs: ["--preload", preload], now: published.now, close: lifetime.close,
    code: (secret, offset = 0) => authenticatorCode(secret, published.now() + offset * TOTP_STEP_MS),
    // Move before choosing input; the owned verifier then stays frozen through
    // authentication. No request interception or adjacent-window fallback.
    async loginCode(secret, consumed) {
      const used = new Set(consumed);
      return await enqueue(async () => {
        for (let steps = 1; steps <= LOGIN_STEP_CANDIDATES; steps++) {
          const code = await clock.code(secret, steps);
          scope.assertCurrent();
          if (used.has(code)) continue;
          await published.advance(steps * TOTP_STEP_MS);
          return code;
        }
        throw Error("Every candidate login code was already consumed");
      });
    },
    advanceStep(steps = 1) {
      return enqueue(() => published.advance(steps * TOTP_STEP_MS));
    },
  };
  return clock;
  });
}
