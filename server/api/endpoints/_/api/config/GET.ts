// SPDX-License-Identifier: LGPL-3.0-only

/** GET /_/api/config — server-side config the UI needs at boot.
 * Public by design (the client learns the auth type from it). */

import { state } from "@server/state.ts";

export const auth = false;

export default function (): Record<string, unknown> {
  const c = state.config;
  return {
    setupRequired: c.setupRequired,
    authType: c.authType,
    quickAccessHide: c.quickAccessHide,
    quickAccessTitle: c.quickAccessTitle,
    quickAccessTerm: c.quickAccessTerm,
    quickAccessSort: c.quickAccessSort,
    quickAccessLimit: c.quickAccessLimit,
    autoEnablePlugins: c.autoEnablePlugins,
  };
}
