// SPDX-License-Identifier: LGPL-3.0-only
import {
  issueSession,
  receiveSession,
  signIn,
} from "./helpers/session_delivery.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { fixtureGate, fixtureTest } from "./helpers/fixture_coordination.ts";
import type { FixtureScope } from "./helpers/fixture_scope.ts";
import { SignJWT } from "jose";
import { AccountRepository } from "../server/auth/accounts.ts";
import type { AccountIdentity } from "../server/auth/accounts.ts";
import {
  importFixtureAccount,
  recoveryForRoot,
} from "./helpers/account_preparation.ts";
import { storedLogin, storedState } from "./helpers/identity.ts";
import type {
  CredentialOptions,
  LoginClaim,
  LoginProof,
} from "../server/auth/account_credentials.ts";
import {
  AuthenticationError,
  InstanceSessions,
  SessionRepository,
} from "../server/auth/sessions.ts";
import {
  decodeStoredTotpSecret,
  totpSecretFromRawKey,
} from "../server/auth/credentials.ts";
import { AclRepository } from "../server/auth/acl.ts";
import { InstanceAuthority } from "../server/auth/authority.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import { OwnershipError } from "../shared/ownership.js";
import { logger } from "../server/logger.ts";
import { fixturePasswordHash } from "./helpers/config.ts";
import {
  ACCOUNT_B,
  identityAccount,
  identityFixture,
  UPDATE,
  VAULT_A,
} from "./helpers/identity.ts";
import { authenticatorCode } from "./helpers/totp.ts";
import { workMilestone } from "./helpers/product_settlement.ts";

const NOW = 1_800_000_000_000;

Deno.test("sign-in delivery: byte payload then getter is not a pending inspection result", () =>
  proofFixture(async (_accounts, sessions) => {
    const encode = TextEncoder.prototype.encode;
    let injected: Uint8Array | undefined, thenReads = 0;
    TextEncoder.prototype.encode = function (input) {
      const bytes = encode.call(this, input);
      if (input?.startsWith('{"access_token":')) {
        Object.defineProperty(bytes, "then", {
          get() {
            thenReads++;
            return () => {};
          },
        });
        injected = bytes;
      }
      return bytes;
    };
    try {
      const issued = await sessions.login({
        username: "alice",
        password: "password",
        totp: await codeAt(),
      });
      assert(injected);
      const reader = issued.body.getReader();
      try {
        const first = await reader.read();
        assertEquals(first.done, false);
        assertStrictEquals(first.value, injected);
        const result = JSON.parse(new TextDecoder().decode(first.value));
        assertEquals(result.principal, issued.principal);
        assertEquals(result.token_type, "bearer");
        assertEquals(
          (await sessions.validateToken(result.access_token)).accountId,
          issued.principal.accountId,
        );
        assertEquals(await reader.read(), { done: true, value: undefined });
        assertEquals(thenReads, 0);
      } finally {
        reader.releaseLock();
      }
    } finally {
      TextEncoder.prototype.encode = encode;
    }
  }));

for (
  const boundary of [
    "aggregate retirement",
    "abort",
    "retiring validator",
  ] as const
) {
  Deno.test(`sign-in delivery: ${boundary} after signing cannot disclose queued credentials`, () =>
    proofFixture(async (accounts, sessions) => {
      const abort = new AbortController();
      const issued = await sessions.login({
        username: "alice",
        password: "password",
        totp: await codeAt(),
      }, abort.signal);
      assertEquals(Object.keys(issued), ["principal", "body"]);
      assertEquals(Reflect.get(issued, "access_token"), undefined);
      const response = new Response(issued.body);
      if (boundary === "aggregate retirement") accounts.retireCredentials();
      if (boundary === "abort") abort.abort();
      if (boundary === "retiring validator") {
        const current = sessions.assertCurrent.bind(sessions);
        sessions.assertCurrent = (principal) => {
          current(principal);
          accounts.retireCredentials();
        };
      }
      await assertRejects(
        () => response.text(),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    }));
}

Deno.test("sign-in delivery: cancellation closes the claimed proof without releasing token bytes", () =>
  identityFixture(async (root, scope) => {
    const claims: LoginClaim[] = [];
    class ObservedAccounts extends AccountRepository {
      override get credentials() {
        const commands = super.credentials;
        return Object.freeze({
          ...commands,
          beginLogin(proof: LoginProof) {
            const claim = commands.beginLogin(proof);
            claims.push(claim);
            return claim;
          },
        });
      }
    }
    const accounts = new ObservedAccounts(root, undefined, { now: () => NOW });
    scope.onCancel(() => accounts.retireCredentials());
    importFixtureAccount(
      accounts,
      identityAccount({
        passwordHash: fixturePasswordHash("password"),
        totpKey: "key",
      }),
    );
    const signing = new SessionRepository(root);
    signing.initialize();
    const sessions = new InstanceSessions(accounts, signing, {
      expirySeconds: 1000,
    }, { now: () => NOW });
    const proof = await accounts.credentials.authenticate(
      "alice",
      "password",
      await codeAt(),
    );
    const issued = await sessions.issue(proof);
    assertEquals(claims.length, 1);
    const [claim] = claims;
    claim.lease.assertCurrent();
    await issued.body.cancel();
    assertThrows(
      () => claim.lease.assertCurrent(),
      OwnershipError,
      "Owner is retired",
    );
    await assertRejects(
      () => sessions.issue(proof),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
  }));

for (const mutation of ["same account", "abort", "other account"] as const) {
  Deno.test(`sign-in delivery: final clock callback ${mutation} is checked before enqueue`, () =>
    proofFixture(async (accounts, sessions, root) => {
      const abort = new AbortController();
      importFixtureAccount(
        accounts,
        identityAccount({
          id: ACCOUNT_B,
          login: "bob",
          passwordHash: fixturePasswordHash("password"),
          totpKey: "key",
        }),
      );
      const events: string[] = [];
      let delivering = false, checks = 0;
      // The raw code counter is gone; the synchronous credential change is the
      // offline disable command, whose commit completes inside this callback.
      let change: Promise<AccountIdentity> | undefined;
      const recovery = recoveryForRoot(root);
      const owner = new InstanceSessions(accounts, sessions.signing, {
        expirySeconds: 1000,
      }, {
        now: () => {
          if (delivering) {
            // The sink's construction check precedes its actual delivery check.
            events.push(++checks === 1 ? "binder clock" : "delivery clock");
            if (checks === 2) {
              delivering = false;
              if (mutation === "abort") {
                abort.abort();
                events.push("aborted");
              } else {
                const login = mutation === "same account" ? "alice" : "bob";
                const account = accounts.byLogin(login)!;
                change = accounts.credentials.disableAuthenticator(
                  recovery.authority,
                  {
                    accountId: account.id,
                    credentialRevision: account.credentialRevision,
                    updateId: UPDATE,
                  },
                );
                change.catch(() => {});
                events.push(
                  `${
                    storedLogin(accounts, login).totpKey === null
                      ? "changed"
                      : "unchanged"
                  } ${login}`,
                );
              }
            }
          }
          return NOW;
        },
      });
      try {
        const issued = await owner.login({
          username: "alice",
          password: "password",
          totp: await codeAt(),
        }, abort.signal);
        delivering = true;
        if (mutation === "other account") {
          const result = await receiveSession(issued);
          assertEquals(
            (await owner.validateToken(result.access_token)).accountId,
            issued.principal.accountId,
          );
        } else {
          await assertRejects(
            () => new Response(issued.body).text(),
            AuthenticationError,
            "Invalid authentication credentials.",
          );
        }
        assertEquals(events, [
          "binder clock",
          "delivery clock",
          mutation === "abort"
            ? "aborted"
            : `changed ${mutation === "same account" ? "alice" : "bob"}`,
        ]);
        if (mutation !== "abort") {
          const changed = await change!;
          assertEquals(
            [changed.login, changed.credentialRevision, changed.totpEnabled],
            [mutation === "same account" ? "alice" : "bob", 1, false],
          );
        }
        assertEquals([
          storedLogin(accounts, "alice").lastTotpStep,
          storedLogin(accounts, "bob").lastTotpStep,
        ], [
          mutation === "same account" ? null : NOW / 30_000,
          null,
        ]);
      } finally {
        recovery.close();
        await change?.catch(() => {});
      }
    }));
}

Deno.test("sign-in proof: storage validation retirement cannot spend the code after its parent check", () =>
  proofFixture(async (accounts, sessions, root) => {
    const before = Deno.readTextFileSync(`${root}/accounts.json`),
      read = Deno.readTextFileSync,
      code = await codeAt();
    let staged = false;
    Deno.readTextFileSync = (file) => {
      const value = read(file);
      if (String(file).startsWith(`${root}/.config-`)) {
        staged = true;
        accounts.retireCredentials();
      }
      return value;
    };
    try {
      await assertRejects(
        () =>
          sessions.login({
            username: "alice",
            password: "password",
            totp: code,
          }),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    } finally {
      Deno.readTextFileSync = read;
    }
    assertEquals(staged, true);
    assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), before);
  }));

Deno.test("sign-in delivery: clock callback runs before current credential comparison", () =>
  proofFixture(async (accounts, sessions, root) => {
    let armed = false, changes = 0;
    let mutation: Promise<unknown> | undefined;
    const recovery = recoveryForRoot(root);
    const owner = new InstanceSessions(accounts, sessions.signing, {
      expirySeconds: 1000,
    }, {
      now: () => {
        if (armed) {
          armed = false;
          changes++;
          mutation = accounts.credentials.disableAuthenticator(
            recovery.authority,
            {
              accountId: accounts.byLogin("alice")!.id,
              credentialRevision: 0,
              updateId: UPDATE,
            },
          );
          mutation.catch(() => {});
        }
        return NOW;
      },
    });
    try {
      const issued = await owner.login({
        username: "alice",
        password: "password",
        totp: await codeAt(),
      });
      armed = true;
      await assertRejects(
        () => new Response(issued.body).text(),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
      assertEquals(changes, 1);
      assert(mutation);
      await mutation;
    } finally {
      recovery.close();
    }
  }));
Deno.test("sign-in proof: later code progress fences a held session signature", () =>
  identityFixture(async (root, scope) => {
    const accounts = new AccountRepository(root, undefined, { now: () => NOW });
    importFixtureAccount(
      accounts,
      identityAccount({
        passwordHash: fixturePasswordHash("password"),
        totpKey: "key",
      }),
    );
    const signing = new SessionRepository(root);
    signing.initialize();
    const sessions = new InstanceSessions(accounts, signing, {
      expirySeconds: 1000,
    }, { now: () => NOW });
    const secret = totpSecretFromRawKey("key");
    const firstCode = await authenticatorCode(secret, NOW);
    const nextCode = await authenticatorCode(secret, NOW + 30_000);
    const entered = fixtureGate(scope),
      release = fixtureGate(scope);
    const sign = SignJWT.prototype.sign;
    let calls = 0;
    SignJWT.prototype.sign = async function (...args) {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return await sign.apply(this, args);
    };
    const pending = signIn(sessions, {
      username: "alice",
      password: "password",
      totp: firstCode,
    });
    pending.catch(() => {});
    try {
      await workMilestone(
        pending,
        entered.promise,
        "first session signature entered",
      );
      const issued = await signIn(sessions, {
        username: "alice",
        password: "password",
        totp: nextCode,
      });
      release.resolve();
      await assertRejects(() => pending, AuthenticationError);
      assertEquals(
        (await sessions.validateToken(issued.access_token)).accountId,
        issued.principal.accountId,
      );
    } finally {
      release.resolve();
      await pending.catch(() => {});
      SignJWT.prototype.sign = sign;
    }
  }));

async function proofFixture(
  run: (
    accounts: AccountRepository,
    sessions: InstanceSessions,
    root: string,
    scope: FixtureScope,
  ) => Promise<void>,
  options: CredentialOptions = {},
  key: string | null = "key",
) {
  await identityFixture(async (root, scope) => {
    const accounts = new AccountRepository(root, undefined, {
      now: () => NOW,
      ...options,
    });
    scope.onCancel(() => accounts.retireCredentials());
    importFixtureAccount(
      accounts,
      identityAccount({
        passwordHash: fixturePasswordHash("password"),
        totpKey: key,
      }),
    );
    const signing = new SessionRepository(root);
    signing.initialize();
    await run(
      accounts,
      new InstanceSessions(accounts, signing, { expirySeconds: 1000 }, {
        now: () => NOW,
      }),
      root,
      scope,
    );
  });
}
const codeAt = (offset = 0) =>
  authenticatorCode(totpSecretFromRawKey("key"), NOW + offset * 30_000);

Deno.test("sign-in proof: a warning handler cannot replace the account confirmed by sign-in", () =>
  proofFixture(async (accounts, sessions, root) => {
    const open = Deno.openSync,
      warning = logger.warning,
      rename = Deno.renameSync;
    const recovery = recoveryForRoot(root);
    let replacement: Promise<unknown> | undefined;
    let deny = false, changed = false;
    Deno.renameSync = (from, to) => {
      rename(from, to);
      if (String(to) === `${root}/accounts.json`) deny = true;
    };
    Deno.openSync = ((file, options) => {
      const handle = open(file, options);
      if (String(file) === root) {
        handle.syncSync = () => {
          if (deny) throw new Error("fixture directory confirmation failure");
        };
      }
      return handle;
    }) as typeof open;
    logger.warning = () => {
      deny = false;
      if (!changed) {
        changed = true;
        replacement = accounts.credentials.disableAuthenticator(
          recovery.authority,
          {
            accountId: accounts.byLogin("alice")!.id,
            credentialRevision: 0,
            updateId: UPDATE,
          },
        );
        replacement.catch(() => {});
      }
    };
    try {
      await assertRejects(
        async () =>
          signIn(sessions, {
            username: "alice",
            password: "password",
            totp: await codeAt(),
          }),
        AuthenticationError,
      );
      assert(changed);
      await replacement;
      assertEquals(accounts.byLogin("alice")?.credentialRevision, 1);
      assertEquals(storedLogin(accounts, "alice").lastTotpStep, null);
    } finally {
      Deno.openSync = open;
      logger.warning = warning;
      Deno.renameSync = rename;
      recovery.close();
    }
  }));

Deno.test("sign-in proof: forged, cloned, foreign, other-purpose and raw account values cannot issue a session", () =>
  proofFixture(async (accounts, sessions, root) => {
    const proof = await accounts.credentials.authenticate(
      "alice",
      "password",
      await codeAt(),
    );
    const foreign = new AccountRepository(`${root}/foreign`, undefined, {
      now: () => NOW,
    });
    importFixtureAccount(
      foreign,
      identityAccount({ passwordHash: fixturePasswordHash("password") }),
    );
    const foreignProof = await foreign.credentials.authenticate(
      "alice",
      "password",
    );
    for (
      const value of [
        {},
        { ...proof },
        structuredClone(proof),
        foreignProof,
        decodeStoredTotpSecret("key"),
        accounts.byLogin("alice"),
        null,
      ]
    ) {
      await assertRejects(
        () => issueSession(sessions, value as LoginProof),
        AuthenticationError,
      );
    }
    const result = await issueSession(sessions, proof);
    assertEquals(
      (await sessions.validateToken(result.access_token)).accountId,
      result.principal.accountId,
    );
    await assertRejects(
      () => issueSession(sessions, proof),
      AuthenticationError,
    );
    const typeContract = (account: AccountIdentity) => {
      // @ts-expect-error Account data is not evidence of sign-in.
      issueSession(sessions, account);
      // @ts-expect-error A matched step is not accepted by the command.
      accounts.credentials.authenticate("alice", "password", 123456);
    };
    void typeContract;
  }));

Deno.test("sign-in proof: one concurrent claimant wins and the proof exposes no credential fields", () =>
  proofFixture(async (accounts, sessions) => {
    const proof = await accounts.credentials.authenticate(
      "alice",
      "password",
      await codeAt(),
    );
    assert(Object.isFrozen(proof));
    assertEquals(Object.keys(proof), []);
    assertEquals(JSON.stringify(proof), "{}");
    const sign = SignJWT.prototype.sign;
    let signingCalls = 0;
    SignJWT.prototype.sign = function (...args) {
      signingCalls++;
      return sign.apply(this, args);
    };
    let results;
    try {
      results = await Promise.allSettled([
        issueSession(sessions, proof),
        issueSession(sessions, proof),
      ]);
    } finally {
      SignJWT.prototype.sign = sign;
    }
    assertEquals(signingCalls, 1);
    assertEquals(results.map((result) => result.status), [
      "fulfilled",
      "rejected",
    ]);
    const [winner, loser] = results;
    assert(winner.status === "fulfilled");
    assert(loser.status === "rejected");
    assert(loser.reason instanceof AuthenticationError);
    assertEquals(loser.reason.message, "Invalid authentication credentials.");
    await sessions.validateToken(winner.value.access_token);
  }));

Deno.test("sign-in proof: claims are owner-bound, immutable, redacted and finalize once", () =>
  proofFixture(async (accounts, sessions) => {
    const proof = await accounts.credentials.authenticate(
      "alice",
      "password",
      await codeAt(),
    );
    const claim = accounts.credentials.beginLogin(proof);
    assert(Object.isFrozen(claim));
    assert(Object.isFrozen(claim.identity));
    assertEquals(Object.keys(claim.identity).sort(), [
      "credentialRevision",
      "credentialUpdateId",
      "id",
      "login",
      "passwordChangeRequired",
      "totpEnabled",
    ]);
    assertThrows(
      () => Object.assign(claim.identity, { id: ACCOUNT_B }),
      TypeError,
    );
    for (
      const value of [{}, { ...claim }, structuredClone(claim.identity), proof]
    ) {
      assertThrows(
        () => accounts.credentials.finishLogin(value as LoginClaim),
        AuthenticationError,
      );
    }
    await assertRejects(
      () => issueSession(sessions, proof),
      AuthenticationError,
    );
    assertStrictEquals(accounts.credentials.finishLogin(claim), claim.identity);
    assertThrows(
      () => accounts.credentials.finishLogin(claim),
      AuthenticationError,
    );
    accounts.credentials.closeLogin(claim);
  }));

Deno.test("sign-in proof: invalid code or supplied step cannot consume a current code", () =>
  proofFixture(async (accounts, sessions) => {
    for (const value of [undefined, "bad", "12345", 123456]) {
      await assertRejects(
        () =>
          accounts.credentials.authenticate(
            "alice",
            "password",
            value as string,
          ),
        AuthenticationError,
      );
    }
    await assertRejects(
      async () =>
        accounts.credentials.authenticate("alice", "wrong", await codeAt()),
      AuthenticationError,
    );
    await assertRejects(
      async () =>
        accounts.credentials.authenticate(
          "alice",
          "password",
          await codeAt(),
          100 as unknown as AbortSignal,
        ),
      AuthenticationError,
    );
    assertEquals(storedLogin(accounts, "alice").lastTotpStep, null);
    await signIn(sessions, {
      username: "alice",
      password: "password",
      totp: await codeAt(),
    });
    assertEquals(storedLogin(accounts, "alice").lastTotpStep, NOW / 30_000);
  }));

for (
  const boundary of [
    "credential change",
    "abort",
    "owner retirement",
    "account file replacement",
    "signing file replacement",
  ] as const
) {
  Deno.test(`sign-in proof: ${boundary} while signing prevents the returned session`, () =>
    proofFixture(async (accounts, sessions, root, scope) => {
      const entered = fixtureGate(scope),
        release = fixtureGate(scope);
      const sign = SignJWT.prototype.sign;
      const abort = new AbortController(), code = await codeAt();
      let pending: ReturnType<typeof sessions.login> | undefined;
      try {
        SignJWT.prototype.sign = async function (...args) {
          entered.resolve();
          await release.promise;
          return await sign.apply(this, args);
        };
        pending = sessions.login({
          username: "alice",
          password: "password",
          totp: code,
        }, abort.signal);
        pending.catch(() => {});
        await workMilestone(
          pending,
          entered.promise,
          "session signature entered",
        );
        if (boundary === "credential change") {
          const recovery = recoveryForRoot(root);
          try {
            await accounts.credentials.disableAuthenticator(
              recovery.authority,
              {
                accountId: accounts.byLogin("alice")!.id,
                credentialRevision: 0,
                updateId: UPDATE,
              },
            );
          } finally {
            recovery.close();
          }
        }
        if (boundary === "abort") abort.abort();
        if (boundary === "owner retirement") accounts.retireCredentials();
        if (boundary === "account file replacement") {
          Deno.writeTextFileSync(
            `${root}/accounts.json`,
            JSON.stringify({ ...storedState(accounts), revision: 999 }),
          );
        }
        if (boundary === "signing file replacement") {
          Deno.writeTextFileSync(
            `${root}/sessions.json`,
            JSON.stringify({
              ...sessions.signing.capture().value,
              signingRevision: 999,
            }),
          );
        }
        release.resolve();
        await assertRejects(
          () => pending!,
          AuthenticationError,
          "Invalid authentication credentials.",
        );
        assertEquals(
          storedLogin(accounts, "alice").lastTotpStep,
          boundary === "credential change" ? null : NOW / 30_000,
        );
      } finally {
        SignJWT.prototype.sign = sign;
        release.resolve();
        await pending?.catch(() => {});
      }
    }));
}

Deno.test("sign-in proof: another account's code progress does not cancel this account's held signature", () =>
  proofFixture(async (accounts, sessions, _root, scope) => {
    importFixtureAccount(
      accounts,
      identityAccount({
        id: ACCOUNT_B,
        login: "bob",
        passwordHash: fixturePasswordHash("password"),
        totpKey: "key",
      }),
    );
    const entered = fixtureGate(scope),
      release = fixtureGate(scope);
    const sign = SignJWT.prototype.sign;
    let count = 0;
    const code = await codeAt();
    let pending: ReturnType<typeof signIn> | undefined;
    try {
      SignJWT.prototype.sign = async function (...args) {
        if (++count === 1) {
          entered.resolve();
          await release.promise;
        }
        return await sign.apply(this, args);
      };
      pending = signIn(sessions, {
        username: "alice",
        password: "password",
        totp: code,
      });
      pending.catch(() => {});
      await workMilestone(pending, entered.promise, "first signature entered");
      const other = await signIn(sessions, {
        username: "bob",
        password: "password",
        totp: await codeAt(),
      });
      release.resolve();
      const first = await pending;
      await sessions.validateToken(first.access_token);
      await sessions.validateToken(other.access_token);
    } finally {
      SignJWT.prototype.sign = sign;
      release.resolve();
      await pending?.catch(() => {});
    }
  }));

Deno.test("sign-in proof: failed signing spends the code and retires the proof without revoking an issued session", () =>
  proofFixture(async (accounts, sessions) => {
    const issued = await signIn(sessions, {
      username: "alice",
      password: "password",
      totp: await codeAt(-1),
    });
    const proof = await accounts.credentials.authenticate(
      "alice",
      "password",
      await codeAt(),
    );
    const sign = SignJWT.prototype.sign;
    SignJWT.prototype.sign = () =>
      Promise.reject(new Error("fixture signing failure"));
    try {
      await assertRejects(
        () => issueSession(sessions, proof),
        AuthenticationError,
      );
    } finally {
      SignJWT.prototype.sign = sign;
    }
    await assertRejects(
      () => issueSession(sessions, proof),
      AuthenticationError,
    );
    await assertRejects(
      async () =>
        signIn(sessions, {
          username: "alice",
          password: "password",
          totp: await codeAt(),
        }),
      AuthenticationError,
    );
    await sessions.validateToken(issued.access_token);
    await signIn(sessions, {
      username: "alice",
      password: "password",
      totp: await codeAt(1),
    });
    await sessions.validateToken(issued.access_token);
  }));

Deno.test("sign-in proof: failed code publication returns no proof and does not spend an unpublished code", () =>
  proofFixture(async (accounts, sessions, root) => {
    const before = Deno.readTextFileSync(`${root}/accounts.json`),
      rename = Deno.renameSync;
    Deno.renameSync = (from, to) => {
      if (String(to) === `${root}/accounts.json`) {
        throw new Deno.errors.PermissionDenied("fixture");
      }
      rename(from, to);
    };
    try {
      await assertRejects(
        async () =>
          accounts.credentials.authenticate(
            "alice",
            "password",
            await codeAt(),
          ),
        AuthenticationError,
      );
    } finally {
      Deno.renameSync = rename;
    }
    assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), before);
    assertEquals(storedLogin(accounts, "alice").lastTotpStep, null);
    await signIn(sessions, {
      username: "alice",
      password: "password",
      totp: await codeAt(),
    });
  }));

Deno.test("sign-in proof: password-only proofs and already-issued sessions have no authenticator replay dependency", () =>
  proofFixture(
    async (accounts, sessions) => {
      const a = await accounts.credentials.authenticate("alice", "password");
      const b = await accounts.credentials.authenticate("alice", "password");
      const first = await issueSession(sessions, a);
      const second = await issueSession(sessions, b);
      accounts.retireCredentials();
      await sessions.validateToken(first.access_token);
      await sessions.validateToken(second.access_token);
      await assertRejects(
        () => accounts.credentials.authenticate("alice", "password"),
        AuthenticationError,
      );
    },
    {},
    null,
  ));

Deno.test("sign-in proof: the issued session reaches the prepared vault note consumer", () =>
  proofFixture(async (accounts, sessions, root) => {
    const acl = new AclRepository(`${root}/vault-state`, VAULT_A, {
      accounts,
      declaredAdmin: "alice",
    });
    acl.prepareParents();
    const lifecycle = { epoch: 0, operational: () => true };
    const vault = { identity: {}, id: VAULT_A, acl, lifecycle };
    const lifetime = createOperationLease("live", [() => undefined]);
    try {
      const token = await signIn(sessions, {
        username: "alice",
        password: "password",
        totp: await codeAt(),
      });
      const principal = await sessions.validateToken(token.access_token);
      const authority = new InstanceAuthority(
        sessions,
        () => vault,
        lifetime.lease,
      );
      const lease = authority.lease(principal, "readVault");
      Deno.writeTextFileSync(
        `${root}/Note.md`,
        "Original note bytes after sign-in.\n",
      );
      const prepared = await lease.read(() =>
        Deno.readTextFile(`${root}/Note.md`)
      );
      const reader = lease.disclose(prepared).getReader();
      try {
        assertEquals(await reader.read(), {
          done: false,
          value: "Original note bytes after sign-in.\n",
        });
        assertEquals(await reader.read(), { done: true, value: undefined });
      } finally {
        reader.releaseLock();
      }
    } finally {
      lifetime.retire();
    }
  }));

for (const boundary of ["abort", "owner retirement"] as const) {
  fixtureTest(
    `sign-in proof: ${boundary} during password verification spends no code`,
    (scope) => {
      const entered = fixtureGate(scope),
        release = fixtureGate<boolean>(scope);
      return proofFixture(async (accounts, sessions) => {
        const abort = new AbortController();
        const pending = signIn(sessions, {
          username: "alice",
          password: "password",
          totp: await codeAt(),
        }, abort.signal);
        pending.catch(() => {});
        try {
          await workMilestone(
            pending,
            entered.promise,
            "password verifier entered",
          );
          if (boundary === "abort") abort.abort();
          else accounts.retireCredentials();
          release.resolve(true);
          await assertRejects(() => pending, AuthenticationError);
          assertEquals(storedLogin(accounts, "alice").lastTotpStep, null);
        } finally {
          release.resolve(true);
          await pending.catch(() => {});
        }
      }, {
        verify: () => {
          entered.resolve();
          return release.promise;
        },
      });
    },
  );
}

Deno.test("sign-in proof: admitted code need not remain in its time window before issuance", () => {
  let now = NOW;
  return proofFixture(async (accounts, sessions) => {
    const proof = await accounts.credentials.authenticate(
      "alice",
      "password",
      await codeAt(),
    );
    now += 300_000;
    const result = await issueSession(sessions, proof);
    await sessions.validateToken(result.access_token);
  }, { now: () => now });
});
