// SPDX-License-Identifier: LGPL-3.0-only

/** Display form of the app version, shared by the server log and the client:
 * `v2.3.2 (85dbf7a)` when the build supplied a revision, `v2.3.2-dev`
 * without one, and "" when no version is known. */
export function formatVersion(
  { version, revision }: { version?: string | null; revision?: string | null },
): string {
  if (!version) return "";
  return revision ? `v${version} (${revision.slice(0, 7)})` : `v${version}-dev`;
}
