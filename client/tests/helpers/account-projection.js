// SPDX-License-Identifier: LGPL-3.0-only
import { identityOwnerKey } from "../../../shared/identity_session.ts";

/** Config response for a concrete account or guest with a given vault grant. */
export function accountProjection({ login = "alice", level = "admin", guest = false,
  generation = guest ? "guest" : "1:1:2000000000", revision = "1:1", setupRequired = false,
  totpEnabled = false } = {}) {
  const canRead = level !== "none";
  return {
    principal: guest ? { kind: "guest" } : { kind: "account", id: login, login, totpEnabled,
      passwordChangeRequired: false, expiresAt: 2000000000 },
    accountId: guest ? null : login,
    vaultId: canRead ? "fixture" : null,
    sessionGeneration: generation,
    authorityRevision: canRead ? revision : null,
    capabilities: { canRead, canEdit: level === "admin" || level === "edit", canManageVault: level === "admin",
      canManageOwnAccount: !guest, canCreateVault: !guest },
    setupRequired,
    ...(canRead ? { brand: {} } : {}),
  };
}

export const scopedDraftKey = (projection, path) =>
  `globnotes:draft:identity:${encodeURIComponent(JSON.stringify(["", identityOwnerKey(projection)]))}:${encodeURIComponent(path)}`;

/** Replace the wire, not the App session, catalogue publisher or stream owner. */
export function identityFixtureIO({ getConfig, getToken, getPluginHostCatalog, getNoteIndex }) {
  return {
    getConfig, getToken,
    read(name) {
      if (name === "plugin-host") return getPluginHostCatalog();
      if (name === "note-index") return getNoteIndex();
      throw Error(`No fixture for identity read: ${name}`);
    },
    openPluginHostEvents: async () => () => {},
    openVaultChanges: async () => () => {},
  };
}
