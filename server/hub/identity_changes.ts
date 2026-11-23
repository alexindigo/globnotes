// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { CHANGE_STREAM_HEARTBEAT_MS } from "../../shared/vault_changes.ts";
import type { IdentityStreamAccess } from "../auth/composition.ts";
import { identitySse } from "../auth/identity_sse.ts";
import { browserChange } from "./browser_changes.ts";
import type { DriverSupervisor } from "./drivers/supervisor.ts";
import type { VaultHub } from "./hub.ts";
import type { ChangeEntry } from "./types.ts";

/** One concrete vault's change services; never another vault's globals. */
export interface IdentityChangeServices {
  vaultId: string;
  hub: VaultHub;
  root: string;
  stateRoot: string;
  drivers?(): DriverSupervisor | null;
}

const encoder = new TextEncoder();
const frame = (event: string, data: unknown, id?: number) =>
  `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${
    JSON.stringify(data)
  }\n\n`;
const POLL_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
};
const LIVE_WINDOW = 32;
const STREAM_REPLAY = { maxEntries: 1, maxBytes: 1024 * 1024 };
const anonymized = (e: ChangeEntry) =>
  e.path === null || (e.kind === "renamed" && e.oldPath === null);

/** The hub owns replay. A bounded live window preserves paths on live delete
 * notices, which are scrubbed from durable replay before publication. */
export function createIdentityVaultChanges(
  admit: (request: Request) => Promise<IdentityStreamAccess>,
  services: IdentityChangeServices,
) {
  return async (request: PathfinderRequest): Promise<Response> => {
    const access = await admit(request._raw);
    const { lease } = access;
    if (services.vaultId !== lease.vaultId) {
      throw new HttpError(404, "Vault unavailable.");
    }
    const rawCursor = request.query.get("since") ??
      request._raw.headers.get("last-event-id") ?? "0";
    const cursor = Number(rawCursor);
    if (
      !/^\d+$/.test(rawCursor) || !Number.isSafeInteger(cursor) || cursor < 0
    ) {
      throw new HttpError(400, "Invalid change cursor");
    }
    const hub = services.hub,
      root = services.root,
      stateRoot = Deno.realPathSync(services.stateRoot);
    const project = (entries: ChangeEntry[]) =>
      entries.map((e) => browserChange(e, root, stateRoot)).filter((e) =>
        e !== null
      ).map((entry) => {
        if (access.canManageVault) return entry;
        const { peer: _peer, ...visible } = entry;
        return visible;
      });
    // Driver metadata is administrative; readers never read or subscribe to it.
    const drivers = access.canManageVault ? services.drivers?.() ?? null : null;
    if (
      request.query.get("poll") === "1" ||
      !request._raw.headers.get("accept")?.includes("text/event-stream")
    ) {
      const snapshot = hub.changesSince(cursor), next = hub.sequence();
      const conflictRevision = hub.conflictRevision();
      const driverMetadata = drivers
        ? { driverRevision: drivers.revision() }
        : {};
      const gap = snapshot.gap || cursor > next ||
        snapshot.entries.some(anonymized);
      return new Response(
        lease.body(lease.prepare(
          gap ? { gap: true, next, conflictRevision, ...driverMetadata } : {
            entries: project(snapshot.entries),
            next,
            conflictRevision,
            ...driverMetadata,
          },
        )),
        { headers: POLL_HEADERS },
      );
    }
    let consumed = cursor;
    const live = new Map<number, ChangeEntry>();
    return identitySse(
      request._raw,
      access,
      ["files", "conflicts", "drivers"] as const,
      CHANGE_STREAM_HEARTBEAT_MS,
      () => encoder.encode(": heartbeat\n\n"),
      ({ mark, own }) => {
        if (consumed !== hub.sequence()) mark("files");
        mark("conflicts");
        if (drivers) mark("drivers");
        own(() => {
          const release = hub.subscribe((entries) => {
            if (entries.length + live.size > LIVE_WINDOW) live.clear();
            else {for (const entry of entries) {
                if (entry.seq > consumed) live.set(entry.seq, entry);
              }}
            mark("files");
          });
          return () => {
            live.clear();
            release();
          };
        });
        own(() => hub.subscribeConflicts(() => mark("conflicts")));
        if (drivers) own(() => drivers.subscribe(() => mark("drivers")));
        return (key) => {
          if (key === "conflicts") {
            return encoder.encode(
              frame(key, { revision: hub.conflictRevision() }),
            );
          }
          if (key === "drivers") {
            return drivers &&
                encoder.encode(frame(key, { revision: drivers.revision() })) ||
              undefined;
          }
          const next = hub.sequence();
          if (consumed === next) return;
          const reset = () => {
            consumed = next;
            live.clear();
            return encoder.encode(frame("reset", { next }, next));
          };
          if (consumed > next) return reset();
          const page = hub.changesSince(consumed, STREAM_REPLAY);
          if (page.gap) return reset();
          const entries = page.entries.map((entry) =>
            live.get(entry.seq) ?? entry
          );
          if (entries.some(anonymized)) return reset();
          consumed = entries[0]?.seq ?? next;
          live.delete(consumed);
          if (consumed < next) mark("files");
          return encoder.encode(
            project(entries).map((entry) => frame("change", entry, entry.seq))
              .join(""),
          );
        };
      },
    );
  };
}
