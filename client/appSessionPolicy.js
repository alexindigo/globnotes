// SPDX-License-Identifier: LGPL-3.0-only
import { authTypes } from "./constants.js";
import { identitySessionKey } from "../shared/identity_session.ts";
export { identitySessionKey, identityOwnerKey } from "../shared/identity_session.ts";

export const permissionSessionKey = (config, token) => config.capabilities ? identitySessionKey(config) : `${config.authType}:${token ?? 'anonymous'}`;

export function readerRuntimeEligibility(ready, config, routeName, token) {
  return config.capabilities
    ? ready && !config.setupRequired && routeName !== "login" && config.capabilities.canRead === true
    : permissionEligibility(ready, config, routeName, token);
}

export function permissionEligibility(ready, config, routeName, token) {
  if (config.capabilities) return ready && !config.setupRequired && routeName !== "login" && config.capabilities.canManageVault === true;
  return ready && !config.setupRequired && routeName !== "login" &&
    ([authTypes.none, authTypes.readOnly].includes(config.authType) || !!token);
}

export function permissionWritability(eligible, config) {
  if (config.capabilities) return eligible && config.capabilities.canManageVault === true;
  return eligible && (config.settingsWritable ?? config.authType !== authTypes.readOnly);
}
