// Test-owned time at the real verifier, never a product clock or response mock.
import { authenticatorCode, TOTP_STEP_MS } from "../../../tests/helpers/totp.ts";
import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";
import { finalizeNativeCase } from "./native-case-finalization.mjs";
import { resolve } from "node:path";

export async function createNativeTotpClock(directory, epochMs = Date.now()) {
  directory = resolve(directory);
  let now = Math.floor(epochMs / TOTP_STEP_MS) * TOTP_STEP_MS + TOTP_STEP_MS - 1;
  const file = `${directory}/authenticator-time.json`, preload = `${directory}/authenticator-time.mjs`;
  await Deno.writeTextFile(file, JSON.stringify(now), { createNew: true });
  await Deno.writeTextFile(preload, `Date.now = () => JSON.parse(Deno.readTextFileSync(${JSON.stringify(file)}));\n`, { createNew: true });
  const crossings = [];
  const clock = {
    denoArgs: ["--preload", preload], now: () => now,
    code: (secret, offset = 0) => authenticatorCode(secret, now + offset * TOTP_STEP_MS),
    async loginCode(secret, consumed) {
      const code = await authenticatorCode(secret, now + TOTP_STEP_MS);
      if (new Set(consumed).has(code)) throw Error("Release-step login code was already consumed");
      return code;
    },
    advanceStep() {
      now += TOTP_STEP_MS;
      Deno.writeTextFileSync(`${file}.next`, JSON.stringify(now));
      Deno.renameSync(`${file}.next`, file);
    },
    // Hold the browser's one real POST before the verifier sees it. A rollover
    // uses the new current-step code, not the verifier's previous-step allowance.
    async submitAcrossStep(session, submit, proof) {
      let request, released = false, error;
      const stop = session.page.onEvent(event => {
        if (event.method === "Fetch.requestPaused") request = event.params;
      });
      try {
        await session.send("Fetch.enable", { patterns: [{ urlPattern: "*/_/api/token", requestStage: "Request" }] });
        await submit();
        await waitUntil(() => request ? done() : pending({ tokenRequestHeld: false }), { label: "TOTP token request held" });
        const before = now; clock.advanceStep();
        if (!proof?.secret) throw Error("TOTP login requires a release-step proof");
        const submitted = String(JSON.parse(request.request.postData ?? "{}").password ?? "").slice(-6);
        const expected = await authenticatorCode(proof.secret, now);
        const crossing = { before, plannedVerificationAt: now, released: false,
          submittedCodeMatchesPlannedStep: submitted === expected,
          method: request.request.method, path: new URL(request.request.url).pathname };
        crossings.push(crossing);
        await Deno.writeTextFile(`${directory}/authenticator-crossings.json`, JSON.stringify(crossings, null, 2));
        if (!crossing.submittedCodeMatchesPlannedStep) throw Error("Submitted login code does not match the planned release step");
        if (new Set(proof.consumed ?? []).has(submitted)) throw Error("Release-step login code was already consumed");
        await session.send("Fetch.continueRequest", { requestId: request.requestId }); released = true;
        crossing.released = true;
        crossing.releaseAcknowledgedAt = Date.now();
        await Deno.writeTextFile(`${directory}/authenticator-crossings.json`, JSON.stringify(crossings, null, 2));
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
