// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Failure evidence for integration tests that retain their fixture data.
 *
 * On failure the test writes everything needed to inspect it into one file
 * beside the retained data (under the run's TMPDIR), prints the file's
 * absolute path and fails immediately — it never holds the process open.
 */

import * as path from "@std/path";

export interface FailureDetails {
  /** The failing test (and step/fixture label, if any). */
  test: string;
  error: unknown;
  /** Retained fixture data, e.g. { vault, state }. The report is written
   * beside the first entry. */
  retained: Record<string, string>;
  /** Server process evidence, when a server was involved. */
  server?: {
    url?: string;
    pid?: number;
    stdout?: string;
    stderr?: string;
  };
}

/** Write the report, print its path and return it. */
export async function writeFailureReport(
  details: FailureDetails,
): Promise<string> {
  const anchor = Object.values(details.retained)[0] ??
    Deno.env.get("TMPDIR") ?? Deno.cwd();
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const file = path.resolve(`${anchor}.failure-${stamp}.txt`);
  const error = details.error instanceof Error
    ? details.error.stack ?? String(details.error)
    : String(details.error);
  const lines = [
    `test: ${details.test}`,
    `time: ${new Date().toISOString()}`,
    `test pid: ${Deno.pid}`,
    ...Object.entries(details.retained).map(([name, location]) =>
      `retained ${name}: ${path.resolve(location)}`
    ),
    ...(details.server
      ? [
        `server url: ${details.server.url ?? "-"}`,
        `server pid: ${details.server.pid ?? "-"}`,
      ]
      : []),
    "",
    "error:",
    error,
    ...(details.server
      ? [
        "",
        "server stdout:",
        details.server.stdout ?? "(not captured)",
        "",
        "server stderr:",
        details.server.stderr ?? "(not captured)",
      ]
      : []),
    "",
  ];
  await Deno.writeTextFile(file, lines.join("\n"));
  console.error(`FAILURE DETAILS: ${file}`);
  return file;
}
