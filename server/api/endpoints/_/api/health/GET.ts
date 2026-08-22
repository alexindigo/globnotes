// SPDX-License-Identifier: LGPL-3.0-only

/** GET /_/api/health — healthcheck. Deliberately unauthenticated,
 * same as the Python server. */

export const auth = false;

export default function (): string {
  return "OK";
}
