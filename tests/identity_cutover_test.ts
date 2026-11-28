// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createUuid } from "../shared/uuid.ts";
import { bootServer } from "./helpers/boot.ts";
import { withFixtureDirectory } from "./helpers/fixture_layout.ts";
import { accountScenario } from "./helpers/fixture_scenarios.ts";
import { createNativeTotpClock } from "../client/tests/e2e/native-totp-fixture.mjs";

for (const configured of [false, true]) {
  Deno.test(`account cutover: ${configured ? "configured first account signs in without setup" : "fresh install submits single-screen setup and opens notes"}`, () =>
    withFixtureDirectory(async (vault, scope) => {
      const password = "first-password";
      const login = "first-owner";
      await Deno.writeTextFile(
        `${vault}/Probe.md`,
        "# Probe\nOriginal note.\n",
      );
      const server = (await scope.acquire(() =>
        bootServer({
          GLOBNOTES__VAULTS_BASEPATH: vault,
          GLOBNOTES_GLOBNOTES_PATH: vault,
          ...(configured
            ? {
              GLOBNOTES__ACCOUNTS_FIRST_LOGIN: login,
              GLOBNOTES__ACCOUNTS_FIRST_PASSWORD: password,
              GLOBNOTES_GLOBNOTES_ADMIN: login,
            }
            : {}),
        }), (server) => server.close())).value;
      const api = (path: string, options?: RequestInit) =>
        fetch(`${server.baseUrl}/_/api/${path}`, options);
      const post = (path: string, data: object) =>
        api(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        });
      const setup = await api("setup");
      assertEquals([setup.status, await setup.json()], [200, {
        setupRequired: !configured,
      }]);
      const setupRequest = {
        username: login,
        password,
        everybody: "view",
        updateId: createUuid(),
      };
      if (configured) {
        const denied = await post("setup", setupRequest);
        assertEquals([denied.status, await denied.json()], [409, {
          detail: "Setup is already complete.",
        }]);
      }
      const started = configured
        ? await post("token", { username: login, password })
        : await post("setup", setupRequest);
      const reply = await started.json();
      assertEquals(started.status, 200, JSON.stringify(reply));
      assert(typeof reply.access_token === "string");
      const headers = { Authorization: `Bearer ${reply.access_token}` };
      const status = await api("auth-check", { headers });
      const statusBody = await status.json();
      assertEquals([
        status.status,
        statusBody.setupRequired,
        statusBody.principal.login,
        statusBody.capabilities.canManageVault,
      ], [200, false, login, true]);
      const note = await api("notes/Probe", { headers });
      assertEquals([note.status, (await note.json()).content], [
        200,
        "# Probe\nOriginal note.\n",
      ]);
      if (!configured) {
        const accessBefore = await api("access", { headers });
        assertEquals(accessBefore.status, 200);
        const prior = await accessBefore.json();
        for (const [body, expected] of [["{", 400], ["null", 422]] as const) {
          const invalid = await api("accounts", {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body,
          });
          const result = await invalid.json();
          assertEquals(invalid.status, expected);
          assertEquals(result, {
            detail: expected === 400
              ? "Invalid JSON request body."
              : "Invalid create-and-add request.",
          });
        }
        const accessAfter = await api("access", { headers });
        assertEquals([accessAfter.status, await accessAfter.json()], [
          200,
          prior,
        ]);
        for (
          const [path, method] of [["notes", "POST"], ["notes/Probe", "PATCH"]]
        ) {
          for (
            const [body, detail] of [["{", "Invalid JSON request body."], [
              "null",
              "Expected a JSON object.",
            ]]
          ) {
            const invalid = await api(path, {
              method,
              headers: { ...headers, "content-type": "application/json" },
              body,
            });
            assertEquals([invalid.status, await invalid.json()], [400, {
              detail,
            }]);
          }
        }
        assertEquals(
          await Deno.readTextFile(`${vault}/Probe.md`),
          "# Probe\nOriginal note.\n",
        );
      }
      const anonymous = await api("notes/Probe");
      assertEquals(anonymous.status, configured ? 403 : 200);
      await anonymous.body?.cancel();
      const stillSetup = await api("setup");
      assertEquals(await stillSetup.json(), { setupRequired: false });
    }));
}

for (
  const peerAccess of [
    "none",
    "same-account-save",
    "peer-save",
    "peer-no-op",
  ] as const
) {
  Deno.test(`account cutover: one current authenticator and independent Access (${peerAccess})`, () =>
    withFixtureDirectory(async (vault, scope) => {
      const login = "alice", password = "candidate-password";
      const clock = (await scope.acquire(() =>
        createNativeTotpClock(vault), (clock) =>
        clock.close())).value;
      const server = (await scope.acquire(() =>
        bootServer({
          GLOBNOTES__VAULTS_BASEPATH: vault,
          GLOBNOTES_GLOBNOTES_PATH: vault,
          fixtureScenario: accountScenario({
            vaultId: createUuid(),
            everybody: "none",
            people: [{ login, password }, { login: "bob", password }],
            grants: { alice: "admin", bob: "admin" },
          }),
        }, { denoArgs: clock.denoArgs }), (server) =>
        server.close())).value;
      async function call(
        path: string,
        method = "GET",
        data?: object,
        token?: string,
      ) {
        const response = await fetch(`${server.baseUrl}/_/api/${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
        return { status: response.status, body: await response.json() };
      }
      const token =
        (await call("token", "POST", { username: login, password })).body
          .access_token;
      const { body: { credentialRevision: revision } } = await call(
        "account",
        "GET",
        undefined,
        token,
      );
      const enroll = () =>
        call("account/totp-enrolment", "POST", undefined, token);
      const retired = await enroll(), current = await enroll();
      assertEquals([retired.status, current.status], [200, 200]);
      assertEquals([retired.body.key, current.body.key], [
        retired.body.secret,
        current.body.secret,
      ]);
      const accountFile = `${vault}/.globnotes/accounts.json`;
      const bytes = await Deno.readTextFile(accountFile);
      if (peerAccess !== "none") {
        const editor = peerAccess === "same-account-save"
          ? token
          : (await call("token", "POST", { username: "bob", password })).body
            .access_token;
        const { body: access } = await call("access", "GET", undefined, editor);
        const updateId = createUuid();
        const updated = await call("access", "PUT", {
          updateId,
          revision: access.revision,
          signature: access.signature,
          grants: access.grants,
          everybody: peerAccess === "peer-no-op" ? "none" : "view",
        }, editor);
        assertEquals([
          updated.status,
          updated.body.updateId,
          updated.body.committed,
        ], [200, updateId, true]);
        assertEquals(await Deno.readTextFile(accountFile), bytes);
      }
      const confirm = (key: string, code: string) =>
        call("account", "PATCH", {
          revision,
          updateId: createUuid(),
          currentPassword: password,
          totp: { enabled: true, key, code },
        }, token);
      const validCode = await clock.code(current.body.key);
      const wrong = `${(Number(validCode[0]) + 1) % 10}${validCode.slice(1)}`;
      for (
        const [key, code] of [
          [retired.body.key, await clock.code(retired.body.key)],
          [current.body.key, wrong],
          ["unissued", validCode],
        ]
      ) {
        const denied = await confirm(key, code);
        assertEquals(denied.status, 422, JSON.stringify(denied));
        assertEquals(await Deno.readTextFile(accountFile), bytes);
      }
      const applied = await confirm(current.body.key, validCode);
      assertEquals([applied.status, applied.body.requiresLogin], [200, true]);
      const saved = JSON.parse(await Deno.readTextFile(accountFile)).accounts
        .find((account: { login: string }) =>
          account.login === login
        );
      assertEquals([saved.totpKey, saved.totpKeyEncoding], [
        current.body.key,
        "base32",
      ]);
      const revoked = await call("account", "GET", undefined, token);
      assertEquals(revoked.status, 401);
      await clock.advanceStep();
      await clock.loginCode(
        current.body.key,
        [validCode],
        async (code: string) => {
          const signed = await call("token", "POST", {
            username: login,
            password,
            totp: code,
          });
          assertEquals(signed.status, 200);
          const authenticated = await call(
            "auth-check",
            "GET",
            undefined,
            signed.body.access_token,
          );
          assertEquals([
            authenticated.status,
            authenticated.body.principal.login,
          ], [200, login]);
        },
      );
    }));
}
