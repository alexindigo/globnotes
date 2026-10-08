// SPDX-License-Identifier: LGPL-3.0-only

/** ctx back-channel: plugin RPCs resolved against server state. Runs in
 * the HOST process; values cross to the worker via structured clone. */

import { state } from "../state.ts";
import type { PluginActions } from "./actions.ts";
import type { RpcAuthority } from "./host.ts";
import { readGrantCovers, resolveGrantedPath } from "./lifecycle.ts";
import type { PluginManifest } from "./manifest.ts";
import { readManagedFile } from "../notes/operations.ts";

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
      case "listPaths": {
        return Promise.resolve(state.notes.getPaths());
      }
      case "readFile": {
        const served = state.files.get(args[0] as string);
        return Promise.resolve({
          mediaType: served.mediaType,
          body: served.body,
        });
      }
      case "pathPrefix": {
        return Promise.resolve(state.config.pathPrefix);
      }
      case "resolvePath": {
        // Obsidian resolution order: exact title → basename match → alias.
        const target = (args[0] as string).trim();
        const titles = state.notes.getPaths();
        if (titles.includes(target)) return Promise.resolve(target);
        const lower = target.toLowerCase();
        const matches = titles
          .filter((t) => t.split("/").pop()!.toLowerCase() === lower)
          .sort();
        if (matches.length > 0) return Promise.resolve(matches[0]);
        return Promise.resolve(state.indexer?.resolveAlias(target) ?? target);
      }
      default:
        return Promise.reject(new Error(`unknown rpc method '${method}'`));
    }
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

export interface ServiceRpcDeps {
  vaultPath: string;
  statePath: string;
  actions(): PluginActions | null;
}

interface ReadRpcDeps {
  vaultPath: string;
  statePath: string;
}
const readMethods = new Set([
  "search",
  "readNote",
  "listPaths",
  "readFile",
  "files.read",
  "pathPrefix",
  "resolvePath",
]);
/** Shared result projection; exact → basename → alias ordering holds within eligible notes. */
function projectedRead(
  deps: ReadRpcDeps,
  manifest: PluginManifest,
  method: string,
  args: unknown[],
  role: "render" | "service",
): unknown {
  const covers = (target: string) =>
    readGrantCovers(manifest, deps.vaultPath, deps.statePath, target);
  const eligible = (note: string) => covers(note + ".md");
  const check = (target: string) => {
    if (!covers(target)) {
      throw new Error("path is outside the plugin's declared read grants");
    }
  };
  switch (method) {
    case "search":
      return (state.indexer?.search(args[0] as string) ?? []).filter((entry) =>
        eligible(entry.path)
      );
    case "readNote":
      check((args[0] as string) + ".md");
      return state.notes.get(args[0] as string);
    case "listPaths":
      return state.notes.getPaths().filter(eligible);
    case "readFile":
    case "files.read": {
      check(args[0] as string);
      if (role === "service") {
        return readManagedFile(
          resolveGrantedPath(
            deps.vaultPath,
            args[0] as string,
            manifest.capabilities.read,
          ),
        );
      }
      const served = state.files.get(args[0] as string);
      return { mediaType: served.mediaType, body: served.body };
    }
    case "pathPrefix":
      return state.config.pathPrefix;
    case "resolvePath": {
      const target = (args[0] as string).trim(),
        titles = state.notes.getPaths().filter(eligible);
      if (titles.includes(target)) return target;
      const lower = target.toLowerCase();
      const matches = titles.filter((title) =>
        title.split("/").pop()!.toLowerCase() === lower
      ).sort();
      if (matches.length) return matches[0];
      return state.indexer?.resolveAlias(target, eligible) ?? target;
    }
    default:
      throw new Error(`unknown rpc method '${method}'`);
  }
}

/** The owning manager binds roots before any renderer is constructed. */
export function renderPluginRpc(deps: ReadRpcDeps) {
  return (
    manifest: PluginManifest,
    method: string,
    args: unknown[],
  ): Promise<unknown> => {
    try {
      return Promise.resolve(
        projectedRead(deps, manifest, method, args, "render"),
      );
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };
}

/** Grant-checked service-worker facade. The host binds plugin identity and
 * generation; caller-supplied IDs can never select another namespace.
 * Read grants are checked on RESULTS (paths, snippets, file bodies), not
 * only raw file calls. Credentials never enter these payloads. */
export function servicePluginRpc(
  deps: ServiceRpcDeps,
): (
  manifest: PluginManifest,
  method: string,
  args: unknown[],
  authority: RpcAuthority,
) => Promise<unknown> {
  return (manifest, method, args, authority): Promise<unknown> => {
    try {
      if (readMethods.has(method)) {
        return Promise.resolve(
          projectedRead(deps, manifest, method, args, "service"),
        );
      }
      switch (method) {
        case "actions.request": {
          const actions = deps.actions();
          if (!actions) throw new Error("action queue unavailable");
          return Promise.resolve(
            actions.request(manifest, args[0] as string, args[1], {
              pluginId: manifest.id,
              generation: authority.generation,
              causalParent: authority.causal?.parentId,
              causalDepth: authority.causal?.depth ?? 0,
              current: authority.generationCurrent,
              release: authority.release,
              generationRetired: authority.generationRetired,
            }),
          );
        }
        case "files.requestWrite": {
          const actions = deps.actions();
          if (!actions) throw new Error("action queue unavailable");
          return Promise.resolve(
            actions.request(manifest, "file-write", {
              path: args[0],
              bytes: args[1],
            }, {
              pluginId: manifest.id,
              generation: authority.generation,
              causalParent: authority.causal?.parentId,
              causalDepth: authority.causal?.depth ?? 0,
              current: authority.generationCurrent,
              release: authority.release,
              generationRetired: authority.generationRetired,
            }),
          );
        }
        case "actions.result": {
          const actions = deps.actions();
          if (!actions) throw new Error("action queue unavailable");
          return Promise.resolve(
            actions.result(
              manifest.id,
              authority.generation,
              args[0] as string,
            ),
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
