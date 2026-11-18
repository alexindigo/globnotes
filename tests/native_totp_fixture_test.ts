// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { createNativeTotpClock } from "../client/tests/e2e/native-totp-fixture.mjs";
import { authenticatorCode, TOTP_STEP_MS } from "./helpers/totp.ts";
import { isAbsolute, relative } from "node:path";
import { command, DENO } from "./helpers/process.ts";
import { captureNativeDiagnostics } from "../client/tests/e2e/harness-helpers.mjs";
import { checkTotpCode } from "../server/auth/local.ts";

type Paused = {
  method: string;
  params: {
    requestId: string;
    request: { method: string; url: string; postData?: string };
  };
};

function pausedToken(code: string, requestId = "token"): Paused {
  return {
    method: "Fetch.requestPaused",
    params: {
      requestId,
      request: {
        method: "POST",
        url: "http://globnotes.test:80/_/api/token",
        postData: JSON.stringify({
          username: "fixture",
          password: "password" + code,
        }),
      },
    },
  };
}

Deno.test("native TOTP fixture: one held token request crosses only its owned verifier clock", async () => {
  const directory = await Deno.makeTempDir({ prefix: "native-totp-clock-" });
  const originalNow = Date.now;
  try {
    const clock = await createNativeTotpClock(directory, 1234567890_000),
      before = clock.now();
    assertEquals(before % TOTP_STEP_MS, TOTP_STEP_MS - 1);
    const secret = "JBSWY3DPEHPK3PXP", consumed = await clock.code(secret);
    const selected = await clock.loginCode(secret, [consumed]);
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
      receive(pausedToken(selected, "one-token-request"));
    }, { secret, consumed: [consumed] });
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
    const [{ releaseAcknowledgedAt, ...crossing }] = JSON.parse(
      await Deno.readTextFile(`${directory}/authenticator-crossings.json`),
    );
    assertEquals(typeof releaseAcknowledgedAt, "number");
    assertEquals(crossing, {
      before,
      plannedVerificationAt: before + TOTP_STEP_MS,
      released: true,
      submittedCodeMatchesPlannedStep: true,
      method: "POST",
      path: "/_/api/token",
    });
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
        }, { secret: "JBSWY3DPEHPK3PXP" }),
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

Deno.test("native TOTP release-step assertion rejects a previous-window pass", async () => {
  const directory = await Deno.makeTempDir({ prefix: "native-release-code-" });
  try {
    const clock = await createNativeTotpClock(directory, 1234567890_000);
    const secret = "JBSWY3DPEHPK3PXP", releaseAt = clock.now() + TOTP_STEP_MS;
    const selected = await clock.loginCode(secret, []);
    const current = await authenticatorCode(secret, releaseAt);
    const originalNow = Date.now;
    let accepted;
    try {
      Date.now = () => releaseAt;
      accepted = checkTotpCode(selected, secret);
    } finally {
      Date.now = originalNow;
    }
    assertEquals(accepted, true);
    console.log(
      JSON.stringify({
        control: "release-step",
        verifierAccepts: accepted,
        matchesReleaseStep: selected === current,
      }),
    );
    assertEquals(
      selected,
      current,
      "A previous-step allowance is not a current release-step login proof",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native TOTP receipt and interception await continuation acknowledgment", async () => {
  const directory = await Deno.makeTempDir({ prefix: "native-release-ack-" });
  try {
    const clock = await createNativeTotpClock(directory, 1234567890_000);
    const before = clock.now(),
      entered = Promise.withResolvers<void>(),
      acknowledgment = Promise.withResolvers<void>();
    const secret = "JBSWY3DPEHPK3PXP",
      selected = await clock.loginCode(secret, []);
    let receive = (_event: Paused) => {};
    const order: string[] = [];
    const session = {
      page: {
        onEvent(listener: typeof receive) {
          receive = listener;
          return () => {};
        },
      },
      send(method: string) {
        order.push(method);
        if (method === "Fetch.continueRequest") {
          entered.resolve();
          return acknowledgment.promise;
        }
        return Promise.resolve();
      },
    };
    const operation = clock.submitAcrossStep(session, () => {
      receive(pausedToken(selected, "held-ack"));
    }, { secret });
    await entered.promise;
    try {
      assertEquals(order.includes("Fetch.disable"), false);
      const [planned] = JSON.parse(
        await Deno.readTextFile(`${directory}/authenticator-crossings.json`),
      );
      assertEquals(planned.plannedVerificationAt, before + TOTP_STEP_MS);
      assertEquals(planned.released, false);
      assertEquals(Object.hasOwn(planned, "verifiedAt"), false);
      assertEquals(Object.hasOwn(planned, "releaseAcknowledgedAt"), false);
    } finally {
      acknowledgment.resolve();
      await operation;
    }
    assertEquals(order.at(-1), "Fetch.disable");
    const [released] = JSON.parse(
      await Deno.readTextFile(`${directory}/authenticator-crossings.json`),
    );
    assertEquals(released.released, true);
    assertEquals(typeof released.releaseAcknowledgedAt, "number");
    assertEquals(Object.hasOwn(released, "verifiedAt"), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native TOTP gate rejects previous/spent codes and never labels failed continuation as released", async (t) => {
  for (const fault of ["previous", "spent", "continuation"]) {
    await t.step(fault, async () => {
      const directory = await Deno.makeTempDir({
        prefix: `native-rejected-${fault}-`,
      });
      try {
        const clock = await createNativeTotpClock(directory, 1234567890_000),
          before = clock.now();
        const secret = "JBSWY3DPEHPK3PXP", future = await clock.code(secret, 1);
        if (fault === "spent") {
          await assertRejects(
            () => clock.loginCode(secret, [future]),
            Error,
            "already consumed",
          );
        }
        const submitted = fault === "previous"
          ? await clock.code(secret)
          : future;
        let receive = (_event: Paused) => {};
        const order: string[] = [];
        const session = {
          page: {
            onEvent(listener: typeof receive) {
              receive = listener;
              return () => {};
            },
          },
          send(method: string) {
            order.push(method);
            return method === "Fetch.continueRequest"
              ? Promise.reject(Error("continuation disconnected"))
              : Promise.resolve();
          },
        };
        const reason = fault === "previous"
          ? "does not match the planned release step"
          : fault === "spent"
          ? "already consumed"
          : "continuation disconnected";
        await assertRejects(
          () =>
            clock.submitAcrossStep(
              session,
              () => receive(pausedToken(submitted)),
              {
                secret,
                consumed: fault === "spent" ? [future] : [],
              },
            ),
          Error,
          reason,
        );
        assertEquals(
          order.includes("Fetch.continueRequest"),
          fault === "continuation",
        );
        assertEquals(order.slice(-2), ["Fetch.failRequest", "Fetch.disable"]);
        const [record] = JSON.parse(
          await Deno.readTextFile(`${directory}/authenticator-crossings.json`),
        );
        assertEquals(record.plannedVerificationAt, before + TOTP_STEP_MS);
        assertEquals(record.released, false);
        assertEquals(Object.hasOwn(record, "releaseAcknowledgedAt"), false);
        assertEquals(Object.hasOwn(record, "verifiedAt"), false);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });
  }
});

Deno.test("native TOTP password-change proof leaves the next release-step code unspent", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "native-proof-reservation-",
  });
  try {
    const clock = await createNativeTotpClock(directory, 1234567890_000),
      secret = "JBSWY3DPEHPK3PXP";
    const initial = await clock.loginCode(secret, []);
    clock.advanceStep(); // Initial login verified this current step.
    assertEquals(initial, await clock.code(secret));
    clock.advanceStep(); // Fresh current proof, not the next login's step.
    const proof = await clock.code(secret);
    const login = await clock.loginCode(secret, [proof]);
    assertEquals(proof === initial, false);
    assertEquals(login === proof, false);
    assertEquals(
      login,
      await authenticatorCode(secret, clock.now() + TOTP_STEP_MS),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native TOTP fixture: relative artifacts produce absolute child paths and work from a different cwd", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "native-relative-clock-",
  });
  try {
    const clock = await createNativeTotpClock(
      relative(Deno.cwd(), directory),
      1234567890_000,
    );
    assertEquals(isAbsolute(clock.denoArgs[1]), true);
    const reader = `${directory}/read-clock.mjs`;
    await Deno.writeTextFile(reader, "console.log(Date.now());");
    await Deno.mkdir(`${directory}/other-cwd`);
    const child = await command(DENO, {
      cwd: `${directory}/other-cwd`,
      args: ["run", "--allow-read", ...clock.denoArgs, reader],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(child.success, true, new TextDecoder().decode(child.stderr));
    assertEquals(Number(new TextDecoder().decode(child.stdout)), clock.now());
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native diagnostics: PNG destinations, geometry and font readiness are independent", async () => {
  const directory = await Deno.makeTempDir({ prefix: "native-diagnostics-" });
  try {
    for (const fault of ["geometry", "fonts", "case-png"]) {
      const root = `${directory}/${fault}`;
      await Deno.mkdir(root);
      const casePng = `${root}/case.png`,
        uploadPng = `${root}/failure.png`,
        geometry = `${root}/geometry.json`;
      if (fault === "case-png") await Deno.mkdir(casePng);
      const session = {
        evaluate(expression: string) {
          const kind = expression.includes("document.fonts.ready")
            ? "fonts"
            : "geometry";
          if (kind === fault) throw Error(`injected ${fault} failure`);
          return Promise.resolve({ url: "http://globnotes.test/" });
        },
        send() {
          return Promise.resolve({ data: btoa("owned screenshot bytes") });
        },
      };
      await assertRejects(() =>
        captureNativeDiagnostics(session, {
          imagePaths: [casePng, uploadPng],
          geometryPath: geometry,
        })
      );
      assertEquals(
        await Deno.readTextFile(uploadPng),
        "owned screenshot bytes",
      );
      if (fault !== "geometry") {
        assertEquals(
          JSON.parse(await Deno.readTextFile(geometry)).url,
          "http://globnotes.test/",
        );
      }
      if (fault !== "case-png") {
        assertEquals(
          await Deno.readTextFile(casePng),
          "owned screenshot bytes",
        );
      }
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native server fixture: relative vault/state reach the child and one log failure cannot suppress its sibling", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "native-relative-server-",
  });
  const vault = `${directory}/vault`, state = `${directory}/state/globnotes`;
  try {
    await Deno.mkdir(vault);
    await Deno.mkdir(state, { recursive: true });
    await Deno.writeTextFile(
      `${vault}/Seed.md`,
      "relative child path consumer\n",
    );
    await Deno.writeTextFile(
      `${state}/config.json`,
      JSON.stringify({ auth_type: "none" }),
    );
    // Native origin discovery needs networkInterfaces. Keep that capability
    // in an owned native child, not in the ordinary server-test runner.
    const probe = `${directory}/probe.mjs`;
    await Deno.writeTextFile(
      probe,
      `
      import { bootServer } from ${
        JSON.stringify(
          new URL("../client/tests/e2e/harness-helpers.mjs", import.meta.url)
            .href,
        )
      };
      const server = await bootServer(${
        JSON.stringify(relative(Deno.cwd(), vault))
      }, ${JSON.stringify(relative(Deno.cwd(), state))}, {
        env: { GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE: "false" }, logsDir: ${
        JSON.stringify(directory)
      }
      });
      try {
        const note = await (await fetch(server.baseUrl + '/_/api/notes/Seed')).json();
        await Deno.mkdir(${JSON.stringify(`${directory}/server-stdout.log`)});
        let rejected = false;
        try { await server.close(); } catch { rejected = true; }
        console.log(JSON.stringify({ content: note.content, rejected, stderr: (await Deno.stat(${
        JSON.stringify(`${directory}/server-stderr.log`)
      })).isFile, code: server.status()?.code }));
      } finally { await server.close(); }
    `,
    );
    const child = await command(DENO, {
      cwd: Deno.cwd(),
      env: { GLOBNOTES_TEST_HOST: Deno.env.get("GLOBNOTES_TEST_HOST") ?? "" },
      args: [
        "run",
        "--cached-only",
        "--frozen",
        `--config=${new URL("../deno.json", import.meta.url).pathname}`,
        "--unstable-worker-options",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-env",
        "--allow-run",
        "--allow-sys=networkInterfaces",
        probe,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(child.success, true, new TextDecoder().decode(child.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(child.stdout)), {
      content: "relative child path consumer\n",
      rejected: true,
      stderr: true,
      code: 0,
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
