// SPDX-License-Identifier: LGPL-3.0-only
export function auditInvocation(
  result: Promise<unknown>,
  audit: () => void | Promise<void>,
  recordError: (error: unknown) => void | Promise<void>,
): Promise<void> {
  return result.then(audit).catch(recordError);
}

export async function probeAudit(directory: string, name: string) {
  const read = async (file: string) => {
    try {
      return JSON.parse(await Deno.readTextFile(`${directory}/${file}.json`));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  };
  const failure = await read("invocation-error");
  if (failure) throw Error(failure.detail);
  return await read(name);
}

/** Subscribe before probing; error and success are the same terminal-state
 * probe on entry, every event, and child exit. No new invocation timer. */
export async function waitForAudit(
  directory: string,
  name: string,
  exit?: Promise<{ code: number }>,
) {
  const watcher = Deno.watchFs(directory);
  const observed = (async () => {
    const existing = await probeAudit(directory, name);
    if (existing) return existing;
    for await (const _event of watcher) {
      const terminal = await probeAudit(directory, name);
      if (terminal) return terminal;
    }
    throw Error(`Native audit watcher closed before ${name}`);
  })();
  try {
    return await (exit
      ? Promise.race([
        observed,
        exit.then(async (status) => {
          const terminal = await probeAudit(directory, name);
          if (terminal) return terminal;
          throw Error(`Native child exited before ${name}: ${status.code}`);
        }),
      ])
      : observed);
  } finally {
    watcher.close();
  }
}
