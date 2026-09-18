// SPDX-License-Identifier: LGPL-3.0-only

/** ctx back-channel: plugin RPCs resolved against injected vault deps.
 * Runs in the HOST process; values cross to the worker via structured clone. */

import type { FileServing } from "../files/file_serving.ts";
import type { FileSystemNotes } from "../notes/file_system.ts";
import type { RpcHandler } from "./host.ts";
import type { Indexer } from "../state.ts";
import { state } from "../state.ts";

export interface PluginRpcDeps {
  notes: FileSystemNotes;
  indexer: Indexer | null;
  files: FileServing;
  basePath: string;
}

export function makePluginRpc(deps: PluginRpcDeps): RpcHandler {
  return function pluginRpc(
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    try {
      switch (method) {
        case "search": {
          return Promise.resolve(
            deps.indexer ? deps.indexer.search(args[0] as string) : [],
          );
        }
        case "readNote": {
          return Promise.resolve(deps.notes.get(args[0] as string));
        }
        case "listPaths": {
          return Promise.resolve(deps.notes.getPaths());
        }
        case "readFile": {
          const served = deps.files.get(args[0] as string);
          return Promise.resolve({
            mediaType: served.mediaType,
            body: served.body,
          });
        }
        case "pathPrefix": {
          return Promise.resolve(deps.basePath);
        }
        case "resolvePath": {
          const target = (args[0] as string).trim();
          const titles = deps.notes.getPaths();
          if (titles.includes(target)) return Promise.resolve(target);
          const lower = target.toLowerCase();
          const matches = titles
            .filter((t) => t.split("/").pop()!.toLowerCase() === lower)
            .sort();
          if (matches.length > 0) return Promise.resolve(matches[0]);
          return Promise.resolve(
            deps.indexer?.resolveAlias(target) ?? target,
          );
        }
        default:
          return Promise.reject(new Error(`unknown rpc method '${method}'`));
      }
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };
}

/** PATH-only default: resolve against process state after initState(). */
export const pluginRpc: RpcHandler = (method, args) =>
  makePluginRpc({
    notes: state.notes,
    indexer: state.indexer,
    files: state.files,
    basePath: state.config.pathPrefix,
  })(method, args);
