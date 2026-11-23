// SPDX-License-Identifier: LGPL-3.0-only
import { authTypes } from "./constants.js";

/** Creation eligibility follows note writability, not the settings-only lock. */
export function canCreateNote(authType) {
  if (typeof authType === "object" && authType !== null) return authType.capabilities?.canEdit === true;
  return authType !== authTypes.readOnly;
}
