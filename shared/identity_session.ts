// SPDX-License-Identifier: LGPL-3.0-only
export interface IdentitySessionProjection {
  principal?: { kind?: string };
  accountId?: string | null;
  sessionGeneration?: string | null;
  vaultId?: string | null;
  authorityRevision?: string | number | null;
}
/** Safe identity facts only, never a token or auth mode. */
export const identitySessionKey = (config: IdentitySessionProjection) =>
  JSON.stringify([
    config?.principal?.kind === "account"
      ? ["account", config.accountId]
      : ["guest"],
    config?.sessionGeneration ?? null,
    config?.vaultId ?? null,
    config?.authorityRevision ?? null,
  ]);
export const identityOwnerKey = (config: IdentitySessionProjection) =>
  JSON.stringify([
    config?.principal?.kind === "account"
      ? ["account", config.accountId]
      : ["guest"],
    config?.vaultId ?? null,
  ]);
