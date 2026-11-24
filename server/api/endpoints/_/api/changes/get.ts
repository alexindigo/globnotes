// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { createIdentityVaultChanges } from "@server/hub/identity_changes.ts";
import { state } from "@server/state.ts";
export const operation = "readVault";
export default (request: PathfinderRequest) => {
  const { identity, hub, drivers, config } = state;
  if (!hub) throw new HttpError(503, "Vault changes are unavailable.");
  return createIdentityVaultChanges(identity!.composition.streamAccess, {
    vaultId: identity!.binding.id,
    hub,
    root: config.notesPath,
    stateRoot: config.statePath,
    drivers: () => drivers,
  })(request);
};
