// SPDX-License-Identifier: LGPL-3.0-only
import { createOwnershipScope } from "../../shared/ownership.js";
import type { GlobalConfig } from "../config.ts";
import { BoundFileStore } from "../config/file_store.ts";
import { physicalStateRoot } from "../config/state_root.ts";
import { singleVaultIdentity } from "../config/single_vault.ts";
import { serviceSettings } from "../config/consumers.ts";
import { createOperationLease } from "../operation_lease.ts";
import type { PluginManager } from "../plugins/manager.ts";
import type { CredentialOptions } from "./account_credentials.ts";
import { AccountRepository } from "./accounts.ts";
import { AclRepository } from "./acl.ts";
import { OwnAccount } from "./account.ts";
import { VaultAccess } from "./access.ts";
import { AccountProvisioning } from "./provisioning.ts";
import { InstanceSessions, SessionRepository } from "./sessions.ts";
import {
  IdentityBootstrap,
  IdentityRecoveryError,
  legacyIdentityPresent,
  openIdentityTransaction,
} from "./bootstrap.ts";
import { IdentityTransaction } from "./transaction.ts";
import {
  acquireOfflineRecovery,
  assertOfflineRecovery,
} from "./offline_recovery.ts";
import { createIdentityComposition } from "./composition.ts";

// If replay removed its journal but cannot confirm retirement, the only
// evidence is still owned by that exact transaction. Keep its exclusive lock
// and recovery lease until a later startup joins and finishes it.
const pendingRecovery = new Map<string, {
  readonly vaultRoot: string;
  resume(): Promise<void>;
}>();

/** Prepared startup only: no globals, routes, services or listeners are installed.
 * I14c4 owns publication and its active config/composition/lifecycle binding.
 * The returned lease owns these exact repositories and exclusive root until close.
 * Recovery authority never escapes into HTTP or the returned services. */
export async function openInstanceIdentity(
  config: GlobalConfig,
  plugins: () => PluginManager,
  release: { version: string | null; revision: string | null },
  options: {
    signal?: AbortSignal;
    credentials?: CredentialOptions;
    seedCheckpoint?: Parameters<IdentityBootstrap["provisionConfigured"]>[0];
    recoveryCheckpoint?: (phase: string) => void;
  } = {},
) {
  // Capture resolved paths before lock acquisition yields. A caller cannot
  // retarget the startup by mutating its settings projection during hashing.
  const settings = Object.freeze({ ...config.resolved });
  const { signal, credentials } = options;
  const version = Object.freeze({ ...release });
  const custody = createOwnershipScope();
  let lifetime: ReturnType<typeof createOperationLease<"live">> | undefined;
  let accounts: AccountRepository | undefined;
  let closing: Promise<void> | undefined;
  let transferred = false;
  const retire = () => {
    lifetime?.retire();
    accounts?.retireCredentials();
  };
  const close = () => {
    retire();
    return closing ??= custody.releaseAll().then((report) =>
      report.throwIfFailed()
    );
  };
  try {
    signal?.throwIfAborted();
    const root = physicalStateRoot(settings.instancePath);
    const pending = pendingRecovery.get(root);
    if (pending) {
      if (pending.vaultRoot !== settings.statePath) {
        throw new IdentityRecoveryError();
      }
      await pending.resume();
      signal?.throwIfAborted();
    }
    const owner = (await custody.acquire(
      () => acquireOfflineRecovery(settings.instancePath),
      (owner) => owner.close(),
    )).value;
    lifetime = createOperationLease("live", [() => {
      signal?.throwIfAborted();
      custody.assertCurrent();
      return undefined;
    }], [assertOfflineRecovery(owner.authority, settings.instancePath)]);
    const lease = lifetime.lease;
    accounts = new AccountRepository(
      settings.instancePath,
      undefined,
      credentials,
    );
    custody.defer(() => accounts!.retireCredentials());
    // A present binding constrains replay before either participant is touched.
    // If absent, recover first, then let I14a adopt the settled ACL's exact ID.
    const bindingFile = new BoundFileStore(
      `${settings.instancePath}/single-vault.json`,
    );
    const bindingBefore = bindingFile.capture();
    const existingBinding = bindingBefore.raw === null
      ? undefined
      : singleVaultIdentity(settings, lease.assertCurrent);
    const recoveryLifetime = createOperationLease("live", [() => {
      custody.assertCurrent();
      bindingFile.assertUnchanged(bindingBefore);
      return undefined;
    }], [assertOfflineRecovery(owner.authority, settings.instancePath)]);
    try {
      // Recovery borrows the same account repository. Release transaction
      // custody before constructing the live owner with the settled binding.
      openIdentityTransaction(
        accounts,
        settings.statePath,
        recoveryLifetime.lease,
        owner.authority,
        existingBinding?.id,
        {
          checkpoint: options.recoveryCheckpoint,
          retain(transaction) {
            let completion: Promise<void> | undefined;
            pendingRecovery.set(root, {
              vaultRoot: settings.statePath,
              resume() {
                if (!completion) {
                  transaction.recover(owner.authority);
                  transaction.close();
                  recoveryLifetime.retire();
                  completion = close().finally(() =>
                    pendingRecovery.delete(root)
                  );
                }
                return completion;
              },
            });
            transferred = true;
          },
        },
      )?.close();
    } finally {
      if (!transferred) recoveryLifetime.retire();
    }
    const signing = new SessionRepository(settings.instancePath);
    const sessions = new InstanceSessions(
      accounts,
      signing,
      serviceSettings(settings.instance).sessions,
    );
    const legacy = () =>
      legacyIdentityPresent([
        `${settings.instancePath}/config.json`,
        `${settings.statePath}/config.json`,
      ]);
    const accessFile = new BoundFileStore(`${settings.statePath}/access.json`);
    const accessBefore = accessFile.capture();
    const before = new IdentityBootstrap(accounts, sessions, {
      lease,
      legacy,
      first: settings.instance.accounts.first,
      assertSeedTarget() {
        if (accessBefore.raw !== null) throw new IdentityRecoveryError();
        accessFile.assertUnchanged(accessBefore);
      },
    });
    custody.defer(() => before.dispose());
    if (before.state() === "fresh" && accessBefore.raw !== null) {
      throw new IdentityRecoveryError();
    }
    await before.provisionConfigured(options.seedCheckpoint);
    before.status();
    const binding = Object.freeze({
      ...singleVaultIdentity(settings, lease.assertCurrent),
    });
    const acl = new AclRepository(settings.statePath, binding.id, {
      accounts,
      declaredAdmin: settings.instance.vaults.entries.globnotes?.admin,
    });
    const transaction = new IdentityTransaction(accounts, acl, {
      vaultRoot: settings.statePath,
      lease,
    });
    custody.defer(() => transaction.close());
    const bootstrap = new IdentityBootstrap(accounts, sessions, {
      lease,
      legacy,
      first: settings.instance.accounts.first,
      target: { acl, root: settings.statePath },
      transaction,
    });
    custody.defer(() => bootstrap.dispose());
    bootstrap.status();
    const composition = createIdentityComposition({
      sessions,
      acl,
      vaultId: binding.id,
      config,
      plugins,
      lifetime: lease,
      setupStatus: () => bootstrap.status(),
      release: version,
    });
    const access = new VaultAccess(composition.authority, composition.vault);
    lease.assertCurrent();
    return Object.freeze({
      binding,
      accounts,
      signing,
      sessions,
      acl,
      transaction,
      bootstrap,
      composition,
      lifetime: lease,
      account: new OwnAccount(composition.authority),
      access,
      provisioning: new AccountProvisioning(access, transaction),
      close,
    });
  } catch (error) {
    retire();
    if (!transferred) (await custody.releaseAll()).throwIfFailed(error);
    throw error;
  }
}
export type InstanceIdentity = Awaited<ReturnType<typeof openInstanceIdentity>>;
