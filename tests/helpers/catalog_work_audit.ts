// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ProcessOwner,
  readRecord,
  waitForRecord,
} from "./process_records.ts";
export function auditInvocation(
  result: Promise<unknown>,
  audit: () => void | Promise<void>,
  recordError: (error: unknown) => void | Promise<void>,
): Promise<void> {
  return result.then(audit).catch(recordError);
}

export async function probeAudit(directory: string, name: string) {
  const failure = await readRecord(`${directory}/invocation-error.json`);
  if (failure) throw Error(String(failure.detail));
  const value = readRecord(`${directory}/${name}.json`);
  if (value) return value;
  const exited = readRecord(`${directory}/server-exit.json`);
  if (exited) {
    throw Error(`Wrapped server exited before ${name}: ${exited.code}`);
  }
  return null;
}

/** Subscribe before probing; error and success are the same terminal-state
 * probe on entry, every event, and child exit. No new invocation timer. */
export async function waitForAudit(
  directory: string,
  name: string,
  exit?: Promise<{ code: number }> | ProcessOwner[],
) {
  const owners = Array.isArray(exit)
    ? exit
    : exit
    ? [{ label: "Native child", exit }]
    : [];
  return await waitForRecord(
    directory,
    name,
    () => probeAudit(directory, name),
    owners,
  );
}
