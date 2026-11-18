// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { createNativeTotpClock } from "../client/tests/e2e/native-totp-fixture.mjs";
import { authenticatorCode, TOTP_STEP_MS } from "./helpers/totp.ts";
import { isAbsolute, relative } from "node:path";
import { command, DENO } from "./helpers/process.ts";
import { captureNativeDiagnostics } from "../client/tests/e2e/harness-helpers.mjs";

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
