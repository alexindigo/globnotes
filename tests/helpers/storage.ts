// SPDX-License-Identifier: LGPL-3.0-only

/** Test fixtures that write through storage directly (setup, unit tests) go
 * through the hub gate, as every server write does (server/hub/gate.ts). No
 * hub is attached: these writes stay fixture writes the scanner observes. */

import { gatePassActive } from "../../server/hub/effects.ts";
import { HubGate } from "../../server/hub/gate.ts";
import type { FileSystemNotes } from "../../server/notes/file_system.ts";

const gate = new HubGate();
const MUTATORS = new Set([
  "create",
  "update",
  "delete",
  "commitCreate",
  "commitUpdate",
  "applyRefsRewrite",
]);

/** Run a storage fixture effect inside a gate pass for `root`. */
export function gated<T>(root: string, effect: () => T): T {
  return gatePassActive() ? effect() : gate.apply([root], "test", [], effect);
}

/** `notes` whose mutators open a gate pass for the whole vault when called
 * outside one (server operations already hold a pass and call through). */
export function gatedNotes(notes: FileSystemNotes): FileSystemNotes {
  return new Proxy(notes, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key === "rewriteRefs") {
        return async (oldPath: string, newPath: string) => {
          const changes = await target.prepareRefsRewrite(oldPath, newPath);
          const result = gated(
            target.storagePath,
            () => target.applyRefsRewrite(changes),
          );
          if (result.failed) {
            throw new Error(
              `reference rewrite failed at '${result.failed.path}'`,
            );
          }
        };
      }
      if (!MUTATORS.has(key as string)) return value.bind(target);
      return (...args: unknown[]) =>
        gated(target.storagePath, () => value.apply(target, args));
    },
  });
}
