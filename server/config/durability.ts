// SPDX-License-Identifier: LGPL-3.0-only
import { logger } from "../logger.ts";

let warningCount = 0;
/** Process diagnostics, not record contents or a claim of rollback. Never retain
 * paths, bytes, credentials, or the underlying filesystem exception. */
export function storedDurabilityStatus() {
  return Object.freeze({ warning: warningCount > 0, warningCount });
}
export function warnStoredDurability(): void {
  warningCount++;
  try {
    logger.warning(
      "Stored state was published; directory durability or cleanup could not be confirmed.",
    );
  } catch {
    // A diagnostic sink cannot turn an already committed operation into failure.
  }
}
