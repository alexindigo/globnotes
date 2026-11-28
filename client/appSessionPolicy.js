// SPDX-License-Identifier: LGPL-3.0-only
export { identitySessionKey, identityOwnerKey } from "../shared/identity_session.ts";

export function readerRuntimeEligibility(ready, config, routeName) {
  // Configuration can arrive before the router commits its initial route.
  // That provisional context must not open a route-owned permission prompt.
  return ready && routeName != null && !config.setupRequired && routeName !== "login" && config.capabilities?.canRead === true;
}

export function permissionEligibility(ready, config, routeName) {
  return readerRuntimeEligibility(ready, config, routeName) && config.capabilities?.canManageVault === true;
}

export function permissionWritability(eligible, config) {
  return eligible && config.capabilities?.canManageVault === true;
}
