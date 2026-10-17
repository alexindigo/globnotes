// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Release identity, read once at startup. The tracked root `VERSION` file is
 * the release version (docs/releasing.md); `GLOBNOTES_REVISION` is the commit
 * a release build was made from. Builds without it are development builds.
 */

export interface AppVersion {
  version: string;
  /** Full commit hash supplied by the build, or null. */
  revision: string | null;
}

const VERSION_PATTERN = /^\d+\.\d+(\.\d+)?$/;
const REVISION_PATTERN = /^[0-9a-f]{7,40}$/;

export function readAppVersion(
  {
    file = new URL("../VERSION", import.meta.url),
    env = Deno.env,
  }: {
    file?: URL | string;
    env?: { get(name: string): string | undefined };
  } = {},
): AppVersion {
  const location = file instanceof URL ? file.pathname : file;
  let content: string;
  try {
    content = Deno.readTextFileSync(file);
  } catch (error) {
    throw new Error(
      `Cannot read the release version file ${location}: ${
        (error as Error).message
      }`,
    );
  }
  const version = content.trim();
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `Invalid release version ${
        JSON.stringify(version)
      } in ${location}: expected MAJOR.MINOR or MAJOR.MINOR.PATCH digits`,
    );
  }
  const revision = env.get("GLOBNOTES_REVISION") ?? "";
  if (revision && !REVISION_PATTERN.test(revision)) {
    throw new Error(
      `Invalid GLOBNOTES_REVISION ${
        JSON.stringify(revision)
      }: expected 7-40 lowercase hexadecimal characters`,
    );
  }
  return { version, revision: revision || null };
}
