// SPDX-License-Identifier: LGPL-3.0-only
export type DurabilityEvent = { kind: string; file: string; source?: string };
/** Real fsyncs and effects, with an optional one-shot directory failure. */
export function observeDurability(
  run: (
    events: DurabilityEvent[],
    failDirectory: (file: string) => void,
  ) => void,
): void {
  const open = Deno.openSync,
    mkdir = Deno.mkdirSync,
    link = Deno.linkSync,
    rename = Deno.renameSync;
  const events: DurabilityEvent[] = [];
  let denied: string | undefined;
  try {
    Deno.openSync = ((file, options) => {
      const handle = open(file, options), sync = handle.syncSync.bind(handle);
      handle.syncSync = () => {
        const directory = handle.statSync().isDirectory;
        events.push({
          kind: directory ? "directory" : "file",
          file: String(file),
        });
        if (directory && String(file) === denied) {
          denied = undefined;
          throw new Deno.errors.PermissionDenied(
            "fixture directory fsync failure",
          );
        }
        sync();
      };
      return handle;
    }) as typeof open;
    Deno.mkdirSync = ((file, options) => {
      mkdir(file, options);
      events.push({ kind: "mkdir", file: String(file) });
    }) as typeof mkdir;
    Deno.linkSync = (from, to) => {
      link(from, to);
      events.push({ kind: "link", file: String(to), source: String(from) });
    };
    Deno.renameSync = (from, to) => {
      rename(from, to);
      events.push({ kind: "rename", file: String(to), source: String(from) });
    };
    run(events, (file) => {
      denied = file;
    });
  } finally {
    Deno.openSync = open;
    Deno.mkdirSync = mkdir;
    Deno.linkSync = link;
    Deno.renameSync = rename;
  }
}
