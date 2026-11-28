// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { AccountRepository } from "../server/auth/accounts.ts";
import { AclRepository } from "../server/auth/acl.ts";
import {
  IdentityTransaction,
  IdentityTransactionUnavailable,
} from "../server/auth/transaction.ts";
import { identityPaths } from "../server/auth/bootstrap.ts";
import { runIdentityCli } from "../server/auth/cli.ts";
import {
  InstanceSessions,
  SessionRepository,
} from "../server/auth/sessions.ts";
import { AuthenticationError } from "../server/auth/account_credentials.ts";
import { IdentityOwnershipError } from "../server/auth/ownership.ts";
import { OwnAccount } from "../server/auth/account.ts";
import { InstanceAuthority } from "../server/auth/authority.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import {
  identityAccount,
  identityFixture,
  storedAccount,
  UPDATE,
  VAULT_A,
  VAULT_B,
} from "./helpers/identity.ts";
import { fixturePasswordHash } from "./helpers/config.ts";
import {
  importFixtureAccount,
  preparationContext,
  recoveryForRoot,
} from "./helpers/account_preparation.ts";
import { DENO } from "./helpers/process_values.ts";
import { spawnOwnedChild } from "./helpers/owned_child.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import type { FixtureScope } from "./helpers/fixture_scope.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { authenticatorCode } from "./helpers/totp.ts";
import { encodeBase32 } from "@std/encoding/base32";

function context(root: string, scope: FixtureScope) {
  const config = `${root}/instance.toml`;
  Deno.writeTextFileSync(
    config,
    `[vaults]\nbasepath=${JSON.stringify(`${root}/data`)}\n[metadata]\npath=${
      JSON.stringify(`${root}/meta`)
    }\n`,
  );
  const env = { GLOBNOTES_CONFIG: config };
  const paths = identityPaths({ env });
  const start = async (args: string[], preload?: string) =>
    (await spawnOwnedChild(scope, DENO, {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
        ...(preload ? ["--preload", preload] : []),
        fromFileUrl(new URL("../server/auth/cli.ts", import.meta.url)),
        ...args,
      ],
      env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    })).value;
  const cli = async (args: string[], password = "") => {
    const child = await start(args);
    const output = new Response(child.stdout).text(),
      errors = new Response(child.stderr).text();
    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(password));
      await writer.close();
    } finally {
      writer.releaseLock();
    }
    const status = await child.exited;
    return {
      code: status.code,
      success: status.success,
      stdout: await output,
      stderr: await errors,
    };
  };
  return { root, paths, env, start, cli };
}
const create = ["account", "create", "--login", "alice", "--password-stdin"];
const refusal =
  "Identity command refused; stop the instance and check command, configuration and identity state. No automatic repair was attempted.\n";

Deno.test("identity CLI: rejects missing values, missing required options and duplicate options", async () => {
  for (
    const [args, message] of [
      [["account", "disable-totp", "--login"], "Missing command option."],
      [create.slice(0, -1), "Missing command option."],
      [[...create.slice(0, -1), "--login", "bob"], "Invalid command option."],
    ] as const
  ) {
    await assertRejects(
      () => runIdentityCli([...args], {}, () => Promise.resolve("unused")),
      Error,
      message,
    );
  }
});

Deno.test("identity CLI: create consumes a flag-looking login operand", () =>
  identityFixture(async (root, scope) => {
    const f = context(root, scope);
    const result = await f.cli([
      "account",
      "create",
      "--login",
      "--alice",
      "--password-stdin",
    ], "temporary\n");
    assertEquals([result.code, result.success, result.stderr], [0, true, ""]);
    const accounts = new AccountRepository(f.paths.instance);
    scope.defer(() => accounts.retireCredentials());
    assertEquals(accounts.capture().value.accounts.map((a) => a.login), [
      "--alice",
    ]);
  }));

Deno.test("identity CLI: fresh and ready creation is temporary, grants no vault, and private-password completion revokes the temporary token", () =>
  identityFixture(async (root, scope) => {
    const f = context(root, scope);
    const result = await f.cli(create, "temporary\n");
    assertEquals([result.code, result.success, result.stderr], [0, true, ""]);
    const summary = JSON.parse(result.stdout);
    const accounts = new AccountRepository(f.paths.instance);
    scope.defer(() => accounts.retireCredentials());
    const person = accounts.byLogin("alice")!;
    assertEquals(summary, {
      operation: "account create",
      accountId: person.id,
      result: "committed",
      updateId: summary.updateId,
    });
    assertEquals([person.passwordChangeRequired, accounts.initialized], [
      true,
      true,
    ]);
    assertEquals(
      [...Deno.readDirSync(f.paths.instance)].map((e) => e.name).sort(),
      ["accounts.json", "identity.lock", "sessions.json"],
    );
    assertEquals(
      Deno.readTextFileSync(`${f.paths.instance}/accounts.json`).includes(
        "temporary",
      ),
      false,
    );
    const sessions = new InstanceSessions(
      accounts,
      new SessionRepository(f.paths.instance),
      f.paths.sessions,
    );
    const old = await signIn(sessions, {
      username: "alice",
      password: "temporary",
    });
    const lifetime = createOperationLease("live", [() => undefined]);
    scope.defer(() => lifetime.retire());
    const own = new OwnAccount(
      new InstanceAuthority(sessions, () => null, lifetime.lease),
    );
    const response = await own.change(old.principal, {
      revision: person.credentialRevision,
      updateId: UPDATE,
      currentPassword: "temporary",
      newPassword: "private",
    });
    assertEquals((await new Response(response).json()).requiresLogin, true);
    await assertRejects(
      () => sessions.validateToken(old.access_token),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    const privateSession = await signIn(sessions, {
      username: "alice",
      password: "private",
    });
    assertEquals(privateSession.principal.passwordChangeRequired, false);
    const second = await f.cli([
      "account",
      "create",
      "--login",
      "bob",
      "--password-stdin",
    ], "temporary-bob\n");
    assertEquals([second.code, second.success, second.stderr], [0, true, ""]);
    const reopened = new AccountRepository(f.paths.instance);
    scope.defer(() => reopened.retireCredentials());
    assertEquals(
      reopened.capture().value.accounts.map(
        (a) => [a.login, a.passwordChangeRequired],
      ),
      [["alice", false], ["bob", true]],
    );
    assertEquals(
      [...Deno.readDirSync(f.paths.instance)].map((e) => e.name).sort(),
      ["accounts.json", "identity.lock", "sessions.json"],
    );
  }));

Deno.test("identity CLI: reset preserves historical secret/encoding/floor, disable clears them, and grant-admin changes only the configured existing ACL", () =>
  identityFixture(async (root, scope) => {
    const f = context(root, scope);
    Deno.mkdirSync(f.paths.notes, { recursive: true });
    const accounts = new AccountRepository(f.paths.instance);
    scope.defer(() => accounts.retireCredentials());
    const rawKey = "legacy-cli-key";
    const person = importFixtureAccount(
      accounts,
      identityAccount({
        login: "--alice",
        passwordHash: fixturePasswordHash("private"),
        totpKey: rawKey,
        lastTotpStep: 123,
      }),
    );
    importFixtureAccount(
      accounts,
      identityAccount({
        id: VAULT_A,
        login: "bob",
        passwordHash: fixturePasswordHash("bob-password"),
      }),
    );
    const signing = new SessionRepository(f.paths.instance);
    signing.initialize();
    const signingBytes = Deno.readTextFileSync(
      `${f.paths.instance}/sessions.json`,
    );
    const bob = await signIn(
      new InstanceSessions(accounts, signing, f.paths.sessions),
      { username: "bob", password: "bob-password" },
    );
    const acl = new AclRepository(f.paths.vault, VAULT_A, { accounts });
    acl.save({ everybody: "view", grants: {} }, acl.capture(), {
      updateId: UPDATE,
      actorId: null,
    });
    const aclBefore = Deno.readTextFileSync(`${f.paths.vault}/access.json`);
    const before = storedAccount(accounts, person.id);
    const reset = await f.cli([
      "account",
      "reset-password",
      "--login",
      "--alice",
      "--password-stdin",
    ], "new-password\n");
    assertEquals([reset.code, reset.success, reset.stderr], [0, true, ""]);
    const resetAccounts = new AccountRepository(f.paths.instance, undefined, {
      now: () => 1_700_000_000_000,
    });
    scope.defer(() => resetAccounts.retireCredentials());
    const resetPerson = storedAccount(resetAccounts, person.id);
    assertEquals([
      resetPerson.totpKey,
      resetPerson.totpKeyEncoding,
      resetPerson.lastTotpStep,
      resetPerson.passwordChangeRequired,
      resetPerson.credentialRevision,
    ], [before.totpKey, before.totpKeyEncoding, before.lastTotpStep, true, 1]);
    assertEquals([
      Deno.readTextFileSync(`${f.paths.instance}/sessions.json`),
      Deno.readTextFileSync(`${f.paths.vault}/access.json`),
    ], [signingBytes, aclBefore]);
    const sessions = new InstanceSessions(
      resetAccounts,
      new SessionRepository(f.paths.instance),
      f.paths.sessions,
      { now: () => 1_700_000_000_000 },
    );
    const secret = encodeBase32(new TextEncoder().encode(rawKey)).replace(
      /=+$/,
      "",
    );
    const code = await authenticatorCode(secret, 1_700_000_000_000);
    const temporary = await signIn(sessions, {
      username: "--alice",
      password: "new-password",
      totp: code,
    });
    assertEquals(temporary.principal.passwordChangeRequired, true);
    const disabled = await f.cli([
      "account",
      "disable-totp",
      "--login",
      "--alice",
    ]);
    assertEquals([disabled.code, disabled.success, disabled.stderr], [
      0,
      true,
      "",
    ]);
    const grant = await f.cli([
      "vault",
      "grant-admin",
      "--vault",
      "globnotes",
      "--login",
      "--alice",
    ]);
    assertEquals([grant.code, grant.success, grant.stderr], [0, true, ""]);
    const reopened = new AccountRepository(f.paths.instance);
    scope.defer(() => reopened.retireCredentials());
    const final = storedAccount(reopened, person.id);
    assertEquals([
      final.totpKey,
      final.lastTotpStep,
      final.passwordHash,
      final.credentialRevision,
    ], [null, null, resetPerson.passwordHash, 2]);
    assertEquals(reopened.byLogin("bob"), accounts.byLogin("bob"));
    const next = new InstanceSessions(
      reopened,
      new SessionRepository(f.paths.instance),
      f.paths.sessions,
    );
    assertEquals(await next.validateToken(bob.access_token), bob.principal);
    await assertRejects(
      () => next.validateToken(temporary.access_token),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    const login = await signIn(next, {
      username: "--alice",
      password: "new-password",
    });
    assertEquals(
      new AclRepository(f.paths.vault, VAULT_A, { accounts: reopened })
        .effectiveLevel(login.principal),
      "admin",
    );
  }));

const grantAlice = [
  "vault",
  "grant-admin",
  "--vault",
  "globnotes",
  "--login",
  "alice",
];
const savedBinding = JSON.stringify({
  version: 1,
  id: VAULT_A,
  createdAt: "2026-11-17T11:22:00.000Z",
});

Deno.test("identity CLI: grant-admin does not create a missing vault", () =>
  identityFixture(async (root, scope) => {
    const f = context(root, scope);
    assertEquals((await f.cli(create, "temporary\n")).code, 0);
    assertEquals(await f.cli(grantAlice), {
      code: 1,
      success: false,
      stdout: "",
      stderr: refusal,
    });
    assertThrows(() => Deno.statSync(f.paths.notes), Deno.errors.NotFound);
    assertThrows(() => Deno.statSync(f.paths.vault), Deno.errors.NotFound);
    assertThrows(
      () => Deno.statSync(`${f.paths.instance}/single-vault.json`),
      Deno.errors.NotFound,
    );
  }));

for (const bound of [false, true]) {
  Deno.test(`identity CLI: an offline-created account can be granted Admin with no ACL (binding present: ${bound})`, () =>
    identityFixture(async (root, scope) => {
      const f = context(root, scope);
      Deno.mkdirSync(f.paths.notes, { recursive: true });
      assertEquals((await f.cli(create, "temporary\n")).code, 0);
      const bindingFile = `${f.paths.instance}/single-vault.json`;
      if (bound) Deno.writeTextFileSync(bindingFile, savedBinding);
      assertThrows(
        () => Deno.statSync(`${f.paths.vault}/access.json`),
        Deno.errors.NotFound,
      );
      const granted = await f.cli(grantAlice);
      assertEquals([granted.code, granted.success, granted.stderr], [
        0,
        true,
        "",
      ]);
      const binding = Deno.readTextFileSync(bindingFile);
      const { id } = JSON.parse(binding);
      if (bound) assertEquals(binding, savedBinding);
      const accounts = new AccountRepository(f.paths.instance);
      scope.defer(() => accounts.retireCredentials());
      const acl = new AclRepository(f.paths.vault, id, { accounts });
      const { accountId, updateId } = JSON.parse(granted.stdout);
      assertEquals(acl.capture().value, {
        version: 1,
        vaultId: id,
        revision: 1,
        everybody: "none",
        grants: { [accounts.byLogin("alice")!.id]: "admin" },
        updateActorId: null,
        updateId,
      });
      assertEquals(accountId, accounts.byLogin("alice")!.id);
    }));
}

for (
  const [label, raw, bound] of [
    ["malformed JSON", "broken", false],
    ["stored null", "null", false],
    ["missing fields", JSON.stringify({ version: 1, vaultId: VAULT_A }), false],
    ...[["foreign vault", VAULT_B, {}, true], ["unknown grantee", VAULT_A, {
      [VAULT_B]: "view",
    }, false]].map(
      ([label, vaultId, grants, bound]) =>
        [
          label,
          JSON.stringify({
            version: 1,
            vaultId,
            revision: 1,
            updateId: null,
            updateActorId: null,
            everybody: "view",
            grants,
          }),
          bound,
        ] as const,
    ),
  ] as const
) {
  Deno.test(`identity CLI: refuses ${label} without changing the binding or ACL`, () =>
    identityFixture(async (root, scope) => {
      const f = context(root, scope);
      Deno.mkdirSync(f.paths.notes, { recursive: true });
      assertEquals((await f.cli(create, "temporary\n")).code, 0);
      const bindingFile = `${f.paths.instance}/single-vault.json`;
      if (bound) Deno.writeTextFileSync(bindingFile, savedBinding);
      const aclFile = `${f.paths.vault}/access.json`;
      Deno.mkdirSync(f.paths.vault, { recursive: true });
      Deno.writeTextFileSync(aclFile, raw);
      assertEquals(await f.cli(grantAlice), {
        code: 1,
        success: false,
        stdout: "",
        stderr: refusal,
      });
      assertEquals(Deno.readTextFileSync(aclFile), raw);
      if (bound) assertEquals(Deno.readTextFileSync(bindingFile), savedBinding);
      else assertThrows(() => Deno.statSync(bindingFile), Deno.errors.NotFound);
    }));
}

Deno.test("identity CLI: live ownership refuses immediately without queueing and permits only an explicit later retry", () =>
  identityFixture(async (root, scope) => {
    const f = context(root, scope), owner = recoveryForRoot(f.paths.instance);
    const before = [...Deno.readDirSync(f.paths.instance)].map((e) => e.name);
    try {
      assertEquals(await f.cli(create, "temporary\n"), {
        code: 1,
        success: false,
        stdout: "",
        stderr: refusal,
      });
    } finally {
      owner.close();
    }
    assertEquals(
      [...Deno.readDirSync(f.paths.instance)].map((e) => e.name),
      before,
    );
    assertEquals((await f.cli(create, "temporary\n")).code, 0);
  }));

Deno.test("identity CLI: actual stdin interruption releases ownership without creating an account", () =>
  identityFixture(async (root, scope) => {
    const f = context(root, scope);
    const preload = `${root}/stdin-observer.mjs`, ready = `${root}/stdin-ready`;
    // Observe admission at the real reader instead of taking the same
    // exclusive lock the fail-fast CLI must acquire to get there.
    await Deno.writeTextFile(
      preload,
      `
      const input = Deno.stdin;
      const readable = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "readable").get;
      Object.defineProperty(input, "readable", { get() {
        const stream = readable.call(this);
        Deno.writeTextFileSync(${JSON.stringify(ready)}, "admitted");
        return stream;
      } });
    `,
    );
    const child = await f.start(create, preload);
    const stdout = new Response(child.stdout).text(),
      stderr = new Response(child.stderr).text();
    await waitUntil(async () => {
      const status = child.status();
      if (status) {
        throw new Error(
          `CLI exited before reading stdin (${status.code}): ${await stderr}`,
        );
      }
      try {
        Deno.statSync(ready);
        return done();
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          return pending({ waiting: "CLI stdin reader" });
        }
        throw error;
      }
    }, { label: "CLI owns stdin admission" });
    assertThrows(
      () => recoveryForRoot(f.paths.instance),
      IdentityOwnershipError,
    );
    child.signal("SIGTERM");
    const status = await child.exited;
    assertEquals([status.code, status.success, await stdout, await stderr], [
      1,
      false,
      "",
      refusal,
    ]);
    assertEquals(
      [...Deno.readDirSync(f.paths.instance)].map((e) => e.name).sort(),
      ["identity.lock"],
    );
    const owner = recoveryForRoot(f.paths.instance);
    owner.close();
  }));

Deno.test("identity CLI: deliberate create finishes signing-only interruption, while corrupt/legacy inputs and argv passwords stay untouched", () =>
  identityFixture(async (root, scope) => {
    const f = context(root, scope);
    new SessionRepository(f.paths.instance).initialize();
    assertEquals((await f.cli(create, "temporary\n")).code, 0);
    const before = Deno.readTextFileSync(`${f.paths.instance}/accounts.json`);
    assertEquals(await f.cli(create, "other\n"), {
      code: 1,
      success: false,
      stdout: "",
      stderr: refusal,
    });
    assertEquals(
      Deno.readTextFileSync(`${f.paths.instance}/accounts.json`),
      before,
    );
    assertEquals(await f.cli([...create, "--password", "forbidden-argv"]), {
      code: 1,
      success: false,
      stdout: "",
      stderr: refusal,
    });
    Deno.writeTextFileSync(`${f.paths.instance}/accounts.json`, "corrupt");
    assertEquals(await f.cli(["account", "disable-totp", "--login", "alice"]), {
      code: 1,
      success: false,
      stdout: "",
      stderr: refusal,
    });
    assertEquals(
      Deno.readTextFileSync(`${f.paths.instance}/accounts.json`),
      "corrupt",
    );
  }));

Deno.test("identity CLI: recognized unimported legacy state and unknown vault are refused without repair", () =>
  identityFixture(async (root, scope) => {
    const f = context(root, scope);
    Deno.mkdirSync(f.paths.instance, { recursive: true });
    const file = `${f.paths.instance}/config.json`,
      bytes = '{"auth_type":"none","password_hash":"fixture-secret"}';
    Deno.writeTextFileSync(file, bytes);
    assertEquals(await f.cli(create, "temporary\n"), {
      code: 1,
      success: false,
      stdout: "",
      stderr: "Account migration required; public setup is unavailable.\n",
    });
    assertEquals(
      await f.cli([
        "vault",
        "grant-admin",
        "--vault",
        "other",
        "--login",
        "alice",
      ]),
      { code: 1, success: false, stdout: "", stderr: refusal },
    );
    assertEquals([
      Deno.readTextFileSync(file),
      [...Deno.readDirSync(f.paths.instance)].map((e) => e.name).sort(),
    ], [bytes, ["config.json", "identity.lock"]]);
  }));

Deno.test("identity CLI: recover the decided configured-root pair before admitting another account command", () =>
  identityFixture(async (root, scope) => {
    const f = context(root, scope);
    const original = preparationContext(f.paths.instance, {});
    scope.defer(() => original.accounts.retireCredentials());
    scope.defer(() => original.retire());
    original.accounts.prepareParents();
    new SessionRepository(f.paths.instance).initialize();
    const lifetime = createOperationLease("live", [() => undefined]);
    scope.defer(() => lifetime.retire());
    const acl = new AclRepository(f.paths.vault, VAULT_A, {
      accounts: original.accounts,
    });
    acl.prepareParents();
    const transaction = new IdentityTransaction(original.accounts, acl, {
      vaultRoot: f.paths.vault,
      lease: lifetime.lease,
      checkpoint: (point) => {
        if (point === "installed") throw new Error("fixture retained journal");
      },
    });
    const prepared = await original.accounts.credentials.prepareInitialAccount(
      original.authority("initial"),
      original.request(),
    );
    const parts = transaction.prepareInitial(
      prepared,
      "view",
      acl.capture(),
      lifetime.lease,
      UPDATE,
    );
    scope.defer(() => parts.discard());
    assertThrows(
      () =>
        transaction.commit(
          {
            kind: "setup",
            operationId: UPDATE,
            actorId: prepared.identity.id,
            vaultId: VAULT_A,
          },
          parts,
          lifetime.lease,
        ),
      IdentityTransactionUnavailable,
      "Identity publication requires recovery; no partial state is available.",
    );
    assertEquals(
      (await f.cli(
        ["account", "create", "--login", "bob", "--password-stdin"],
        "temporary-bob\n",
      )).code,
      0,
    );
    const reopened = new AccountRepository(f.paths.instance);
    scope.defer(() => reopened.retireCredentials());
    const restored = new AclRepository(f.paths.vault, VAULT_A, {
      accounts: reopened,
    });
    assertEquals([
      reopened.capture().value.accounts.map((a) => a.login),
      restored.capture().value.everybody,
      restored.capture().value.grants,
    ], [["alice", "bob"], "view", { [prepared.identity.id]: "admin" }]);
    assertEquals(
      [...Deno.readDirSync(f.paths.instance)].map((e) => e.name).sort(),
      ["accounts.json", "identity.lock", "sessions.json"],
    );
  }));
