// Test-owned time at the real verifier, never a product clock or response mock.
import { authenticatorCode, TOTP_STEP_MS, unusedWindowCode } from "../../../tests/helpers/totp.ts";
import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";
import { finalizeNativeCase } from "./native-case-finalization.mjs";

export async function createNativeTotpClock(directory, epochMs = Date.now()) {
  let now = Math.floor(epochMs / TOTP_STEP_MS) * TOTP_STEP_MS + TOTP_STEP_MS - 1;
  const file = `${directory}/authenticator-time.json`, preload = `${directory}/authenticator-time.mjs`;
  await Deno.writeTextFile(file, JSON.stringify(now), { createNew: true });
  await Deno.writeTextFile(preload, `Date.now = () => JSON.parse(Deno.readTextFileSync(${JSON.stringify(file)}));\n`, { createNew: true });
  const crossings = [];
  const clock = {
    denoArgs: ["--preload", preload], now: () => now,
    code: (secret, offset = 0) => authenticatorCode(secret, now + offset * TOTP_STEP_MS),
    unusedCode: (secret, consumed) => unusedWindowCode(secret, consumed, now, now + TOTP_STEP_MS),
    advanceStep() {
      now += TOTP_STEP_MS;
      Deno.writeTextFileSync(`${file}.next`, JSON.stringify(now));
      Deno.renameSync(`${file}.next`, file);
    },
    // Hold the browser's one real POST before the verifier sees it. A rollover
    // must not invalidate our chosen code; neither the request nor input repeats.
    async submitAcrossStep(session, submit) {
      let request, released = false, error;
      const stop = session.page.onEvent(event => {
        if (event.method === "Fetch.requestPaused") request = event.params;
      });
      try {
        await session.send("Fetch.enable", { patterns: [{ urlPattern: "*/_/api/token", requestStage: "Request" }] });
        await submit();
        await waitUntil(() => request ? done() : pending({ tokenRequestHeld: false }), { label: "TOTP token request held" });
        const before = now; clock.advanceStep();
        crossings.push({ before, verifiedAt: now, method: request.request.method, path: new URL(request.request.url).pathname });
        await Deno.writeTextFile(`${directory}/authenticator-crossings.json`, JSON.stringify(crossings, null, 2));
        await session.send("Fetch.continueRequest", { requestId: request.requestId }); released = true;
      } catch (failure) {
        error = failure; throw failure;
      } finally {
        await finalizeNativeCase({ error, cleanup: [stop,
          ...(request && !released ? [() => session.send("Fetch.failRequest", { requestId: request.requestId, errorReason: "Aborted" })] : []),
          () => session.send("Fetch.disable"),
        ] });
      }
    },
  };
  return clock;
}
