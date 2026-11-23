// SPDX-License-Identifier: LGPL-3.0-only
import type { GlobalConfig } from "../config.ts";
import { brandBlock } from "../brand.ts";
import type { PluginManager } from "../plugins/manager.ts";
import type { StatusAdmission } from "./middleware.ts";
import type { InstanceSessions } from "./sessions.ts";

/** Allowlisted response values. Administrative inventories never serve as reader
 * payloads, and None never exposes a concrete vault binding. Delivery is owned
 * by the caller's issued lease; these functions only build values. */
export function createIdentityProjections(adapters: {
  sessions: InstanceSessions;
  config: GlobalConfig;
  plugins(): PluginManager;
  setupStatus(): { setupRequired: boolean };
  release: { version: string | null; revision: string | null };
}) {
  const status = (admission: StatusAdmission) => {
    const { lease: { principal }, capabilities } = admission;
    const account = principal.kind === "account"
      ? adapters.sessions.accounts.identityById(principal.accountId)
      : null;
    return {
      version: adapters.release.version,
      revision: adapters.release.revision,
      setupRequired: adapters.setupStatus().setupRequired,
      principal: account && principal.kind === "account"
        ? {
          kind: "account" as const,
          id: account.id,
          login: account.login,
          totpEnabled: account.totpEnabled,
          passwordChangeRequired: principal.passwordChangeRequired,
          expiresAt: principal.expiresAt,
        }
        : { kind: "guest" as const },
      accountId: account?.id ?? null,
      sessionGeneration: principal.kind === "account"
        ? `${principal.credentialRevision}:${principal.signingRevision}:${principal.expiresAt}`
        : "guest",
      vaultId: admission.scope === "vault" ? admission.lease.vaultId : null,
      authorityRevision: admission.scope === "vault"
        ? `${admission.lease.aclRevision}:${admission.lease.epoch}`
        : null,
      capabilities,
    };
  };
  const config = (admission: StatusAdmission) => {
    const current = {
      ...status(admission),
      storageDurability: adapters.config.storageDurability,
    };
    if (admission.scope === "instance") return current;
    const c = adapters.config;
    return {
      ...current,
      quickAccessHide: c.quickAccessHide,
      quickAccessTitle: c.quickAccessTitle,
      quickAccessTerm: c.quickAccessTerm,
      quickAccessSort: c.quickAccessSort,
      quickAccessLimit: c.quickAccessLimit,
      brand: brandBlock(c),
    };
  };
  return Object.freeze({
    status,
    config,
    /** Admin receives the authoritative inventory; readers only descriptors. */
    catalog: (
      manageVault: boolean,
    ): Promise<
      | Awaited<ReturnType<PluginManager["catalog"]>>
      | Awaited<ReturnType<PluginManager["readerCatalog"]>>
    > =>
      manageVault
        ? adapters.plugins().catalog()
        : adapters.plugins().readerCatalog(),
  });
}
