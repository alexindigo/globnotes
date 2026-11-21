// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createNativeTotpClock } from "../client/tests/e2e/native-totp-fixture.mjs";
import { authenticatorCode, TOTP_STEP_MS } from "./helpers/totp.ts";
import { isAbsolute, relative } from "node:path";
import { command, DENO } from "./helpers/process.ts";
import { captureNativeDiagnostics } from "../client/tests/e2e/harness-helpers.mjs";
import { nativeRecordChannelIO } from "./helpers/owned_record_channel.ts";

Deno.test("native TOTP frozen clock: rollover selects the verifier's fresh current step before input", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "native-frozen-boundary-",
  });
  const originalNow = Date.now;
  let ownedClock: Awaited<ReturnType<typeof createNativeTotpClock>> | undefined;
  try {
    const clock = ownedClock = await createNativeTotpClock(
      directory,
      1234567890_000,
    );
    const before = clock.now();
    assertEquals(before % TOTP_STEP_MS, TOTP_STEP_MS - 1);
    const secret = "JBSWY3DPEHPK3PXP";
    const legacyPrevious = await clock.code(secret, -1),
      enrolment = await clock.code(secret);
    const selected = await clock.loginCode(
      secret,
      [enrolment],
      (code: string) => code,
    );
    assertEquals(
      clock.now(),
      before + TOTP_STEP_MS,
      "Advance the verifier before selecting input, not while a request is in flight",
    );
    assertEquals(selected, await authenticatorCode(secret, clock.now()));
    assertEquals(selected === enrolment, false);
    const probe = `${directory}/verify.mjs`;
    await Deno.writeTextFile(
      probe,
      `
      import { checkTotpCode } from ${
        JSON.stringify(new URL("../server/auth/local.ts", import.meta.url).href)
      };
      console.log(JSON.stringify({ now: Date.now(), legacyAccepted: checkTotpCode(${
        JSON.stringify(legacyPrevious)
      }, ${JSON.stringify(secret)}), currentAccepted: checkTotpCode(${
        JSON.stringify(selected)
      }, ${JSON.stringify(secret)}) }));
    `,
    );
    const result = await command(DENO, {
      args: [
        "run",
        "--cached-only",
        "--frozen",
        `--config=${fromFileUrl(new URL("../deno.json", import.meta.url))}`,
        "--allow-read",
        "--allow-env",
        ...clock.denoArgs,
        probe,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
    const verified = JSON.parse(new TextDecoder().decode(result.stdout));
    assertEquals(verified, {
      now: clock.now(),
      legacyAccepted: false,
      currentAccepted: true,
    });
    assertStrictEquals(Date.now, originalNow);
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(`${directory}/authenticator-clock/time.json`),
      ).now,
      clock.now(),
    );
    console.log(
      JSON.stringify({
        boundary: "last millisecond -> fresh frozen step",
        ...verified,
      }),
    );
  } finally {
    await ownedClock?.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native TOTP frozen clock: equal-code collision is skipped before publishing time", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "native-frozen-collision-",
  });
  let ownedClock: Awaited<ReturnType<typeof createNativeTotpClock>> | undefined;
  try {
    const clock = ownedClock = await createNativeTotpClock(
      directory,
      1234567890_000,
    );
    const before = clock.now();
    const secret = "JBSWY3DPEHPK3PXP",
      consumed = await clock.code(secret),
      reference = clock.code;
    const candidates: { at: number; published: number }[] = [];
    // Force an equal-code pair at the consumed step and its successor.
    clock.code = (key: string, offset = 0) => {
      const at = clock.now() + offset * TOTP_STEP_MS;
      candidates.push({
        at,
        published: JSON.parse(
          Deno.readTextFileSync(`${directory}/authenticator-clock/time.json`),
        ).now,
      });
      return at === before + TOTP_STEP_MS
        ? Promise.resolve(consumed)
        : reference(key, offset);
    };
    const selected = await clock.loginCode(
      secret,
      [consumed],
      (code: string) => code,
    );
    assertEquals(
      selected,
      await authenticatorCode(secret, before + 2 * TOTP_STEP_MS),
    );
    assertEquals(selected === consumed, false);
    assertEquals(candidates, [
      { at: before + TOTP_STEP_MS, published: before },
      { at: before + 2 * TOTP_STEP_MS, published: before },
    ]);
    assertEquals(clock.now(), before + 2 * TOTP_STEP_MS);
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(`${directory}/authenticator-clock/time.json`),
      ).now,
      clock.now(),
    );
  } finally {
    await ownedClock?.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native TOTP frozen clock: failed publication preserves the starting step for the next login", async (t) => {
  for (const boundary of ["write", "rename"]) {
    await t.step(boundary, async () => {
      const directory = await Deno.makeTempDir({
        prefix: "native-frozen-publication-",
      });
      let ownedClock:
        | Awaited<ReturnType<typeof createNativeTotpClock>>
        | undefined;
      let failing = false;
      const cause = new Error(`injected ${boundary} failure`);
      try {
        const clock = ownedClock = await createNativeTotpClock(
          directory,
          1234567890_000,
          {
            io: {
              ...nativeRecordChannelIO,
              publication: {
                ...nativeRecordChannelIO.publication,
                [boundary]: (
                  ...args: [string, string | Uint8Array, AbortSignal?]
                ) => {
                  if (failing) throw cause;
                  // This port is selected by the fixture, before publication captures it.
                  return boundary === "write"
                    ? nativeRecordChannelIO.publication.write(...args)
                    : nativeRecordChannelIO.publication.rename(
                      args[0],
                      args[1] as string,
                      args[2],
                    );
                },
              },
            },
          },
        );
        const before = clock.now();
        const secret = "JBSWY3DPEHPK3PXP",
          file = `${directory}/authenticator-clock/time.json`;
        const consumed = await Promise.all(
          [1, 2, 3].map((offset) => clock.code(secret, offset)),
        );
        failing = true;
        assertStrictEquals(
          await assertRejects(
            () => clock.loginCode(secret, consumed, (code: string) => code),
            Error,
            cause.message,
          ),
          cause,
        );
        failing = false;
        assertEquals(JSON.parse(await Deno.readTextFile(file)).now, before);
        assertEquals(clock.now(), before);
        const code = await clock.loginCode(
          secret,
          consumed,
          (code: string) => code,
        );
        assertEquals(clock.now(), before + 4 * TOTP_STEP_MS);
        assertEquals(code, await authenticatorCode(secret, clock.now()));
        assertEquals(
          JSON.parse(await Deno.readTextFile(file)).now,
          clock.now(),
        );
      } finally {
        await ownedClock?.close();
        await Deno.remove(directory, { recursive: true });
      }
    });
  }
});

Deno.test("native TOTP frozen clock: current proofs leave later login codes unspent without adjacent-step fallback", async () => {
  const directory = await Deno.makeTempDir({ prefix: "native-frozen-proof-" });
  let ownedClock: Awaited<ReturnType<typeof createNativeTotpClock>> | undefined;
  try {
    const clock = ownedClock = await createNativeTotpClock(
      directory,
      1234567890_000,
    );
    const secret = "JBSWY3DPEHPK3PXP";
    const initial = await clock.loginCode(secret, [], (code: string) => code);
    assertEquals(initial, await clock.code(secret));
    await clock.advanceStep();
    const proof = await clock.code(secret);
    assertEquals(proof === initial, false);
    const login = await clock.loginCode(
      secret,
      [initial, proof],
      (code: string) => code,
    );
    assertEquals(login, await clock.code(secret));
    assertEquals([initial, proof].includes(login), false);
    const before = clock.now();
    const reserved = await Promise.all(
      [1, 2, 3, 4].map((offset) => clock.code(secret, offset)),
    );
    await assertRejects(
      () => clock.loginCode(secret, reserved, (code: string) => code),
      Error,
      "Every candidate login code was already consumed",
    );
    assertEquals(clock.now(), before);
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(`${directory}/authenticator-clock/time.json`),
      ).now,
      before,
    );
  } finally {
    await ownedClock?.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native TOTP fixture: relative artifacts produce absolute child paths and work from a different cwd", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "native-relative-clock-",
  });
  let ownedClock: Awaited<ReturnType<typeof createNativeTotpClock>> | undefined;
  try {
    const clock = ownedClock = await createNativeTotpClock(
      relative(Deno.cwd(), directory),
      1234567890_000,
    );
    assertEquals(isAbsolute(clock.denoArgs[1]), true);
    const reader = `${directory}/read-clock.mjs`;
    await Deno.writeTextFile(reader, "console.log(Date.now());");
    await Deno.mkdir(`${directory}/other-cwd`);
    const child = await command(DENO, {
      cwd: `${directory}/other-cwd`,
      args: [
        "run",
        `--config=${fromFileUrl(new URL("../deno.json", import.meta.url))}`,
        "--allow-read",
        ...clock.denoArgs,
        reader,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(child.success, true, new TextDecoder().decode(child.stderr));
    assertEquals(Number(new TextDecoder().decode(child.stdout)), clock.now());
  } finally {
    await ownedClock?.close();
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
      import { assertRejects, assertStrictEquals } from "@std/assert";
      import { bootServer } from ${
        JSON.stringify(
          new URL("../client/tests/e2e/harness-helpers.mjs", import.meta.url)
            .href,
        )
      };
      const env = { GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE: "false", GLOBNOTES__SERVER_PATHPREFIX: "/captured" };
      const constructing = bootServer(${
        JSON.stringify(relative(Deno.cwd(), vault))
      }, ${JSON.stringify(relative(Deno.cwd(), state))}, {
        env, logsDir: ${JSON.stringify(directory)}
      });
      env.GLOBNOTES__SERVER_PATHPREFIX = "/mutated";
      const server = await constructing;
      try {
        const note = await (await fetch(server.baseUrl + '/captured/_/api/notes/Seed')).json();
        await Deno.mkdir(${JSON.stringify(`${directory}/server-stdout.log`)});
         const first = server.close(), second = server.close();
         assertStrictEquals(second, first);
         const error = await assertRejects(() => first, Deno.errors.AlreadyExists, "File exists");
         assertStrictEquals(await assertRejects(() => second, Deno.errors.AlreadyExists, error.message), error);
         console.log(JSON.stringify({ content: note.content, rejected: true, stderr: (await Deno.stat(${
        JSON.stringify(`${directory}/server-stderr.log`)
      })).isFile, code: server.status()?.code }));
       } finally { await server.close().catch(() => {}); }
    `,
    );
    const child = await command(DENO, {
      cwd: Deno.cwd(),
      env: { GLOBNOTES_TEST_HOST: Deno.env.get("GLOBNOTES_TEST_HOST") ?? "" },
      args: [
        "run",
        "--cached-only",
        "--frozen",
        `--config=${fromFileUrl(new URL("../deno.json", import.meta.url))}`,
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
