// SPDX-License-Identifier: LGPL-3.0-only
/** Projections of committed hub batches. Ordering is index first, facts second. */
import * as path from "@std/path";
import { createUuid } from "../../shared/uuid.ts";
import type { PluginLifecycle } from "../plugins/lifecycle.ts";
import type { Indexer } from "../state.ts";
import type { VaultHub } from "./hub.ts";
import type { ChangeEntry } from "./types.ts";

const notePath = (name: string | null) =>
  name?.endsWith(".md") ? name.slice(0, -3) : null;
export function subscribeIndex(hub: VaultHub, indexer: Indexer): () => void {
  return hub.subscribe((entries) => {
    for (const entry of entries) {
      const current = notePath(entry.path), old = notePath(entry.oldPath);
      if (entry.kind === "renamed" && old !== null) {
        indexer.deleteFromIndex(old);
      }
      if (current === null) continue;
      if (entry.kind === "deleted") indexer.deleteFromIndex(current);
      else indexer.reindexNote(current);
    }
  });
}

/** Preserve the pre-hub local-change hook contract (M1 addendum 1).
 * No content is retained in the hub; current bytes are read at dispatch. */
export function subscribeExternalFacts(
  hub: VaultHub,
  lifecycle: PluginLifecycle,
): () => void {
  return hub.subscribe((entries) => {
    const changed = new Set<string>();
    const publish = (action: "create" | "save" | "delete", name: string) => {
      const current = notePath(name);
      if (current === null) return;
      changed.add(current);
      const content = action === "delete"
        ? null
        : Deno.readTextFileSync(path.join(hub.root, name));
      lifecycle.observe({
        operationId: createUuid(),
        action,
        origin: "external",
        timestamp: new Date().toISOString(),
        path: current,
        before: action === "create"
          ? null
          : { path: current, contentAvailable: false },
        after: action === "delete" ? null : {
          path: current,
          content: content ?? undefined,
          contentAvailable: content !== null,
        },
      });
    };
    const local: ChangeEntry[] = entries.filter((entry) =>
      entry.peer === "local"
    );
    // The retired scan pruned deletions before processing additions/modifications.
    for (const entry of local) {
      if (entry.kind === "deleted" && entry.path) publish("delete", entry.path);
      if (entry.kind === "renamed" && entry.oldPath) {
        publish("delete", entry.oldPath);
      }
    }
    for (const entry of local) {
      if (entry.kind !== "deleted" && entry.path) {
        publish(entry.kind === "modified" ? "save" : "create", entry.path);
      }
    }
    if (changed.size) {
      lifecycle.syncCompleted({
        operationId: createUuid(),
        action: "sync",
        origin: "external",
        timestamp: new Date().toISOString(),
        initial: false,
        changedPaths: [...changed],
      });
    }
  });
}
