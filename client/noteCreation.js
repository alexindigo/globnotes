// SPDX-License-Identifier: LGPL-3.0-only
/** Creation eligibility follows the vault's note editing capability. */
export function canCreateNote(config) {
  return config?.capabilities?.canEdit === true;
}
