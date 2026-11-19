// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { createUuid } from "../shared/uuid.ts";
import { OwnAccount, ownAccountHandlers } from "../server/auth/account.ts";
import { AccountRepository, prepareAccount } from "../server/auth/accounts.ts";
import {
  AuthenticationError,
  GUEST,
  InstanceSessions,
  SessionRepository,
} from "../server/auth/sessions.ts";
import { StoredConfigConflict } from "../server/config/file_store.ts";
import { hashPassword } from "../server/helpers.ts";
import { identityFixture, UPDATE } from "./helpers/identity.ts";
import { authenticatorCode } from "./helpers/totp.ts";
import { SignJWT } from "jose";
import { workMilestone } from "./helpers/product_settlement.ts";

const NOW = 1_800_000_000_000;

Deno.test("TOTP identity: a zero-padded alias cannot reset an authenticator's consumed floor", () =>
  fixture(async (f) => {
    const key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", alias = key + "\0";
    f.accounts.changeCredentials(f.alice.id, 0, { totpKey: key }, createUuid());
    const code = await f.code(key);
    const signed = await f.login("alice", "password", code);
    f.tick();
    const currentTotp = await f.code(key);
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    await assertRejects(() =>
      f.workflow.change(signed.principal, {
        revision: 1,
        updateId: createUuid(),
        currentPassword: "password",
        currentTotp,
        totp: { enabled: true, key: alias, code },
      })
    );
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
  }));

async function replayFixture(f: Awaited<ReturnType<typeof setup>>) {
  const key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  f.accounts.changeCredentials(f.alice.id, 0, { totpKey: key }, createUuid());
  const signed = await f.login("alice", "password", await f.code(key));
  f.tick();
  f.tick();
  return {
    key,
    signed,
    step: NOW / 30_000 + 2,
    previous: await authenticatorCode(key, NOW + 30_000),
    current: await f.code(key),
  };
}

for (
  const kind of ["unchanged-key", "password", "replace", "remove"] as const
) {
  Deno.test(`TOTP commit fence: ${kind} rejects an independent consumption during hashing`, () =>
    fixture(async (f) => {
      const replay = await replayFixture(f);
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<string>();
      const hashed = await hashPassword("new-password");
      const workflow = new OwnAccount(f.sessions, {
        now: () => NOW + 60_000,
        hash: () => {
          entered.resolve();
          return release.promise;
        },
      });
      const totp = kind === "unchanged-key"
        ? { enabled: true, key: replay.key, code: replay.current }
        : kind === "replace"
        ? {
          enabled: true,
          key: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
          code: await f.code("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"),
        }
        : kind === "remove"
        ? { enabled: false }
        : undefined;
      const changing = workflow.change(replay.signed.principal, {
        revision: 1,
        updateId: createUuid(),
        currentPassword: "password",
        currentTotp: replay.previous,
        newPassword: "new-password",
        ...(totp ? { totp } : {}),
      });
      changing.catch(() => {});
      try {
        await workMilestone(
          changing,
          entered.promise,
          "credential hashing entered after current TOTP proof",
        );
        assertEquals(
          f.accounts.byId(f.alice.id)?.lastTotpStep,
          replay.step - 1,
        );
        const winner = await f.login("alice", "password", replay.current);
        const committed = Deno.readTextFileSync(`${f.root}/accounts.json`);
        release.resolve(hashed);
        await assertRejects(() => changing, StoredConfigConflict);
        assertEquals(
          Deno.readTextFileSync(`${f.root}/accounts.json`),
          committed,
        );
        assertEquals(f.accounts.byId(f.alice.id)?.credentialRevision, 1);
        assertEquals(
          new AccountRepository(f.root).byId(f.alice.id)?.lastTotpStep,
          replay.step,
        );
        await f.sessions.validateToken(winner.access_token);
        await f.sessions.validateToken(replay.signed.access_token);
      } finally {
        release.resolve(hashed);
        await changing.catch(() => {});
      }
    }));
}

Deno.test("TOTP commit fence: the operation may confirm its own consumed step", () =>
  fixture(async (f) => {
    const replay = await replayFixture(f);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<string>();
    const hashed = await hashPassword("new-password");
    const workflow = new OwnAccount(f.sessions, {
      now: () => NOW + 60_000,
      hash: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const changing = workflow.change(replay.signed.principal, {
      revision: 1,
      updateId: createUuid(),
      currentPassword: "password",
      currentTotp: replay.current,
      newPassword: "new-password",
      totp: { enabled: true, key: replay.key, code: replay.current },
    });
    changing.catch(() => {});
    try {
      await workMilestone(
        changing,
        entered.promise,
        "own TOTP consumption before hashing",
      );
      f.accounts.changeCredentials(
        f.bob.id,
        0,
        { totpKey: replay.key },
        createUuid(),
      );
      await f.login("bob", "password", replay.current);
      release.resolve(hashed);
      const result = await changing;
      assertEquals(result.account.credentialRevision, 2);
      assertEquals(f.accounts.byId(f.alice.id)?.lastTotpStep, replay.step);
      assertEquals(f.accounts.byId(f.bob.id)?.lastTotpStep, replay.step);
    } finally {
      release.resolve(hashed);
      await changing.catch(() => {});
    }
  }));

Deno.test("TOTP commit fence: first enrollment cannot overwrite a newly active authenticator", () =>
  fixture(async (f) => {
    const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", code = await f.code(key);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<string>();
    const hashed = await hashPassword("new-password");
    const workflow = new OwnAccount(f.sessions, {
      now: () => NOW,
      hash: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const changing = workflow.change(f.token.principal, {
      ...f.change,
      totp: { enabled: true, key, code },
    });
    changing.catch(() => {});
    try {
      await workMilestone(
        changing,
        entered.promise,
        "first enrollment proof before hashing",
      );
      f.accounts.changeCredentials(
        f.alice.id,
        0,
        { totpKey: key },
        createUuid(),
      );
      const winner = await f.login("alice", "password", code);
      const committed = Deno.readTextFileSync(`${f.root}/accounts.json`);
      release.resolve(hashed);
      await assertRejects(() => changing, AuthenticationError);
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), committed);
      await f.sessions.validateToken(winner.access_token);
    } finally {
      release.resolve(hashed);
      await changing.catch(() => {});
    }
  }));

Deno.test("TOTP commit fence: async signing cannot publish a stale login proof", () =>
  fixture(async (f) => {
    const replay = await replayFixture(f);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const sign = SignJWT.prototype.sign;
    let first = true;
    SignJWT.prototype.sign = async function (...args) {
      const held = first;
      first = false;
      const signed = await sign.apply(this, args);
      if (held) {
        entered.resolve();
        await release.promise;
      }
      return signed;
    };
    const signing = f.login("alice", "password", replay.previous);
    signing.catch(() => {});
    try {
      await workMilestone(
        signing,
        entered.promise,
        "real JWT signing held after TOTP consumption",
      );
      const winner = await f.login("alice", "password", replay.current);
      release.resolve();
      await assertRejects(() => signing, AuthenticationError);
      await f.sessions.validateToken(winner.access_token);
      await f.sessions.validateToken(replay.signed.access_token);
    } finally {
      SignJWT.prototype.sign = sign;
      release.resolve();
      await signing.catch(() => {});
    }
  }));
async function fixture(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  await identityFixture(async (root) => await run(await setup(root)));
}
async function setup(root: string) {
  const accounts = new AccountRepository(root);
  const alice = accounts.create(await prepareAccount("alice", "password"));
  const bob = accounts.create(await prepareAccount("bob", "password"));
  const signing = new SessionRepository(root);
  signing.initialize();
  let now = NOW;
  const sessions = new InstanceSessions(accounts, signing, {
    expirySeconds: 1000,
  }, { now: () => now });
  const login = (username = "alice", password = "password", totp?: string) =>
    sessions.login({ username, password, ...(totp ? { totp } : {}) });
  const token = await login(), other = await login("bob");
  const workflow = new OwnAccount(sessions, { now: () => now });
  return {
    root,
    accounts,
    alice,
    bob,
    sessions,
    signing,
    workflow,
    login,
    token,
    other,
    tick: () => {
      now += 30_000;
    },
    code: (key: string) => authenticatorCode(key, now),
    change: {
      revision: 0,
      updateId: UPDATE,
      currentPassword: "password",
      newPassword: "new-password",
    },
  };
}

Deno.test("own account: safe projection, fresh password, all old JWTs revoked, unrelated account survives", () =>
  fixture(async (f) => {
    const signing = Deno.readTextFileSync(`${f.root}/sessions.json`),
      second = await f.login();
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    await assertRejects(
      () =>
        f.workflow.change(f.token.principal, {
          ...f.change,
          currentPassword: "bad",
        }),
      AuthenticationError,
    );
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    const result = await f.workflow.change(f.token.principal, f.change);
    assertEquals(result.account.credentialRevision, 1);
    assert(!JSON.stringify(result).includes("pbkdf2"));
    await assertRejects(
      () => f.sessions.validateToken(f.token.access_token),
      AuthenticationError,
    );
    await assertRejects(
      () => f.sessions.validateToken(second.access_token),
      AuthenticationError,
    );
    await f.sessions.validateToken(f.other.access_token);
    await f.login("alice", "new-password");
    assertEquals(Deno.readTextFileSync(`${f.root}/sessions.json`), signing);
    const restarted = new AccountRepository(f.root);
    assertEquals(restarted.byId(f.alice.id)?.credentialUpdateId, UPDATE);
  }));

Deno.test("own account: lost reply review proves new credentials, never a revoked token or repeat mutation", () =>
  fixture(async (f) => {
    await f.workflow.change(f.token.principal, f.change);
    await assertRejects(
      () => f.workflow.change(f.token.principal, f.change),
      AuthenticationError,
    );
    await assertRejects(
      () =>
        f.workflow.outcome({
          username: "alice",
          password: "password",
          updateId: UPDATE,
        }),
      AuthenticationError,
    );
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    assertEquals(
      (await f.workflow.outcome({
        username: "alice",
        password: "new-password",
        updateId: UPDATE,
      })).matched,
      true,
    );
    assertEquals(
      (await f.workflow.outcome({
        username: "alice",
        password: "new-password",
        updateId: createUuid(),
      })).matched,
      false,
    );
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
  }));

Deno.test("own account: enrollment is inert; enable, replace and remove require both proofs", () =>
  fixture(async (f) => {
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    const candidate = await f.workflow.enrolment(f.token.principal);
    assert(candidate.qr.startsWith("data:image/png"));
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    await assertRejects(
      () =>
        f.workflow.change(f.token.principal, {
          ...f.change,
          totp: { enabled: true, key: candidate.key, code: "bad" },
        }),
      HttpError,
    );
    await f.workflow.change(f.token.principal, {
      revision: 0,
      updateId: UPDATE,
      currentPassword: "password",
      totp: {
        enabled: true,
        key: candidate.key,
        code: await f.code(candidate.key),
      },
    });
    const replay = await f.code(candidate.key);
    await assertRejects(
      () => f.login("alice", "password", replay),
      AuthenticationError,
    );
    f.tick();
    const signed = await f.login(
      "alice",
      "password",
      await f.code(candidate.key),
    );
    f.tick();
    await assertRejects(
      () =>
        f.workflow.change(signed.principal, {
          revision: 1,
          updateId: createUuid(),
          currentPassword: "password",
          totp: { enabled: false },
        }),
      AuthenticationError,
    );
    const replacement = await f.workflow.enrolment(signed.principal);
    await f.workflow.change(signed.principal, {
      revision: 1,
      updateId: createUuid(),
      currentPassword: "password",
      currentTotp: await f.code(candidate.key),
      totp: {
        enabled: true,
        key: replacement.key,
        code: await f.code(replacement.key),
      },
    });
    f.tick();
    const final = await f.login(
      "alice",
      "password",
      await f.code(replacement.key),
    );
    f.tick();
    await f.workflow.change(final.principal, {
      revision: 2,
      updateId: createUuid(),
      currentPassword: "password",
      currentTotp: await f.code(replacement.key),
      totp: { enabled: false },
    });
    await f.login();
    assertEquals(new AccountRepository(f.root).byId(f.alice.id)?.totpKey, null);
  }));

Deno.test("own account: temporary-password recipient must replace password before completing", () =>
  fixture(async (f) => {
    f.accounts.create(
      await prepareAccount("recipient", "temporary", { temporary: true }),
    );
    const token = await f.login("recipient", "temporary");
    await assertRejects(
      () =>
        f.workflow.change(token.principal, {
          revision: 0,
          updateId: UPDATE,
          currentPassword: "temporary",
          totp: { enabled: false },
        }),
      HttpError,
    );
    await f.workflow.change(token.principal, {
      revision: 0,
      updateId: UPDATE,
      currentPassword: "temporary",
      newPassword: "own-password",
    });
    assertEquals(
      (await f.login("recipient", "own-password")).principal
        .passwordChangeRequired,
      false,
    );
  }));

for (
  const cause of [
    "cancel",
    "same-account",
    "other-account",
    "external",
    "rename-failure",
  ] as const
) {
  Deno.test(`own account: ${cause} during hash preparation preserves CAS and accepted work`, () =>
    fixture(async (f) => {
      const held = Promise.withResolvers<string>(),
        entered = Promise.withResolvers<void>();
      const hashed = await hashPassword("new-password");
      const workflow = new OwnAccount(f.sessions, {
        hash: () => {
          entered.resolve();
          return held.promise;
        },
      });
      const abort = new AbortController(),
        before = Deno.readTextFileSync(`${f.root}/accounts.json`),
        rename = Deno.renameSync;
      const changing = workflow.change(
        f.token.principal,
        f.change,
        abort.signal,
      );
      changing.catch(() => {});
      try {
        await workMilestone(
          changing,
          entered.promise,
          "account hashing entered",
        );
        if (cause === "cancel") abort.abort();
        if (cause === "same-account") {
          f.accounts.changeCredentials(f.alice.id, 0, {
            passwordChangeRequired: true,
          }, createUuid());
        }
        if (cause === "other-account") {
          f.accounts.changeCredentials(f.bob.id, 0, {
            passwordChangeRequired: true,
          }, createUuid());
        }
        if (cause === "external") {
          Deno.writeTextFileSync(`${f.root}/accounts.json`, "external");
        }
        if (cause === "rename-failure") {
          Deno.renameSync = () => {
            throw new Deno.errors.PermissionDenied("fixture");
          };
        }
        held.resolve(hashed);
        if (cause === "other-account") {
          await changing;
          await f.login("alice", "new-password");
        } else {
          await assertRejects(() => changing);
          if (cause === "cancel" || cause === "rename-failure") {
            assertEquals(
              Deno.readTextFileSync(`${f.root}/accounts.json`),
              before,
            );
          }
          if (cause === "external") {
            assertEquals(
              Deno.readTextFileSync(`${f.root}/accounts.json`),
              "external",
            );
          }
        }
      } finally {
        Deno.renameSync = rename;
        held.resolve(hashed);
        await changing.catch(() => {});
      }
    }));
}

Deno.test("own account: no target-account field, guest mutation, stale CAS or repeated update", () =>
  fixture(async (f) => {
    for (
      const input of [{ ...f.change, accountId: f.bob.id }, {
        ...f.change,
        revision: 9,
      }, { ...f.change, passwordHash: "x" }]
    ) await assertRejects(() => f.workflow.change(f.token.principal, input));
    await assertRejects(
      () => f.workflow.change(GUEST, f.change),
      AuthenticationError,
    );
    const handlers = ownAccountHandlers(
      f.workflow,
      () => Promise.resolve(f.token.principal),
    );
    assertEquals(
      (await handlers.get(new Request("http://fixture/_/api/account"))).id,
      f.alice.id,
    );
    await handlers.patch(
      new Request("http://fixture/_/api/account", {
        method: "PATCH",
        body: JSON.stringify(f.change),
      }),
    );
    assertEquals(f.accounts.byId(f.bob.id)?.credentialRevision, 0);
    const next = await f.login("alice", "new-password");
    await assertRejects(
      () =>
        f.workflow.change(next.principal, {
          ...f.change,
          revision: 1,
          currentPassword: "new-password",
        }),
      StoredConfigConflict,
    );
  }));
