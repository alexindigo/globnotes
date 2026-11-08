// SPDX-License-Identifier: LGPL-3.0-only
import { createHash } from "node:crypto";
import { LogFollower } from "../hub/follower.ts";
import type { VaultHub } from "../hub/hub.ts";
import type { PluginManifest } from "./manifest.ts";
import { readGrantCovers, resolveGrantedPath } from "./lifecycle.ts";
import { PluginContractError } from "./contracts.ts";
import type { PluginHost } from "./host.ts";
import type { FollowerStatus } from "../hub/follower.ts";

/** Anonymous replay cannot be classified under a narrow pathname grant. */
export function changesAuthority(
  manifest: PluginManifest,
  hub: VaultHub,
): string {
  if (!readGrantCovers(manifest, hub.root, hub.stateRoot, hub.root)) {
    throw new PluginContractError(
      403,
      "changes_read_grant_required",
      "log subscriptions require a canonical whole-vault read grant",
    );
  }
  const roots = manifest.capabilities.read.map((grant) =>
    resolveGrantedPath(hub.root, grant === "vault" ? hub.root : grant, [grant])
  ).sort();
  return createHash("sha256").update(JSON.stringify({
    root: hub.root,
    state: hub.stateRoot,
    roots,
  })).digest("hex");
}

/** One follower belongs to one current service owner, never a message-selected id. */
export function followPluginChanges(options: {
  manifest: PluginManifest;
  hub: VaultHub;
  host: PluginHost;
  current(): boolean;
  changed(status: FollowerStatus): void;
}): LogFollower {
  const { manifest, hub, host } = options;
  const generation = host.generation!;
  const handler = [...host.registrations].find(([, r]) => r.kind === "changes")
    ?.[0];
  if (!handler) throw new Error("changes subscription is unavailable");
  const current = () =>
    options.current() && host.available &&
    host.generation === generation && host.registrations.has(handler);
  return new LogFollower({
    hub,
    get authorityKey() {
      return changesAuthority(manifest, hub);
    },
    cursor: {
      load: () => hub.store.pluginCursor(manifest.id),
      commit: (expected, next) =>
        current() &&
        hub.store.advancePluginCursor(manifest.id, expected, next),
      reset: (expected, next) =>
        current() && hub.store.resetPluginCursor(manifest.id, expected, next),
    },
    current,
    deliver: (_packet, disclose) =>
      host.invoke(handler, [], false, host.limits.serviceCallMs, {
        generation,
        prepareArgs: () => {
          if (!current()) throw new Error("changes owner retired");
          return [disclose()];
        },
      }),
    changed: options.changed,
  });
}
