// SPDX-License-Identifier: LGPL-3.0-only
import { signIn } from "./helpers/session_delivery.ts";
import { storedAccount } from "./helpers/identity.ts";
import { assertEquals, assertRejects } from "@std/assert";
import {
  AuthenticationError,
  type CredentialChangeRequest,
} from "../server/auth/account_credentials.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import {
  COMMAND_NOW,
  credentialCommandFixture,
  enrollmentWithBytes,
} from "./helpers/credential_commands.ts";
import { ACCOUNT_A } from "./helpers/identity.ts";

// Main-side command contracts corresponding to the repository cases described
// in structure-credentials.md. No later OwnAccount workflow is imported here.
Deno.test("credential transition shape: no encoding-only patch, stored key patch, supplied step or hash enters the command vocabulary", () =>
  credentialCommandFixture(async (f) => {
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    for (
      const patch of [
        { totpKeyEncoding: "base32" },
        { lastTotpStep: 1 },
        { confirmedTotpStep: 1 },
        { passwordHash: "raw" },
        { proof: {} },
        { accountId: ACCOUNT_A },
        { authenticator: { kind: "keep", encoding: "base32" } },
        { authenticator: { kind: "enroll", key: "A".repeat(32), step: 123 } },
        { authenticator: { kind: "remove", lastTotpStep: 123 } },
        { newPassword: "" },
        { current: { password: "password", confirmedStep: 1 } },
      ]
    ) {
      await assertRejects(() =>
        f.accounts.credentials.changeOwn(
          f.authority,
          { ...f.request(), ...patch } as CredentialChangeRequest,
        ), IdentityStateError);
    }
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    assertEquals(storedAccount(f.accounts, ACCOUNT_A).lastTotpStep, null);
    const typeContract = () => {
      f.accounts.credentials.changeOwn(f.authority, {
        ...f.request(),
        // @ts-expect-error Counters do not constitute candidate confirmation.
        confirmedTotpStep: 123,
      });
      f.accounts.credentials.changeOwn(f.authority, {
        ...f.request(),
        // @ts-expect-error Stored encoding is not a command choice.
        authenticator: { kind: "keep", totpKeyEncoding: "base32" },
      });
      f.accounts.credentials.changeOwn(
        // @ts-expect-error Credential-bearing records cannot authorize changes.
        f.accounts.byId(ACCOUNT_A)!,
        f.request(),
      );
    };
    void typeContract;
  }));

for (
  const legacy of ["1234567890123456789", "key\0", "\ud800", "x".repeat(65)]
) {
  Deno.test(`credential transition floor: issued effective alias preserves its own later consumed floor (${JSON.stringify(legacy)})`, async () => {
    const raw = new TextEncoder().encode(legacy);
    const bytes = raw.length > 64
      ? new Uint8Array(await crypto.subtle.digest("SHA-1", raw))
      : new Uint8Array(20);
    if (raw.length <= 64) bytes.set(raw);
    await credentialCommandFixture(
      async (f) => {
        const bundle = await enrollmentWithBytes(f, bytes);
        const result = await f.accounts.credentials.changeOwn(
          f.authority,
          f.request({
            current: {
              password: "password",
              code: await f.code(legacy, undefined, 1),
            },
            authenticator: {
              kind: "enroll",
              key: bundle.key,
              code: await f.code(bundle.key, "base32", -1),
            },
          }),
        );
        assertEquals(result.credentialRevision, 1);
        const saved = storedAccount(f.accounts, ACCOUNT_A);
        assertEquals(saved.lastTotpStep, COMMAND_NOW / 30_000 + 1);
        assertEquals(saved.totpKeyEncoding, "base32");
        const oldCode = await f.code(bundle.key, "base32");
        await assertRejects(
          () =>
            f.accounts.credentials.authenticate("alice", "password", oldCode),
          AuthenticationError,
        );
      },
      {},
      { key: legacy, floor: COMMAND_NOW / 30_000 - 2 },
    );
  });
}

Deno.test("credential transition floor: equal-step confirmation is allowed only from this command's own consumption", () =>
  credentialCommandFixture(
    async (f) => {
      const bytes = new Uint8Array(20);
      bytes.set(new TextEncoder().encode("1234567890123456789"));
      const bundle = await enrollmentWithBytes(f, bytes);
      const code = await f.code(bundle.key, "base32");
      await f.accounts.credentials.changeOwn(
        f.authority,
        f.request({
          current: { password: "password", code },
          authenticator: { kind: "enroll", key: bundle.key, code },
        }),
      );
      assertEquals(
        storedAccount(f.accounts, ACCOUNT_A).lastTotpStep,
        COMMAND_NOW / 30_000,
      );
    },
    {},
    { key: "1234567890123456789", floor: COMMAND_NOW / 30_000 - 1 },
  ));

Deno.test("credential transition floor: already consumed same-secret candidate rejects before consuming a fresh current code", () =>
  credentialCommandFixture(
    async (f) => {
      const bytes = new Uint8Array(20);
      bytes.set(new TextEncoder().encode("key"));
      const bundle = await enrollmentWithBytes(f, bytes);
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
      const current = await f.code("key", undefined, 1);
      await assertRejects(async () =>
        f.accounts.credentials.changeOwn(
          f.authority,
          f.request({
            current: { password: "password", code: current },
            authenticator: {
              kind: "enroll",
              key: bundle.key,
              code: await f.code(bundle.key, "base32"),
            },
          }),
        ), IdentityStateError);
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
      await f.accounts.credentials.authenticate("alice", "password", current);
    },
    {},
    { key: "key", floor: COMMAND_NOW / 30_000 },
  ));

Deno.test("credential transition floor: a genuinely different issued secret starts at its actual matched step", () =>
  credentialCommandFixture(
    async (f) => {
      const bundle = await enrollmentWithBytes(f, new Uint8Array(20));
      await f.accounts.credentials.changeOwn(
        f.authority,
        f.request({
          current: {
            password: "password",
            code: await f.code("A".repeat(32), undefined, 1),
          },
          authenticator: {
            kind: "enroll",
            key: bundle.key,
            code: await f.code(bundle.key, "base32", -1),
          },
        }),
      );
      assertEquals(
        storedAccount(f.accounts, ACCOUNT_A).lastTotpStep,
        COMMAND_NOW / 30_000 - 1,
      );
      assertEquals(
        storedAccount(f.accounts, ACCOUNT_A).totpKeyEncoding,
        "base32",
      );
    },
    {},
    { key: "A".repeat(32), floor: COMMAND_NOW / 30_000 - 2 },
  ));

for (
  const stored of [
    { key: "key" },
    { key: "key\0", encoding: null },
    { key: "\ud800" },
    { key: "A".repeat(32) },
    { key: "A".repeat(32), encoding: "base32" as const },
    { key: "x".repeat(65) },
  ]
) {
  Deno.test(`credential transition history: password change preserves stored interpretation ${JSON.stringify(stored)}`, () =>
    credentialCommandFixture(
      async (f) => {
        const before = storedAccount(f.accounts, ACCOUNT_A);
        await f.accounts.credentials.changeOwn(
          f.authority,
          f.request({
            newPassword: "new password",
            current: { password: "password", code: await f.code() },
          }),
        );
        const after = storedAccount(f.accounts, ACCOUNT_A);
        assertEquals(after.totpKey, before.totpKey);
        assertEquals(after.totpKeyEncoding, before.totpKeyEncoding);
        assertEquals(
          Object.hasOwn(after, "totpKeyEncoding"),
          Object.hasOwn(before, "totpKeyEncoding"),
        );
        assertEquals(after.lastTotpStep, COMMAND_NOW / 30_000);
        await signIn(f.sessions, {
          username: "alice",
          password: "new password",
          totp: await f.code(stored.key, stored.encoding, 1),
        });
      },
      {},
      stored,
    ));
}
