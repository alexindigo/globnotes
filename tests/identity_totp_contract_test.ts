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
import {
  LegacyTotpEnrollments,
  pendingTotpEnrollments,
} from "../server/auth/totp_enrolment.ts";
import { accessView, updateAccess } from "../server/auth/access.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import { assertThrows } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { identityFixture } from "./helpers/identity.ts";
import { GlobalConfig } from "./helpers/config.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { state } from "../server/state.ts";
import setup from "../server/api/endpoints/_/api/setup/post.ts";

Deno.test("legacy setup: held body cannot adopt a replacement configuration", () =>
  identityFixture(async (root) => {
    const previous = { ...state };
    const original = new GlobalConfig(
      testEnvironment({ GLOBNOTES_GLOBNOTES_PATH: `${root}/original` }),
    );
    const replacement = new GlobalConfig(
      testEnvironment({ GLOBNOTES_GLOBNOTES_PATH: `${root}/replacement` }),
    );
    state.config = original;
    state.auth = null;
    state.lifecycle = null;
    try {
      await heldOperation({
        label: "setup body owner",
        progress: { kind: "controlled", clock: "manual" },
        owner: () => original,
      }, (hold) =>
        setup({
          body: {
            text: async () => {
              await hold();
              return '{"mode":"none"}';
            },
          },
        } as unknown as PathfinderRequest), async (held) => {
        await held.reached();
        state.config = replacement;
        const before = [
          original.storedConfigText(),
          replacement.storedConfigText(),
        ];
        await assertRejects(() => held.result(), HttpError, "HTTP 409");
        assertEquals([
          original.storedConfigText(),
          replacement.storedConfigText(),
        ], before);
        assertEquals([original.setupRequired, replacement.setupRequired], [
          true,
          true,
        ]);
      });
    } finally {
      Object.assign(state, previous);
      for (const key of ["config", "auth", "lifecycle"]) {
        if (!Object.hasOwn(previous, key)) Reflect.deleteProperty(state, key);
      }
    }
  }));

// Main-side command contracts corresponding to the repository cases described
// in structure-credentials.md. No later OwnAccount workflow is imported here.
Deno.test("legacy enrollment: new setup issuance retires held QR work without discarding its replacement", async () => {
  let render = (uri: string) => Promise.resolve(`qr:${uri}`);
  const pending = new LegacyTotpEnrollments((uri) => render(uri));
  let heldKey = "";
  await heldOperation({
    label: "legacy QR generation",
    progress: { kind: "controlled", clock: "external" },
    owner: () => pending,
  }, (hold) => {
    render = async (uri) => {
      heldKey = new URL(uri).searchParams.get("secret")!;
      await hold();
      return `qr:${uri}`;
    };
    return pending.issue("setup", "alice");
  }, async (held) => {
    await held.reached();
    render = (uri) => Promise.resolve(`qr:${uri}`);
    const current = await pending.issue("setup", "alice");
    assertEquals([current.key, current.qr], [
      current.secret,
      `qr:${current.uri}`,
    ]);
    await assertRejects(
      () => held.result(),
      HttpError,
      "HTTP 422",
    );
    await pending.discard("setup", heldKey);
    assertEquals(
      assertThrows(
        () => pending.confirm("setup", current.key, ""),
        HttpError,
        "HTTP 400",
      ).status,
      400,
    );
    const error = assertThrows(
      () => pending.confirm("access", current.key, "123456"),
      HttpError,
      "HTTP 422",
    );
    assertEquals(error.status, 422);
    await pending.discard("setup", current.key);
    assertThrows(
      () => pending.confirm("setup", current.key, "123456"),
      HttpError,
      "HTTP 422",
    );
  });
});

for (const lane of ["setup", "access"] as const) {
  Deno.test(`legacy enrollment: issuance in the other lane does not retire a held ${lane} renderer`, async () => {
    let render = (uri: string) => Promise.resolve(`qr:${uri}`);
    const pending = new LegacyTotpEnrollments((uri) => render(uri));
    await heldOperation({
      label: "independent legacy QR attempts",
      progress: { kind: "controlled", clock: "external" },
      owner: () => pending,
    }, (hold) => {
      render = async (uri) => {
        await hold();
        return `qr:${uri}`;
      };
      return pending.issue(lane, "alice");
    }, async (held) => {
      await held.reached();
      render = (uri) => Promise.resolve(`qr:${uri}`);
      const otherLane = lane === "setup" ? "access" : "setup";
      const peer = await pending.issue(otherLane, "bob");
      const original = await held.result();
      for (
        const [issuer, bundle] of [[lane, original], [otherLane, peer]] as const
      ) {
        assertEquals([bundle.key, bundle.qr], [
          bundle.secret,
          `qr:${bundle.uri}`,
        ]);
        assertEquals(
          assertThrows(
            () => pending.confirm(issuer, bundle.key, ""),
            HttpError,
            "HTTP 400",
          ).status,
          400,
        );
        await pending.discard(issuer, bundle.key);
      }
    });
  });
  Deno.test(`legacy enrollment: ${lane} retains only its latest attempt regardless of the requested login label`, async () => {
    const pending = new LegacyTotpEnrollments((uri) =>
      Promise.resolve(`qr:${uri}`)
    );
    const first = await pending.issue(lane, "alice");
    const sameUser = await pending.issue(lane, "alice");
    const otherUser = await pending.issue(lane, "bob");
    for (const bundle of [first, sameUser]) {
      const error = assertThrows(
        () => pending.confirm(lane, bundle.key, ""),
        HttpError,
        "HTTP 422",
      );
      assertEquals(error.status, 422);
    }
    await pending.discard(lane, sameUser.key);
    assertEquals(
      assertThrows(
        () => pending.confirm(lane, otherUser.key, ""),
        HttpError,
        "HTTP 400",
      ).status,
      400,
    );
    await pending.discard(lane, otherUser.key);
    assertThrows(
      () => pending.confirm(lane, otherUser.key, ""),
      HttpError,
      "HTTP 422",
    );
  });
}

for (const changed of [false, true]) {
  Deno.test(`legacy enrollment: ${changed ? "changed" : "no-op"} peer Access save cannot retire an enrollment attempt`, () =>
    identityFixture(async (root) => {
      const previous = { ...state };
      const config = new GlobalConfig(
        testEnvironment({ GLOBNOTES_GLOBNOTES_PATH: root }),
      );
      config.saveStoredConfig({ auth_type: "none" });
      config.authType = "none" as typeof config.authType;
      config.setupRequired = false;
      state.config = config;
      state.auth = null;
      state.lifecycle = null;
      const pending = pendingTotpEnrollments(config);
      const bundle = await pending.issue("access", "alice");
      try {
        const view = await accessView();
        const result = await updateAccess(
          new Request("http://fixture/", { method: "PUT" }),
          {
            mode: changed ? "password" : "none",
            ...(changed ? { username: "bob", password: "peer password" } : {}),
            revision: view.revision,
            signature: view.signature,
          },
        );
        assertEquals([result.view.revision, result.requiresLogin], [
          view.revision + 1,
          changed,
        ]);
        assertEquals(
          assertThrows(
            () => pending.confirm("access", bundle.key, ""),
            HttpError,
            "HTTP 400",
          ).status,
          400,
        );
      } finally {
        await pending.discard("access", bundle.key);
        Object.assign(state, previous);
        for (const key of ["config", "auth", "lifecycle"]) {
          if (!Object.hasOwn(previous, key)) Reflect.deleteProperty(state, key);
        }
      }
    }));
}
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
