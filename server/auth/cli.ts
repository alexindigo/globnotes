// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { createUuid } from "../../shared/uuid.ts";
import { snapshotEnvironment } from "../environment.ts";
import { BoundFileStore } from "../config/file_store.ts";
import {
  IdentityBootstrap,
  identityPaths,
  IdentityRecoveryError,
  legacyIdentityPresent,
  openIdentityTransaction,
} from "./bootstrap.ts";
import {
  acquireOfflineRecovery,
  assertOfflineRecovery,
} from "./offline_recovery.ts";
import { AccountRepository, normalizeLogin } from "./accounts.ts";
import { InstanceSessions, SessionRepository } from "./sessions.ts";
import { AclRepository } from "./acl.ts";
import { identity, record } from "./records.ts";
import { createOperationLease } from "../operation_lease.ts";

/** Offline only. Acquire the real nonblocking owner before reading identities,
 * and let the aggregate own temporary passwords and authenticator transitions. */
export async function runIdentityCli(
  args: string[],
  env: Record<string, string>,
  password: () => Promise<string>,
  signal?: AbortSignal,
) {
  const [scope, operation, ...flags] = args;
  const allowed = scope === "account" &&
      ["create", "reset-password", "disable-totp"].includes(operation)
    ? operation === "disable-totp"
      ? ["--login"]
      : ["--login", "--password-stdin"]
    : scope === "vault" && operation === "grant-admin"
    ? ["--login", "--vault"]
    : null;
  if (!allowed) throw new Error("Invalid identity command.");
  const options = new Map<string, string>();
  for (let i = 0; i < flags.length; i++) {
    const key = flags[i];
    if (!allowed.includes(key) || options.has(key)) {
      throw new Error("Invalid command option.");
    }
    const value = key === "--password-stdin" ? "true" : flags[++i];
    if (!value || value.startsWith("--")) {
      throw new Error("Missing command option.");
    }
    options.set(key, value);
  }
  if (allowed.some((key) => !options.has(key))) {
    throw new Error("Missing command option.");
  }
  const login = normalizeLogin(options.get("--login")!);
  const paths = identityPaths({ env });
  if (
    scope === "vault" &&
    (options.get("--vault") !== "globnotes" ||
      Object.keys(paths.loaded.config.vaults.entries).some((name) =>
        name !== "globnotes"
      ))
  ) throw new Error("Unknown or unsupported vault.");
  signal?.throwIfAborted();
  const owner = acquireOfflineRecovery(paths.instance);
  let accounts: AccountRepository | undefined;
  let bootstrap: IdentityBootstrap | undefined;
  let transaction: ReturnType<typeof openIdentityTransaction>;
  let lifetime: ReturnType<typeof createOperationLease<"live">> | undefined;
  try {
    const recovery = assertOfflineRecovery(owner.authority, paths.instance);
    lifetime = createOperationLease("live", [() => {
      signal?.throwIfAborted();
      return undefined;
    }], [recovery]);
    accounts = new AccountRepository(paths.instance);
    transaction = openIdentityTransaction(
      accounts,
      paths.vault,
      lifetime.lease,
      owner.authority,
    );
    const signing = new SessionRepository(paths.instance);
    const sessions = new InstanceSessions(accounts, signing, paths.sessions);
    bootstrap = new IdentityBootstrap(accounts, sessions, {
      lease: lifetime.lease,
      legacy: () => legacyIdentityPresent(paths.legacyFiles),
      transaction,
    });
    const state = bootstrap.state();
    const creating = scope === "account" && operation === "create";
    if (state !== "ready" && !creating) throw new IdentityRecoveryError();
    if (state !== "ready" && legacyIdentityPresent(paths.legacyFiles)) {
      throw new IdentityRecoveryError();
    }
    if (
      state === "incomplete" &&
      (new BoundFileStore(join(paths.instance, "accounts.json")).capture()
            .raw !== null || signing.capture().persistence.raw === null)
    ) throw new IdentityRecoveryError();
    const signingBefore = signing.capture();
    const expected = accounts.capture();
    const updateId = createUuid();
    let account = accounts.byLogin(login);
    if (creating) {
      if (account) throw new Error("Account already exists.");
      const prepared = await accounts.credentials.prepareOfflineAccount(
        owner.authority,
        { login, password: await password(), updateId },
        signal,
      );
      signal?.throwIfAborted();
      assertOfflineRecovery(owner.authority, paths.instance);
      accounts.assertUnchanged(expected);
      signing.assertUnchanged(signingBefore);
      if (state === "fresh") signing.initialize();
      account = accounts.credentials.publishPreparedAccount(prepared.prepared);
    } else {
      if (!account) throw new Error("Unknown account.");
      const request = {
        accountId: account.id,
        credentialRevision: account.credentialRevision,
        updateId,
      };
      if (operation === "reset-password") {
        account = await accounts.credentials.resetPassword(owner.authority, {
          ...request,
          password: await password(),
        }, signal);
      } else if (operation === "disable-totp") {
        account = await accounts.credentials.disableAuthenticator(
          owner.authority,
          request,
          signal,
        );
      } else {
        const raw =
          new BoundFileStore(join(paths.vault, "access.json")).capture().raw;
        const value: unknown = raw === null ? null : JSON.parse(raw);
        if (!record(value) || !identity(value.vaultId)) {
          throw new IdentityRecoveryError();
        }
        const acl = new AclRepository(paths.vault, value.vaultId, { accounts });
        const before = acl.capture();
        acl.save(
          {
            everybody: before.value.everybody,
            grants: { ...before.value.grants, [account.id]: "admin" },
          },
          before,
          { updateId, actorId: null },
          () => {
            signal?.throwIfAborted();
            assertOfflineRecovery(owner.authority, paths.instance);
            signing.assertUnchanged(signingBefore);
            accounts!.assertUnchanged(expected);
          },
        );
      }
    }
    return Object.freeze({
      operation: `${scope} ${operation}`,
      accountId: account.id,
      result: "committed",
      updateId,
    });
  } finally {
    try {
      bootstrap?.dispose();
      transaction?.close();
    } finally {
      accounts?.retireCredentials();
      lifetime?.retire();
      owner.close();
    }
  }
}

if (import.meta.main) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  Deno.addSignalListener("SIGTERM", cancel);
  Deno.addSignalListener("SIGINT", cancel);
  try {
    const result = await runIdentityCli(
      Deno.args,
      snapshotEnvironment(),
      async () => {
        const reader = Deno.stdin.readable.getReader();
        const cancelRead = () => {
          reader.cancel(abort.signal.reason).catch(() => {});
        };
        abort.signal.addEventListener("abort", cancelRead, { once: true });
        const chunks: Uint8Array[] = [];
        try {
          abort.signal.throwIfAborted();
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            chunks.push(part.value);
          }
          abort.signal.throwIfAborted();
        } finally {
          abort.signal.removeEventListener("abort", cancelRead);
          reader.releaseLock();
        }
        const value = (await new Blob(chunks).text()).replace(/\r?\n$/, "");
        if (
          !value || value.includes("\n") || value.includes("\r")
        ) throw new Error("One nonempty password is required on stdin.");
        return value;
      },
      abort.signal,
    );
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      "Identity command refused; stop the instance and check command, configuration and identity state. No automatic repair was attempted.",
    );
    Deno.exitCode = 1;
  } finally {
    Deno.removeSignalListener("SIGTERM", cancel);
    Deno.removeSignalListener("SIGINT", cancel);
  }
}
