// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { createNativeTotpClock } from "../client/tests/e2e/native-totp-fixture.mjs";
import { authenticatorCode, TOTP_STEP_MS } from "./helpers/totp.ts";

type Paused = {
  method: string;
  params: {
    requestId: string;
    request: { method: string; url: string };
  };
};

Deno.test("native TOTP fixture: one held token request crosses only its owned verifier clock", async () => {
  const directory = await Deno.makeTempDir({ prefix: "native-totp-clock-" });
  const originalNow = Date.now;
  try {
    const clock = await createNativeTotpClock(directory, 1234567890_000),
      before = clock.now();
    assertEquals(before % TOTP_STEP_MS, TOTP_STEP_MS - 1);
    const secret = "JBSWY3DPEHPK3PXP", consumed = await clock.code(secret);
    const selected = await clock.unusedCode(secret, [consumed]);
    assertEquals(
      selected,
      await authenticatorCode(secret, before + TOTP_STEP_MS),
    );
    let receive = (_event: Paused) => {}, removed = false;
    const order: string[] = [];
    const session = {
      page: {
        onEvent(listener: typeof receive) {
          receive = listener;
          return () => {
            removed = true;
          };
        },
      },
      send(method: string) {
        order.push(method);
        if (method === "Fetch.continueRequest") {
          assertEquals(clock.now(), before + TOTP_STEP_MS);
          assertEquals(
            JSON.parse(
              Deno.readTextFileSync(`${directory}/authenticator-time.json`),
            ),
            before + TOTP_STEP_MS,
          );
        }
        return Promise.resolve();
      },
    };
    await clock.submitAcrossStep(session, () => {
      order.push("native submit");
      receive({
        method: "Fetch.requestPaused",
        params: {
          requestId: "one-token-request",
          request: {
            method: "POST",
            url: "http://globnotes.test:80/_/api/token",
          },
        },
      });
    });
    assertEquals(order, [
      "Fetch.enable",
      "native submit",
      "Fetch.continueRequest",
      "Fetch.disable",
    ]);
    assertEquals(removed, true);
    assertEquals(Date.now, originalNow);
    assertEquals(clock.denoArgs, [
      "--preload",
      `${directory}/authenticator-time.mjs`,
    ]);
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(`${directory}/authenticator-crossings.json`),
      ),
      [{
        before,
        verifiedAt: before + TOTP_STEP_MS,
        method: "POST",
        path: "/_/api/token",
      }],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native TOTP fixture: failed input aborts its held request without advancing or replaying it", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "native-totp-clock-failure-",
  });
  try {
    const clock = await createNativeTotpClock(directory, 1234567890_000),
      before = clock.now();
    let receive = (_event: Paused) => {};
    const order: string[] = [];
    const session = {
      page: {
        onEvent(listener: typeof receive) {
          receive = listener;
          return () => order.push("unsubscribe");
        },
      },
      send(method: string) {
        order.push(method);
        return Promise.resolve();
      },
    };
    await assertRejects(
      () =>
        clock.submitAcrossStep(session, () => {
          receive({
            method: "Fetch.requestPaused",
            params: {
              requestId: "failed-input",
              request: {
                method: "POST",
                url: "http://globnotes.test:80/_/api/token",
              },
            },
          });
          throw Error("native input failed");
        }),
      Error,
      "native input failed",
    );
    assertEquals(order, [
      "Fetch.enable",
      "unsubscribe",
      "Fetch.failRequest",
      "Fetch.disable",
    ]);
    assertEquals(clock.now(), before);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
