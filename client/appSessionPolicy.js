// SPDX-License-Identifier: LGPL-3.0-only
import { authTypes } from "./constants.js";

export const permissionSessionKey = (config, token) => `${config.authType}:${token ?? 'anonymous'}`;

export function permissionEligibility(ready, config, routeName, token) {
  return ready && !config.setupRequired && routeName !== "login" &&
    ([authTypes.none, authTypes.readOnly].includes(config.authType) || !!token);
}

export function permissionWritability(eligible, config) {
  return eligible && (config.settingsWritable ?? config.authType !== authTypes.readOnly);
}
