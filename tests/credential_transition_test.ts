// SPDX-License-Identifier: LGPL-3.0-only
import { signIn } from "./helpers/session_delivery.ts";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { totpEnrolment } from "../server/auth/totp_enrolment.ts";
import { fixtureGate, fixtureTest } from "./helpers/fixture_coordination.ts";
import {
  AuthenticationError,
  type CredentialAuthority,
  type CredentialChangeRequest,
} from "../server/auth/account_credentials.ts";
import { AccountRepository } from "../server/auth/accounts.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import { StoredConfigConflict } from "../server/config/file_store.ts";
import {
  COMMAND_NOW,
  credentialCommandFixture,
  enrollmentWithBytes,
  NEXT_UPDATE,
} from "./helpers/credential_commands.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  identityAccount,
  UPDATE,
} from "./helpers/identity.ts";
import { fixturePasswordHash } from "./helpers/config.ts";
import { workMilestone } from "./helpers/product_settlement.ts";
import { logger } from "../server/logger.ts";
import { verifyPassword } from "../server/helpers.ts";
import { AclRepository } from "../server/auth/acl.ts";
import { InstanceAuthority } from "../server/auth/authority.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import { VAULT_A } from "./helpers/identity.ts";
import { OwnershipError } from "../shared/ownership.js";

Deno.test("credential commands: repository validation cannot retire domain authority then enter the renderer", () => {
  let renders = 0;
  return credentialCommandFixture(async (f) => {
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    const unchanged = f.accounts.assertUnchanged.bind(f.accounts);
    f.accounts.assertUnchanged = (snapshot) => {
      unchanged(snapshot);
      f.retire();
    };
    await assertRejects(
      () => f.accounts.credentials.beginEnrollment(f.authority),
      OwnershipError,
      "Owner is retired",
    );
    assertEquals(renders, 0);
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
  }, {
    renderQr: () => {
      renders++;
      return Promise.resolve("qr");
    },
  });
});

Deno.test("credential commands: storage validation retirement reaches the actual write fence", () =>
  credentialCommandFixture(async (f) => {
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`),
      read = Deno.readTextFileSync;
    let staged = false;
    Deno.readTextFileSync = (file) => {
      const value = read(file);
      if (String(file).startsWith(`${f.root}/.config-`)) {
        staged = true;
        f.retire();
      }
      return value;
    };
    try {
      await assertRejects(
        () =>
          f.accounts.credentials.changeOwn(
            f.authority,
            f.request({ newPassword: "new password" }),
          ),
        OwnershipError,
        "Owner is retired",
      );
    } finally {
      Deno.readTextFileSync = read;
    }
    assertEquals(staged, true);
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    assertEquals(f.accounts.byId(ACCOUNT_A)?.credentialRevision, 0);
  }));

Deno.test("credential commands: the renderer is captured with the other aggregate adapters", () =>
  credentialCommandFixture(async (f) => {
    const first = await f.accounts.credentials.beginEnrollment(f.authority);
    f.options.renderQr = () => Promise.resolve("replacement renderer");
    const second = await f.accounts.credentials.beginEnrollment(f.authority);
    assertEquals([first.qr, second.qr], [
      `qr:${first.uri}`,
      `qr:${second.uri}`,
    ]);
  }));

Deno.test("credential commands: password change returns exact redacted committed identity and revokes only its old sessions", () =>
  credentialCommandFixture(async (f) => {
    f.accounts.importAccount(
      identityAccount({
        id: ACCOUNT_B,
        login: "bob",
        passwordHash: fixturePasswordHash("password"),
      }),
    );
    const old = await signIn(f.sessions, {
      username: "alice",
      password: "password",
    });
    const bob = await signIn(f.sessions, {
      username: "bob",
      password: "password",
    });
    const result = await f.accounts.credentials.changeOwn(
      f.authority,
      f.request({ newPassword: "new password" }),
    );
    assert(Object.isFrozen(result));
    assertEquals(Object.keys(result).sort(), [
      "credentialRevision",
      "credentialUpdateId",
      "id",
      "login",
      "passwordChangeRequired",
      "totpEnabled",
    ]);
    assertEquals(result, f.accounts.identityById(ACCOUNT_A));
    assertEquals(result.credentialRevision, 1);
    assertEquals(result.credentialUpdateId, UPDATE);
    await assertRejects(
      () => signIn(f.sessions, { username: "alice", password: "password" }),
      AuthenticationError,
    );
    await assertRejects(
      () => f.sessions.validateToken(old.access_token),
      AuthenticationError,
    );
    await f.sessions.validateToken(bob.access_token);
    await signIn(f.sessions, { username: "alice", password: "new password" });
    assertEquals(new AccountRepository(f.root).identityById(ACCOUNT_A), result);
  }));

Deno.test("credential commands: enrollment is inert, fixed-form and bound to the exact displayed QR secret", () =>
  credentialCommandFixture(async (f) => {
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    const bundle = await enrollmentWithBytes(f, new Uint8Array(20).fill(7));
    assert(Object.isFrozen(bundle));
    assert(/^[A-Z2-7]{32}$/.test(bundle.key));
    assertEquals(bundle.key, bundle.secret);
    assertEquals(
      bundle.uri,
      `otpauth://totp/globnotes:alice?secret=${bundle.secret}&issuer=globnotes`,
    );
    assert(bundle.qr.startsWith("data:image/png;base64,"));
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    const result = await f.accounts.credentials.changeOwn(
      f.authority,
      f.request({
        authenticator: {
          kind: "enroll",
          key: bundle.key,
          code: await f.code(bundle.key, "base32"),
        },
      }),
    );
    assert(result.totpEnabled);
    const account = f.accounts.byId(ACCOUNT_A)!;
    assertEquals(account.totpKey, bundle.key);
    assertEquals(account.totpKeyEncoding, "base32");
    assertEquals(account.lastTotpStep, COMMAND_NOW / 30_000);
    const reopened = new AccountRepository(f.root, undefined, {
      now: () => f.now,
    });
    const spent = await f.code(bundle.key, "base32");
    await assertRejects(
      () => reopened.credentials.authenticate("alice", "password", spent),
      AuthenticationError,
    );
    await reopened.credentials.authenticate(
      "alice",
      "password",
      await f.code(bundle.key, "base32", 1),
    );
  }, { renderQr: undefined }));

Deno.test("credential commands: replacement needs both codes and removal clears the authenticator and its floor", () =>
  credentialCommandFixture(
    async (f) => {
      const bundle = await f.accounts.credentials.beginEnrollment(f.authority);
      const current = await f.code();
      const request = f.request({
        current: { password: "password", code: current },
        authenticator: {
          kind: "enroll",
          key: bundle.key,
          code: await f.code(bundle.key, "base32"),
        },
      });
      await assertRejects(() =>
        f.accounts.credentials.changeOwn(f.authority, {
          ...request,
          authenticator: {
            ...request.authenticator,
            code: "bad",
          } as CredentialChangeRequest["authenticator"],
        }), IdentityStateError);
      assertEquals(f.accounts.byId(ACCOUNT_A)?.lastTotpStep, null);
      await f.accounts.credentials.changeOwn(f.authority, request);
      await signIn(f.sessions, {
        username: "alice",
        password: "password",
        totp: await f.code(bundle.key, "base32", 1),
      });
      f.now += 60_000;
      const removed = await f.accounts.credentials.changeOwn(
        f.bound(),
        f.request({
          credentialRevision: 1,
          updateId: NEXT_UPDATE,
          current: {
            password: "password",
            code: await f.code(bundle.key, "base32"),
          },
          authenticator: { kind: "remove" },
        }),
      );
      assertEquals(removed.totpEnabled, false);
      const saved = new AccountRepository(f.root).byId(ACCOUNT_A)!;
      assertEquals(saved.totpKey, null);
      assertEquals(saved.lastTotpStep, null);
      assert(!Object.hasOwn(saved, "totpKeyEncoding"));
      await signIn(f.sessions, { username: "alice", password: "password" });
    },
    {},
    { key: "key" },
  ));

for (const kind of ["keep", "remove", "enroll"] as const) {
  fixtureTest(
    `credential commands: independent code progress during held ${kind} hashing prevents publication`,
    (scope) => {
      const entered = fixtureGate(scope),
        release = fixtureGate<string>(scope);
      return credentialCommandFixture(async (f) => {
        const bundle = kind === "enroll"
          ? await f.accounts.credentials.beginEnrollment(f.authority)
          : undefined;
        const pending = f.accounts.credentials.changeOwn(
          f.authority,
          f.request({
            current: {
              password: "password",
              code: await f.code("key", undefined, -1),
            },
            newPassword: "new password",
            authenticator: bundle
              ? {
                kind: "enroll",
                key: bundle.key,
                code: await f.code(bundle.key, "base32"),
              }
              : { kind: kind === "remove" ? "remove" : "keep" },
          }),
        );
        pending.catch(() => {});
        try {
          await workMilestone(
            pending,
            entered.promise,
            "password hash entered",
          );
          const token = await signIn(f.sessions, {
            username: "alice",
            password: "password",
            totp: await f.code(),
          });
          const afterProgress = Deno.readTextFileSync(
            `${f.root}/accounts.json`,
          );
          release.resolve(fixturePasswordHash("new password"));
          await assertRejects(() => pending, AuthenticationError);
          assertEquals(
            Deno.readTextFileSync(`${f.root}/accounts.json`),
            afterProgress,
          );
          assertEquals(f.accounts.byId(ACCOUNT_A)?.credentialRevision, 0);
          await f.sessions.validateToken(token.access_token);
        } finally {
          release.resolve(fixturePasswordHash("new password"));
          await pending.catch(() => {});
        }
        const spent = await f.code("key", undefined, -1);
        await assertRejects(
          () => f.accounts.credentials.authenticate("alice", "password", spent),
          AuthenticationError,
        );
      }, {
        hash: () => {
          entered.resolve();
          return release.promise;
        },
      }, { key: "key" });
    },
  );
}

fixtureTest(
  "credential commands: a replacement generation during hashing rejects even equal key text",
  (scope) => {
    const entered = fixtureGate(scope),
      release = fixtureGate<string>(scope);
    return credentialCommandFixture(async (f) => {
      const random = crypto.getRandomValues;
      crypto.getRandomValues = function <T extends ArrayBufferView>(
        array: T,
      ): T {
        if (array instanceof Uint8Array && array.length === 20) {
          array.fill(7);
          return array;
        }
        return random.call(crypto, array) as T;
      };
      let first;
      try {
        first = await f.accounts.credentials.beginEnrollment(f.authority);
      } finally {
        crypto.getRandomValues = random;
      }
      const pending = f.accounts.credentials.changeOwn(
        f.authority,
        f.request({
          newPassword: "new password",
          authenticator: {
            kind: "enroll",
            key: first.key,
            code: await f.code(first.key, "base32"),
          },
        }),
      );
      pending.catch(() => {});
      try {
        await workMilestone(pending, entered.promise, "password hash entered");
        crypto.getRandomValues = function <T extends ArrayBufferView>(
          array: T,
        ): T {
          if (array instanceof Uint8Array && array.length === 20) {
            array.fill(7);
            return array;
          }
          return random.call(crypto, array) as T;
        };
        let second;
        try {
          second = await f.accounts.credentials.beginEnrollment(f.authority);
        } finally {
          crypto.getRandomValues = random;
        }
        assertEquals(second.key, first.key);
        release.resolve(fixturePasswordHash("new password"));
        await assertRejects(() => pending);
        assertEquals(f.accounts.byId(ACCOUNT_A)?.totpKey, null);
      } finally {
        crypto.getRandomValues = random;
        release.resolve(fixturePasswordHash("new password"));
        await pending.catch(() => {});
      }
    }, {
      hash: () => {
        entered.resolve();
        return release.promise;
      },
    });
  },
);

Deno.test("credential commands: retired, forged and wrong-purpose authority cannot enter enrollment or publication", () =>
  credentialCommandFixture(async (f) => {
    const proof = await f.accounts.credentials.authenticate(
      "alice",
      "password",
    );
    for (
      const authority of [
        {},
        { ...f.authority },
        { ...f.authority, accountId: ACCOUNT_B },
        { accountId: ACCOUNT_A, credentialRevision: 0, lease: {} },
        proof,
        null,
      ]
    ) {
      await assertRejects(() =>
        f.accounts.credentials.beginEnrollment(authority as CredentialAuthority)
      );
      await assertRejects(() =>
        f.accounts.credentials.changeOwn(
          authority as CredentialAuthority,
          f.request(),
        )
      );
    }
    f.retire();
    await assertRejects(() =>
      f.accounts.credentials.beginEnrollment(f.authority)
    );
    await assertRejects(() =>
      f.accounts.credentials.changeOwn(f.authority, f.request())
    );
    assertEquals(f.accounts.byId(ACCOUNT_A)?.credentialRevision, 0);
  }));

Deno.test("credential commands: temporary password must change before other credential choices", () =>
  credentialCommandFixture(
    async (f) => {
      await assertRejects(
        () => f.accounts.credentials.changeOwn(f.authority, f.request()),
        IdentityStateError,
      );
      const result = await f.accounts.credentials.changeOwn(
        f.authority,
        f.request({ newPassword: "permanent password" }),
      );
      assertEquals(result.passwordChangeRequired, false);
      await signIn(f.sessions, {
        username: "alice",
        password: "permanent password",
      });
    },
    {},
    null,
    true,
  ));

Deno.test("credential commands: a forced change rejects the temporary password before spending the current code", () =>
  credentialCommandFixture(
    async (f) => {
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
      const code = await f.code();
      await assertRejects(
        () =>
          f.accounts.credentials.changeOwn(
            f.authority,
            f.request({
              current: { password: "password", code },
              newPassword: "password",
            }),
          ),
        IdentityStateError,
      );
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
      const result = await f.accounts.credentials.changeOwn(
        f.authority,
        f.request({
          current: { password: "password", code },
          newPassword: "permanent password",
        }),
      );
      assertEquals(result.passwordChangeRequired, false);
      const next = await f.code(undefined, undefined, 1);
      await assertRejects(
        () => f.accounts.credentials.authenticate("alice", "password", next),
        AuthenticationError,
      );
      await f.accounts.credentials.authenticate(
        "alice",
        "permanent password",
        next,
      );
    },
    {},
    { key: "key" },
    true,
  ));

Deno.test("credential commands: enrollment renders a login with an unpaired surrogate and keeps it stored as is", () =>
  credentialCommandFixture(async (f) => {
    const login = "alice\uD800";
    f.accounts.importAccount(
      identityAccount({
        id: ACCOUNT_B,
        login,
        passwordHash: fixturePasswordHash("password"),
      }),
    );
    const owner = f.bound(f.accounts.identityById(ACCOUNT_B)!);
    const bundle = await enrollmentWithBytes(
      f,
      new Uint8Array(20).fill(7),
      owner,
    );
    assertEquals(
      bundle.uri,
      `otpauth://totp/globnotes:alice%EF%BF%BD?secret=${bundle.secret}&issuer=globnotes`,
    );
    const result = await f.accounts.credentials.changeOwn(
      owner,
      f.request({
        authenticator: {
          kind: "enroll",
          key: bundle.key,
          code: await f.code(bundle.key, "base32"),
        },
      }),
    );
    assert(result.totpEnabled);
    assertEquals(f.accounts.byId(ACCOUNT_B)!.login, login);
    assertEquals(f.accounts.byId(ACCOUNT_B)!.totpKey, bundle.key);
    const setup = await totpEnrolment(login);
    assertEquals(
      setup.uri,
      `otpauth://totp/globnotes:alice%EF%BF%BD?secret=${setup.secret}&issuer=globnotes`,
    );
  }));

fixtureTest(
  "credential commands: overlapping fixed-byte enrollments restore native randomness before rendering settles",
  (scope) => {
    const gates = [
      fixtureGate<string>(scope),
      fixtureGate<string>(scope),
      fixtureGate<string>(scope),
    ];
    const uris: string[] = [];
    return credentialCommandFixture(async (f) => {
      f.accounts.importAccount(
        identityAccount({
          id: ACCOUNT_B,
          login: "bob",
          passwordHash: fixturePasswordHash("password"),
        }),
      );
      const bob = f.bound(f.accounts.identityById(ACCOUNT_B)!);
      const native = crypto.getRandomValues;
      const first = enrollmentWithBytes(f, new Uint8Array(20).fill(1));
      const second = enrollmentWithBytes(f, new Uint8Array(20).fill(2), bob);
      assertStrictEquals(crypto.getRandomValues, native);
      assertEquals(uris.length, 2);
      gates[0].resolve(`qr:${uris[0]}`);
      const a = await first;
      gates[1].resolve(`qr:${uris[1]}`);
      const b = await second;
      assertStrictEquals(crypto.getRandomValues, native);
      assertNotEquals(a.key, b.key);
      const pending = f.accounts.credentials.beginEnrollment(f.authority);
      assertEquals(uris.length, 3);
      gates[2].resolve(`qr:${uris[2]}`);
      const later = await pending;
      assertNotEquals(later.key, a.key);
      assertNotEquals(later.key, b.key);
    }, {
      renderQr: (uri) => {
        const gate = gates[uris.length];
        uris.push(uri);
        return gate.promise;
      },
    });
  },
);

Deno.test("credential commands: foreign authority and another account's candidate cannot change this account", () =>
  credentialCommandFixture(async (f) => {
    f.accounts.importAccount(
      identityAccount({
        id: ACCOUNT_B,
        login: "bob",
        passwordHash: fixturePasswordHash("password"),
      }),
    );
    const bob = f.bound(f.accounts.identityById(ACCOUNT_B)!);
    const candidate = await f.accounts.credentials.beginEnrollment(bob);
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    await assertRejects(
      async () =>
        f.accounts.credentials.changeOwn(
          f.authority,
          f.request({
            authenticator: {
              kind: "enroll",
              key: candidate.key,
              code: await f.code(candidate.key, "base32"),
            },
          }),
        ),
      IdentityStateError,
    );
    await credentialCommandFixture(async (other) => {
      await assertRejects(
        () => f.accounts.credentials.changeOwn(other.authority, f.request()),
        IdentityStateError,
      );
      await assertRejects(
        () => f.accounts.credentials.beginEnrollment(other.authority),
        IdentityStateError,
      );
    });
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    assertThrows(
      () => Object.assign(f.authority, { accountId: ACCOUNT_B }),
      TypeError,
    );
  }));

fixtureTest(
  "credential commands: obsolete QR completion cannot displace the newer generation",
  (scope) => {
    const entered = fixtureGate(scope),
      release = fixtureGate<string>(scope);
    let calls = 0;
    return credentialCommandFixture(async (f) => {
      const first = f.accounts.credentials.beginEnrollment(f.authority);
      first.catch(() => {});
      try {
        await workMilestone(
          first,
          entered.promise,
          "first QR rendering entered",
        );
        const second = await f.accounts.credentials.beginEnrollment(
          f.authority,
        );
        release.resolve("old QR");
        await assertRejects(() => first, StoredConfigConflict);
        await f.accounts.credentials.changeOwn(
          f.authority,
          f.request({
            authenticator: {
              kind: "enroll",
              key: second.key,
              code: await f.code(second.key, "base32"),
            },
          }),
        );
        assertEquals(f.accounts.byId(ACCOUNT_A)?.totpKey, second.key);
      } finally {
        release.resolve("old QR");
        await first.catch(() => {});
      }
    }, {
      renderQr: (uri) => {
        if (++calls === 1) {
          entered.resolve();
          return release.promise;
        }
        return Promise.resolve(`qr:${uri}`);
      },
    });
  },
);

for (
  const failure of [
    "abort",
    "domain retirement",
    "aggregate retirement",
  ] as const
) {
  fixtureTest(
    `credential commands: ${failure} during QR rendering returns no candidate`,
    (scope) => {
      const entered = fixtureGate(scope),
        release = fixtureGate<string>(scope);
      return credentialCommandFixture(async (f) => {
        const abort = new AbortController();
        const pending = f.accounts.credentials.beginEnrollment(
          f.authority,
          abort.signal,
        );
        pending.catch(() => {});
        try {
          await workMilestone(pending, entered.promise, "QR rendering entered");
          if (failure === "abort") abort.abort();
          if (failure === "domain retirement") f.retire();
          if (failure === "aggregate retirement") {
            f.accounts.retireCredentials();
          }
          release.resolve("retired QR");
          await assertRejects(() => pending);
          assertEquals(f.accounts.byId(ACCOUNT_A)?.totpKey, null);
        } finally {
          release.resolve("retired QR");
          await pending.catch(() => {});
        }
      }, {
        renderQr: () => {
          entered.resolve();
          return release.promise;
        },
      });
    },
  );
}

for (
  const failure of [
    "abort",
    "domain retirement",
    "aggregate retirement",
    "equal-file replacement",
  ] as const
) {
  fixtureTest(
    `credential commands: ${failure} during hashing prevents the credential write`,
    (scope) => {
      const entered = fixtureGate(scope),
        release = fixtureGate<string>(scope);
      return credentialCommandFixture(async (f) => {
        const abort = new AbortController();
        const pending = f.accounts.credentials.changeOwn(
          f.authority,
          f.request({
            current: { password: "password", code: await f.code() },
            newPassword: "new password",
          }),
          abort.signal,
        );
        pending.catch(() => {});
        try {
          await workMilestone(
            pending,
            entered.promise,
            "password hash entered",
          );
          const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
          if (failure === "abort") abort.abort();
          if (failure === "domain retirement") f.retire();
          if (failure === "aggregate retirement") {
            f.accounts.retireCredentials();
          }
          if (failure === "equal-file replacement") {
            Deno.writeTextFileSync(`${f.root}/replacement`, before);
            Deno.renameSync(`${f.root}/replacement`, `${f.root}/accounts.json`);
          }
          release.resolve(fixturePasswordHash("new password"));
          await assertRejects(() => pending);
          assertEquals(
            Deno.readTextFileSync(`${f.root}/accounts.json`),
            before,
          );
          assertEquals(
            f.accounts.byId(ACCOUNT_A)?.lastTotpStep,
            COMMAND_NOW / 30_000,
          );
        } finally {
          release.resolve(fixturePasswordHash("new password"));
          await pending.catch(() => {});
        }
      }, {
        hash: () => {
          entered.resolve();
          return release.promise;
        },
      }, { key: "key" });
    },
  );
}

Deno.test("credential commands: hashing failure spends current proof but retains an uncommitted candidate for retry", () => {
  let calls = 0;
  return credentialCommandFixture(async (f) => {
    const candidate = await f.accounts.credentials.beginEnrollment(f.authority);
    const request = f.request({
      newPassword: "new password",
      current: { password: "password", code: await f.code() },
      authenticator: {
        kind: "enroll",
        key: candidate.key,
        code: await f.code(candidate.key, "base32"),
      },
    });
    await assertRejects(
      () => f.accounts.credentials.changeOwn(f.authority, request),
      Error,
      "fixture hash failure",
    );
    const spent = await f.code();
    await assertRejects(
      () => f.accounts.credentials.authenticate("alice", "password", spent),
      AuthenticationError,
    );
    await f.accounts.credentials.changeOwn(f.authority, {
      ...request,
      current: {
        password: "password",
        code: await f.code("key", undefined, 1),
      },
    });
    assertEquals(f.accounts.byId(ACCOUNT_A)?.totpKey, candidate.key);
    await signIn(f.sessions, {
      username: "alice",
      password: "new password",
      totp: await f.code(candidate.key, "base32", 1),
    });
  }, {
    hash: (password) => {
      if (++calls === 1) {
        return Promise.reject(new Error("fixture hash failure"));
      }
      return Promise.resolve(fixturePasswordHash(password));
    },
  }, { key: "key" });
});

Deno.test("credential commands: unpublished credential write retains consumed code and retryable candidate", () =>
  credentialCommandFixture(
    async (f) => {
      const candidate = await f.accounts.credentials.beginEnrollment(
        f.authority,
      );
      const request = f.request({
        current: { password: "password", code: await f.code() },
        authenticator: {
          kind: "enroll",
          key: candidate.key,
          code: await f.code(candidate.key, "base32"),
        },
      });
      const rename = Deno.renameSync;
      let publications = 0;
      Deno.renameSync = (from, to) => {
        if (
          String(to) === `${f.root}/accounts.json` && ++publications === 2
        ) {
          throw new Deno.errors.PermissionDenied(
            "fixture credential publication",
          );
        }
        rename(from, to);
      };
      try {
        await assertRejects(() =>
          f.accounts.credentials.changeOwn(f.authority, request)
        );
      } finally {
        Deno.renameSync = rename;
      }
      const saved = new AccountRepository(f.root).byId(ACCOUNT_A)!;
      assertEquals(saved.credentialRevision, 0);
      assertEquals(saved.lastTotpStep, COMMAND_NOW / 30_000);
      assertEquals(saved.totpKey, "key");
      await assertRejects(
        () => f.accounts.credentials.changeOwn(f.authority, request),
        AuthenticationError,
      );
      await f.accounts.credentials.changeOwn(f.authority, {
        ...request,
        current: {
          password: "password",
          code: await f.code("key", undefined, 1),
        },
      });
      assertEquals(f.accounts.byId(ACCOUNT_A)?.totpKey, candidate.key);
    },
    {},
    { key: "key" },
  ));

fixtureTest(
  "credential commands: candidate admitted before hashing is not rechecked against a later clock",
  (scope) => {
    const entered = fixtureGate(scope),
      release = fixtureGate<string>(scope);
    return credentialCommandFixture(async (f) => {
      const candidate = await f.accounts.credentials.beginEnrollment(
        f.authority,
      );
      const pending = f.accounts.credentials.changeOwn(
        f.authority,
        f.request({
          newPassword: "new password",
          authenticator: {
            kind: "enroll",
            key: candidate.key,
            code: await f.code(candidate.key, "base32"),
          },
        }),
      );
      pending.catch(() => {});
      try {
        await workMilestone(pending, entered.promise, "password hash entered");
        f.now += 300_000;
        release.resolve(fixturePasswordHash("new password"));
        await pending;
        assertEquals(
          f.accounts.byId(ACCOUNT_A)?.lastTotpStep,
          COMMAND_NOW / 30_000,
        );
      } finally {
        release.resolve(fixturePasswordHash("new password"));
        await pending.catch(() => {});
      }
      await signIn(f.sessions, {
        username: "alice",
        password: "new password",
        totp: await f.code(candidate.key, "base32"),
      });
    }, {
      hash: () => {
        entered.resolve();
        return release.promise;
      },
    });
  },
);

fixtureTest(
  "credential commands: borrowed request mutation cannot retarget or replace prepared input",
  (scope) => {
    const entered = fixtureGate(scope),
      release = fixtureGate<string>(scope);
    return credentialCommandFixture(async (f) => {
      const candidate = await f.accounts.credentials.beginEnrollment(
        f.authority,
      );
      const request = {
        ...f.request({ newPassword: "new password" }),
        authenticator: {
          kind: "enroll" as const,
          key: candidate.key,
          code: await f.code(candidate.key, "base32"),
        },
      };
      const pending = f.accounts.credentials.changeOwn(f.authority, request);
      pending.catch(() => {});
      try {
        await workMilestone(pending, entered.promise, "password hash entered");
        request.authenticator.key = "A".repeat(32);
        request.authenticator.code = "000000";
        request.current = { password: "wrong" };
        request.updateId = NEXT_UPDATE;
        request.newPassword = "different password";
        release.resolve(fixturePasswordHash("new password"));
        const result = await pending;
        assertEquals(result.credentialUpdateId, UPDATE);
        assertEquals(f.accounts.byId(ACCOUNT_A)?.totpKey, candidate.key);
      } finally {
        release.resolve(fixturePasswordHash("new password"));
        await pending.catch(() => {});
      }
    }, {
      hash: () => {
        entered.resolve();
        return release.promise;
      },
    });
  },
);

Deno.test("credential commands: a durability warning retains the committed receipt and a newer callback-issued generation", () =>
  credentialCommandFixture(async (f) => {
    const candidate = await f.accounts.credentials.beginEnrollment(f.authority);
    const open = Deno.openSync,
      rename = Deno.renameSync,
      warning = logger.warning;
    let deny = false, observed = false;
    let observedRevision: number | undefined;
    let next:
      | ReturnType<typeof f.accounts.credentials.beginEnrollment>
      | undefined;
    Deno.renameSync = (from, to) => {
      rename(from, to);
      if (String(to) === `${f.root}/accounts.json`) deny = true;
    };
    Deno.openSync = ((file, options) => {
      const handle = open(file, options);
      if (String(file) === f.root) {
        handle.syncSync = () => {
          if (deny) throw new Error("fixture directory confirmation");
        };
      }
      return handle;
    }) as typeof open;
    logger.warning = () => {
      deny = false;
      if (!observed) {
        observed = true;
        observedRevision = f.accounts.identityById(ACCOUNT_A)
          ?.credentialRevision;
        next = f.accounts.credentials.beginEnrollment(f.bound());
      }
    };
    let result;
    try {
      result = await f.accounts.credentials.changeOwn(
        f.authority,
        f.request({
          authenticator: {
            kind: "enroll",
            key: candidate.key,
            code: await f.code(candidate.key, "base32"),
          },
        }),
      );
    } finally {
      Deno.openSync = open;
      Deno.renameSync = rename;
      logger.warning = warning;
    }
    assert(observed);
    assertEquals(observedRevision, 1);
    assert(next);
    assertEquals(result.credentialRevision, 1);
    const replacement = await next;
    await f.accounts.credentials.changeOwn(
      f.bound(),
      f.request({
        credentialRevision: 1,
        updateId: NEXT_UPDATE,
        current: {
          password: "password",
          code: await f.code(candidate.key, "base32", 1),
        },
        authenticator: {
          kind: "enroll",
          key: replacement.key,
          code: await f.code(replacement.key, "base32"),
        },
      }),
    );
    assertEquals(f.accounts.byId(ACCOUNT_A)?.totpKey, replacement.key);
  }));

fixtureTest(
  "credential commands: code progress during password verification rejects without spending a second step",
  (scope) => {
    const entered = fixtureGate(scope),
      release = fixtureGate<boolean>(scope);
    let calls = 0;
    return credentialCommandFixture(async (f) => {
      const fresh = await f.code("key", undefined, 1);
      const pending = f.accounts.credentials.changeOwn(
        f.authority,
        f.request({
          current: { password: "password", code: fresh },
          newPassword: "new password",
        }),
      );
      pending.catch(() => {});
      try {
        await workMilestone(
          pending,
          entered.promise,
          "current password verifier entered",
        );
        await signIn(f.sessions, {
          username: "alice",
          password: "password",
          totp: await f.code(),
        });
        const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
        release.resolve(true);
        await assertRejects(() => pending, AuthenticationError);
        assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
        assertEquals(
          f.accounts.byId(ACCOUNT_A)?.lastTotpStep,
          COMMAND_NOW / 30_000,
        );
        await f.accounts.credentials.authenticate("alice", "password", fresh);
      } finally {
        release.resolve(true);
        await pending.catch(() => {});
      }
    }, {
      verify: (password, hash) => {
        if (++calls === 1) {
          entered.resolve();
          return release.promise;
        }
        return verifyPassword(password, hash);
      },
    }, { key: "key" });
  },
);

fixtureTest(
  "credential commands: independent other-account progress does not cancel a held change",
  (scope) => {
    const entered = fixtureGate(scope),
      release = fixtureGate<string>(scope);
    return credentialCommandFixture(async (f) => {
      f.accounts.importAccount(
        identityAccount({
          id: ACCOUNT_B,
          login: "bob",
          passwordHash: fixturePasswordHash("password"),
          totpKey: "key",
        }),
      );
      const pending = f.accounts.credentials.changeOwn(
        f.authority,
        f.request({
          current: { password: "password", code: await f.code() },
          newPassword: "new password",
        }),
      );
      pending.catch(() => {});
      try {
        await workMilestone(pending, entered.promise, "password hash entered");
        const other = await signIn(f.sessions, {
          username: "bob",
          password: "password",
          totp: await f.code(),
        });
        release.resolve(fixturePasswordHash("new password"));
        await pending;
        await f.sessions.validateToken(other.access_token);
        await signIn(f.sessions, {
          username: "alice",
          password: "new password",
          totp: await f.code("key", undefined, 1),
        });
      } finally {
        release.resolve(fixturePasswordHash("new password"));
        await pending.catch(() => {});
      }
    }, {
      hash: () => {
        entered.resolve();
        return release.promise;
      },
    }, { key: "key" });
  },
);

fixtureTest(
  "credential commands: a real concurrent credential publication beats first enrollment held in hashing",
  (scope) => {
    const entered = fixtureGate(scope),
      release = fixtureGate<string>(scope);
    let calls = 0;
    return credentialCommandFixture(async (f) => {
      const candidate = await f.accounts.credentials.beginEnrollment(
        f.authority,
      );
      const pending = f.accounts.credentials.changeOwn(
        f.authority,
        f.request({
          newPassword: "new password",
          authenticator: {
            kind: "enroll",
            key: candidate.key,
            code: await f.code(candidate.key, "base32"),
          },
        }),
      );
      pending.catch(() => {});
      try {
        await workMilestone(
          pending,
          entered.promise,
          "first password hash entered",
        );
        const winner = await f.accounts.credentials.changeOwn(
          f.authority,
          f.request({ newPassword: "winner password", updateId: NEXT_UPDATE }),
        );
        release.resolve(fixturePasswordHash("new password"));
        await assertRejects(() => pending);
        assertEquals(f.accounts.identityById(ACCOUNT_A), winner);
        assertEquals(f.accounts.byId(ACCOUNT_A)?.totpKey, null);
        await signIn(f.sessions, {
          username: "alice",
          password: "winner password",
        });
      } finally {
        release.resolve(fixturePasswordHash("new password"));
        await pending.catch(() => {});
      }
    }, {
      hash: (password) => {
        if (++calls === 1) {
          entered.resolve();
          return release.promise;
        }
        return Promise.resolve(fixturePasswordHash(password));
      },
    });
  },
);

Deno.test("credential commands: updated credentials reach the actual prepared note disclosure consumer", () =>
  credentialCommandFixture(async (f) => {
    const candidate = await f.accounts.credentials.beginEnrollment(f.authority);
    const request = f.request({
      newPassword: "new password",
      authenticator: {
        kind: "enroll" as const,
        key: candidate.key,
        code: await f.code(candidate.key, "base32"),
      },
    });
    await f.accounts.credentials.changeOwn(f.authority, request);
    await assertRejects(() =>
      f.accounts.credentials.changeOwn(f.authority, request)
    );
    const issued = await signIn(f.sessions, {
      username: "alice",
      password: "new password",
      totp: await f.code(candidate.key, "base32", 1),
    });
    const principal = await f.sessions.validateToken(issued.access_token);
    const acl = new AclRepository(`${f.root}/vault-state`, VAULT_A, {
      accounts: f.accounts,
      declaredAdmin: "alice",
    });
    acl.prepareParents();
    const vault = {
      identity: {},
      id: VAULT_A,
      acl,
      lifecycle: { epoch: 0, operational: () => true },
    };
    const lifetime = createOperationLease("live", [() => undefined]);
    try {
      const authority = new InstanceAuthority(
        f.sessions,
        () => vault,
        lifetime.lease,
      );
      const lease = authority.lease(principal, "readVault");
      Deno.writeTextFileSync(
        `${f.root}/Note.md`,
        "Exact note bytes after credential change.\n",
      );
      const prepared = await lease.read(() =>
        Deno.readTextFile(`${f.root}/Note.md`)
      );
      const reader = lease.disclose(prepared).getReader();
      try {
        assertEquals(await reader.read(), {
          done: false,
          value: "Exact note bytes after credential change.\n",
        });
        assertEquals(await reader.read(), { done: true, value: undefined });
      } finally {
        reader.releaseLock();
      }
    } finally {
      lifetime.retire();
    }
  }));

for (const boundary of ["domain retirement", "abort"] as const) {
  Deno.test(`credential commands: ${boundary} at the prepared write boundary prevents the actual credential effect`, () =>
    credentialCommandFixture(async (f) => {
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`),
        write = Deno.writeTextFileSync;
      const abort = new AbortController();
      let staged = false;
      Deno.writeTextFileSync = (file, data, options) => {
        write(file, data, options);
        if (String(file).startsWith(`${f.root}/.config-`)) {
          staged = true;
          if (boundary === "abort") abort.abort();
          else f.retire();
        }
      };
      try {
        await assertRejects(() =>
          f.accounts.credentials.changeOwn(
            f.authority,
            f.request({ newPassword: "new password" }),
            abort.signal,
          )
        );
      } finally {
        Deno.writeTextFileSync = write;
      }
      assert(staged);
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
      assertEquals(f.accounts.byId(ACCOUNT_A)?.credentialRevision, 0);
    }));
}

Deno.test("credential commands: an unissued echoed key rejects before spending the current code", () =>
  credentialCommandFixture(
    async (f) => {
      const candidate = await f.accounts.credentials.beginEnrollment(
        f.authority,
      );
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
      const wrongKey = candidate.key === "A".repeat(32)
        ? "B".repeat(32)
        : "A".repeat(32);
      await assertRejects(async () =>
        f.accounts.credentials.changeOwn(
          f.authority,
          f.request({
            current: { password: "password", code: await f.code() },
            authenticator: {
              kind: "enroll",
              key: wrongKey,
              code: await f.code(candidate.key, "base32"),
            },
          }),
        ), IdentityStateError);
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
      await f.accounts.credentials.authenticate(
        "alice",
        "password",
        await f.code(),
      );
    },
    {},
    { key: "key" },
  ));
