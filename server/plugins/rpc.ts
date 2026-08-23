// SPDX-License-Identifier: LGPL-3.0-only

/** ctx back-channel: plugin RPCs resolved against server state. Runs in
 * the HOST process; values cross to the worker via structured clone. */

import { state } from "../state.ts";

export function pluginRpc(
  method: string,
  args: unknown[],
): Promise<unknown> {
  try {
    switch (method) {
      case "search": {
        return Promise.resolve(
          state.indexer ? state.indexer.search(args[0] as string) : [],
        );
      }
      case "readNote": {
        return Promise.resolve(state.notes.get(args[0] as string));
      }
      case "listTitles": {
        return Promise.resolve(state.notes.getTitles());
      }
      case "readFile": {
        const served = state.files.get(args[0] as string);
        return Promise.resolve({
          mediaType: served.mediaType,
          body: served.body,
        });
      }
      default:
        return Promise.reject(new Error(`unknown rpc method '${method}'`));
    }
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}
