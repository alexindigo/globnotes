// SPDX-License-Identifier: LGPL-3.0-only

/** GET /_/api/config — server-side config the UI needs at boot.
 * Public by design (the client learns the auth type from it). */

import { brandBlock } from "@server/brand.ts";
import { state } from "@server/state.ts";
import {
  assertVaultTarget,
  publicProvenance,
} from "@server/config/projection.ts";
import type { PathfinderRequest } from "@pathfinder/pathfinder";

export const auth = false;

export default function (request?: PathfinderRequest): Record<string, unknown> {
  const c = state.config;
  assertVaultTarget(c, request);
  return {
    setupRequired: c.setupRequired,
    authType: c.authType,
    settingsWritable: c.settingsWritable,
    readOnlySettings: c.readOnlySettings,
    accessRevision: c.storedConfig?.access_revision ?? 0,
    accessUpdateId: c.storedConfig?.access_update_id ?? null,
    ...(c.resolved ? { provenance: publicProvenance(c) } : {}),
    quickAccessHide: c.quickAccessHide,
    quickAccessTitle: c.quickAccessTitle,
    quickAccessTerm: c.quickAccessTerm,
    quickAccessSort: c.quickAccessSort,
    quickAccessLimit: c.quickAccessLimit,
    autoEnablePlugins: c.autoEnablePlugins,
    brand: brandBlock(c),
    version: state.version?.version ?? null,
    revision: state.version?.revision ?? null,
  };
}
