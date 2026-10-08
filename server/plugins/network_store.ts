// SPDX-License-Identifier: LGPL-3.0-only

/** Host-owned approval ledger. Plugin SDK writers receive request methods only. */
import * as path from "@std/path";
import {
  PLUGIN_LIMITS,
  PluginContractError,
  pluginId,
  record,
} from "./contracts.ts";
import type { PersistenceAdapters } from "./data.ts";
import {
  canonicalScopes,
  equalSource,
  NETWORK_LIMITS,
  type PermissionControls,
  type PermissionDeclaration,
  permissionKind,
  permissionReason,
  type PermissionRequest,
  permissionRevision,
  permissionSource,
  type Scope,
  scopesCover,
  type Source,
  unionScopes,
} from "./network_contracts.ts";

export interface NetworkRecord {
  schemaVersion: 1;
  revision: number;
  allowNetwork: boolean;
  approvedNetwork: Scope[];
  approvedImports: Scope[];
  source: Source | null;
  contributors: Partial<Record<"service" | "render", PermissionDeclaration>>;
  requests: PermissionRequest[];
}
export interface NetworkSnapshot {
  record: NetworkRecord;
  signature: string;
  raw: string | null;
}
export interface SourceIdentity {
  key: string;
  codeFingerprint: string;
  settingsRevision: number;
}
export interface PreparedNetworkSource {
  readonly owner: NetworkOwner;
  readonly before: NetworkSnapshot;
  readonly identity: SourceIdentity;
  readonly source: Source;
  readonly next: NetworkRecord;
}
export interface NetworkOwner {
  id: string;
  source(): Promise<SourceIdentity>;
  staticRequests(): PermissionDeclaration;
}
export interface NetworkStoreAdapters extends PersistenceAdapters {
  /** Called synchronously after replacement, inside the host commit gate. */
  committed?(owner: NetworkOwner, current: NetworkRecord): void;
  /** A legacy read-only manager can observe metadata without admitting writes. */
  sourceDurable?(): boolean;
}
const writers = new Map<string, Promise<unknown>>();
async function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const result = (writers.get(key) ?? Promise.resolve()).catch(() => undefined)
    .then(task);
  writers.set(key, result);
  try {
    return await result;
  } finally {
    if (writers.get(key) === result) writers.delete(key);
  }
}
function conflict(
  detail: string,
  code = "permission_revision_conflict",
): never {
  throw new PluginContractError(409, code, detail);
}
function canonicalRoot(input: string): string {
  try {
    return Deno.realPathSync(input);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const parent = path.dirname(input);
    if (parent === input) throw error;
    return path.join(canonicalRoot(parent), path.basename(input));
  }
}
async function signature(raw: string | null): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      raw === null ? "absent-plugin-network-v1" : `present:${raw}`,
    ),
  );
  return [...new Uint8Array(hash)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
function empty(): NetworkRecord {
  return {
    schemaVersion: 1,
    revision: 0,
    allowNetwork: false,
    approvedNetwork: [],
    approvedImports: [],
    source: null,
    contributors: {},
    requests: [],
  };
}
function declaration(value: unknown): PermissionDeclaration {
  const raw = record(value, "permission declaration");
  if (Object.keys(raw).some((key) => !["network", "imports"].includes(key))) {
    throw new PluginContractError(
      422,
      "invalid_permission_declaration",
      "declarations contain network and imports requests only",
    );
  }
  return {
    network: canonicalScopes(raw.network ?? false),
    imports: canonicalScopes(raw.imports ?? false),
  };
}
function validated(value: unknown, id: string): NetworkRecord {
  const raw = record(value, "permission ledger");
  if (raw.schemaVersion !== 1) {
    conflict(
      "unsupported permission ledger schema; original bytes retained",
      "permission_state_unsupported",
    );
  }
  try {
    if (
      typeof raw.allowNetwork !== "boolean" || !Array.isArray(raw.requests) ||
      raw.requests.length > NETWORK_LIMITS.requests ||
      Object.keys(raw).some((key) =>
        ![
          "schemaVersion",
          "revision",
          "allowNetwork",
          "approvedNetwork",
          "approvedImports",
          "source",
          "contributors",
          "requests",
        ].includes(key)
      )
    ) throw new Error("invalid ledger");
    const contributors = record(raw.contributors, "permission contributors");
    if (
      Object.keys(contributors).some((key) =>
        !["service", "render"].includes(key)
      )
    ) throw new Error("invalid contributor");
    const requests = raw.requests.map((value) => {
      const request = record(value, "permission request");
      if (
        request.pluginId !== id || typeof request.id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(request.id) ||
        !["pending", "approved", "denied", "revoked", "obsolete"].includes(
          String(request.state),
        ) ||
        Object.keys(request).some((key) =>
          !["id", "pluginId", "source", "kind", "scopes", "reason", "state"]
            .includes(key)
        )
      ) throw new Error("invalid request");
      return {
        id: request.id,
        pluginId: id,
        source: permissionSource(request.source),
        kind: permissionKind(request.kind),
        scopes: canonicalScopes(request.scopes),
        reason: permissionReason(request.reason),
        state: request.state,
      } as PermissionRequest;
    });
    if (
      new Set(requests.map((request) => request.id)).size !== requests.length
    ) throw new Error("duplicate request identity");
    return {
      schemaVersion: 1,
      revision: permissionRevision(raw.revision),
      allowNetwork: raw.allowNetwork,
      approvedNetwork: canonicalScopes(raw.approvedNetwork),
      approvedImports: canonicalScopes(raw.approvedImports),
      source: raw.source === null ? null : permissionSource(raw.source),
      contributors: Object.fromEntries(
        Object.entries(contributors).map((
          [key, value],
        ) => [key, declaration(value)]),
      ),
      requests,
    };
  } catch {
    conflict(
      "invalid permission ledger; original bytes retained",
      "permission_state_corrupt",
    );
  }
}
export function requestedScopes(
  staticRequests: PermissionDeclaration,
  current: NetworkRecord,
): PermissionDeclaration {
  const active = current.requests.filter((request) =>
    request.state !== "obsolete" && current.source &&
    equalSource(request.source, current.source)
  );
  return {
    network: unionScopes(
      staticRequests.network,
      ...Object.values(current.contributors).map((source) => source.network),
      ...active.filter((request) => request.kind === "network").map((request) =>
        request.scopes
      ),
    ),
    imports: unionScopes(
      staticRequests.imports,
      ...Object.values(current.contributors).map((source) => source.imports),
      ...active.filter((request) => request.kind === "imports").map((request) =>
        request.scopes
      ),
    ),
  };
}
function retiredRecord(before: NetworkRecord, source: Source): NetworkRecord {
  return {
    ...structuredClone(before),
    revision: permissionRevision(before.revision + 1),
    source,
    contributors: {},
    requests: before.requests.map((request) => ({
      ...request,
      state: "obsolete" as const,
    })),
  };
}

export class PluginNetworkStore {
  private readonly root: string;
  private readonly observedSources = new Map<string, Source>();
  constructor(
    statePath: string,
    private readonly adapters: NetworkStoreAdapters,
  ) {
    this.root = canonicalRoot(path.resolve(statePath));
  }
  private file(id: string): string {
    pluginId(id);
    let result = this.root;
    for (const name of ["plugin-network", `${id}.json`]) {
      result = path.join(result, name);
      try {
        if (Deno.lstatSync(result).isSymlink) {
          throw new PluginContractError(
            403,
            "permission_namespace_denied",
            "permission ledger paths cannot be symlinks",
          );
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return result;
  }
  private raw(id: string): string | null {
    const file = this.file(id);
    try {
      if (Deno.statSync(file).size > PLUGIN_LIMITS.controlBytes) {
        throw new PluginContractError(
          413,
          "permission_state_too_large",
          "permission ledger exceeds the control limit; original bytes retained",
        );
      }
      return Deno.readTextFileSync(file);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }
  async read(id: string): Promise<NetworkSnapshot> {
    const raw = this.raw(id);
    let current = empty();
    if (raw !== null) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        conflict(
          "malformed permission ledger; original bytes retained",
          "permission_state_corrupt",
        );
      }
      current = validated(value, id);
    }
    return { record: current, signature: await signature(raw), raw };
  }
  /** Prepare future settings-source retirement without publishing or taking a
   * ledger writer. The data namespace may remain reserved across publication. */
  async prepareSourceTransition(
    owner: NetworkOwner,
    identity: SourceIdentity,
  ): Promise<PreparedNetworkSource> {
    const before = await this.read(owner.id);
    const previous = before.record.source ?? this.observedSources.get(owner.id);
    const source = permissionSource({
      ...identity,
      revision: previous?.key === identity.key
        ? previous.revision
        : permissionRevision((previous?.revision ?? 0) + 1),
    });
    return {
      owner,
      before,
      identity,
      source,
      next: retiredRecord(before.record, source),
    };
  }
  /** Pure synchronous namespace/byte validation under the shared host gate. */
  validatePreparedSource(prepared: PreparedNetworkSource): void {
    this.file(prepared.owner.id);
    if (this.raw(prepared.owner.id) !== prepared.before.raw) {
      conflict("permission ledger changed before settings effect");
    }
  }
  async publishSourceTransition(
    prepared: PreparedNetworkSource,
  ): Promise<NetworkSnapshot & { source: Source }> {
    return await serialize(this.file(prepared.owner.id), async () => {
      const current = await this.read(prepared.owner.id);
      const identity = await prepared.owner.source();
      if (
        identity.key !== prepared.identity.key ||
        identity.codeFingerprint !== prepared.identity.codeFingerprint ||
        identity.settingsRevision !== prepared.identity.settingsRevision
      ) {
        conflict(
          "committed settings source changed before ledger publication",
          "permission_source_conflict",
        );
      }
      // A concurrent normal reader may already have published this exact
      // source; accept it without erasing any newer same-source decisions.
      if (
        current.record.source &&
        equalSource(current.record.source, prepared.source)
      ) return { ...current, source: current.record.source };
      if (current.raw !== prepared.before.raw) {
        conflict(
          "permission ledger changed before settings-source publication",
        );
      }
      await this.replace(
        prepared.owner,
        current,
        prepared.next,
        prepared.identity,
        () => true,
      );
      this.observedSources.set(prepared.owner.id, prepared.source);
      return { ...await this.read(prepared.owner.id), source: prepared.source };
    });
  }
  private async replace(
    owner: NetworkOwner,
    before: NetworkSnapshot,
    next: NetworkRecord,
    source: SourceIdentity,
    current: () => boolean,
  ): Promise<void> {
    const file = this.file(owner.id);
    const bytes = new TextEncoder().encode(
      JSON.stringify(next, null, 2) + "\n",
    );
    if (bytes.length > PLUGIN_LIMITS.controlBytes) {
      throw new PluginContractError(
        413,
        "permission_state_too_large",
        "permission ledger exceeds the control limit",
      );
    }
    await Deno.mkdir(path.dirname(file), { recursive: true });
    this.file(owner.id);
    const temporary = await Deno.makeTempFile({
      dir: path.dirname(file),
      prefix: ".permission-",
    });
    let failed = false;
    let failure: unknown;
    try {
      const handle = await Deno.open(temporary, { write: true });
      try {
        let offset = 0;
        while (offset < bytes.length) {
          offset += await handle.write(bytes.subarray(offset));
        }
        await handle.sync();
      } finally {
        handle.close();
      }
      await this.adapters.commit(async () => {
        const latestSource = await owner.source();
        if (
          !current() || latestSource.key !== source.key ||
          latestSource.codeFingerprint !== source.codeFingerprint ||
          latestSource.settingsRevision !== source.settingsRevision
        ) {
          conflict(
            "permission request source changed before commit",
            "permission_source_conflict",
          );
        }
        if (this.raw(owner.id) !== before.raw) {
          conflict("permission ledger changed during persistence");
        }
        // Final namespace/content check and effect are synchronous under the host gate.
        this.file(owner.id);
        Deno.renameSync(temporary, file);
        this.adapters.committed?.(owner, next);
      });
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await Deno.remove(temporary);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        failure = failed
          ? new AggregateError(
            [failure, error],
            "permission write and temporary-file cleanup failed",
          )
          : error;
        failed = true;
      }
    }
    if (failed) throw failure;
  }
  /** Source changes retire request snapshots, never remembered operator approvals. */
  async synchronize(
    owner: NetworkOwner,
  ): Promise<NetworkSnapshot & { source: Source }> {
    return await serialize(this.file(owner.id), async () => {
      const before = await this.read(owner.id), identity = await owner.source();
      const previous = before.record.source ??
        this.observedSources.get(owner.id);
      if (
        previous && previous.key === identity.key &&
        previous.codeFingerprint === identity.codeFingerprint &&
        previous.settingsRevision === identity.settingsRevision
      ) {
        if (before.record.source || this.adapters.sourceDurable?.() === false) {
          return { ...before, source: previous };
        }
      }
      const source = permissionSource({
        ...identity,
        revision: previous?.key === identity.key
          ? previous.revision
          : permissionRevision((previous?.revision ?? 0) + 1),
      });
      this.observedSources.set(owner.id, source);
      if (!before.record.source && this.adapters.sourceDurable?.() === false) {
        return { ...before, source };
      }
      const next = retiredRecord(before.record, source);
      await this.replace(owner, before, next, identity, () => true);
      return { ...await this.read(owner.id), source };
    });
  }
  private async mutate<T>(
    owner: NetworkOwner,
    source: Source,
    current: () => boolean,
    change: (next: NetworkRecord, before: NetworkSnapshot) => T,
  ): Promise<{ snapshot: NetworkSnapshot; value: T }> {
    return await serialize(this.file(owner.id), async () => {
      const before = await this.read(owner.id), identity = await owner.source();
      const actual: Source = before.record.source ??
        this.observedSources.get(owner.id) ??
        { ...identity, revision: 1 };
      if (
        !current() || !equalSource(actual, source) ||
        identity.key !== source.key ||
        identity.codeFingerprint !== source.codeFingerprint ||
        identity.settingsRevision !== source.settingsRevision
      ) {
        conflict(
          "permission source token is obsolete",
          "permission_source_conflict",
        );
      }
      const next = structuredClone(before.record);
      next.source = permissionSource(source);
      const value = change(next, before);
      if (JSON.stringify(next) === JSON.stringify(before.record)) {
        return { snapshot: before, value };
      }
      next.revision = permissionRevision(next.revision + 1);
      await this.replace(owner, before, next, identity, current);
      return { snapshot: await this.read(owner.id), value };
    });
  }
  async declare(
    owner: NetworkOwner,
    contributor: "service" | "render",
    source: Source,
    current: () => boolean,
    input: unknown,
  ) {
    const snapshot = declaration(input);
    return await this.mutate(owner, source, current, (next) => {
      const previous = next.contributors[contributor];
      if (previous && JSON.stringify(previous) !== JSON.stringify(snapshot)) {
        conflict(
          "divergent complete declaration for the same contributor/source",
          "permission_runtime_conflict",
        );
      }
      next.contributors[contributor] = snapshot;
    });
  }
  async requestAccess(
    owner: NetworkOwner,
    source: Source,
    current: () => boolean,
    input: unknown,
  ) {
    const raw = record(input, "permission access request");
    if (
      Object.keys(raw).some((key) => !["kind", "hosts", "reason"].includes(key))
    ) {
      throw new PluginContractError(
        422,
        "invalid_permission_request",
        "unsupported access request property",
      );
    }
    const kind = permissionKind(raw.kind),
      scopes = canonicalScopes(raw.hosts),
      reason = permissionReason(raw.reason);
    if (!scopes.length) {
      throw new PluginContractError(
        422,
        "invalid_permission_request",
        "access requests must include a scope",
      );
    }
    return await this.mutate(owner, source, current, (next) => {
      const previous = next.requests.find((request) =>
        equalSource(request.source, source) && request.kind === kind &&
        JSON.stringify(request.scopes) === JSON.stringify(scopes)
      );
      if (previous) return previous.id;
      if (next.requests.length >= NETWORK_LIMITS.requests) {
        throw new PluginContractError(
          503,
          "permission_requests_full",
          "permission request ledger is full",
        );
      }
      const approved = kind === "network"
        ? next.approvedNetwork
        : next.approvedImports;
      const request: PermissionRequest = {
        id: crypto.randomUUID(),
        pluginId: owner.id,
        source,
        kind,
        scopes,
        reason,
        state: scopes.every((scope) => scopesCover(approved, scope))
          ? "approved"
          : "pending",
      };
      next.requests.push(request);
      return request.id;
    });
  }
  async controls(
    owner: NetworkOwner,
    source: Source,
    input: unknown,
    decision?: { requestId: string },
    settingsGuard?: () => void,
  ) {
    const raw = record(input, "permission controls");
    const keys = [
      "revision",
      "signature",
      "requestSourceKey",
      "requestSourceRevision",
      "allowNetwork",
      "approvedNetwork",
      "approvedImports",
      ...decision ? ["decision"] : [],
    ];
    if (
      Object.keys(raw).some((key) => !keys.includes(key)) ||
      typeof raw.allowNetwork !== "boolean" ||
      typeof raw.signature !== "string" ||
      typeof raw.requestSourceKey !== "string"
    ) {
      throw new PluginContractError(
        422,
        "invalid_permission_controls",
        "invalid permission control envelope",
      );
    }
    const controls: PermissionControls = {
      revision: permissionRevision(raw.revision),
      signature: raw.signature,
      requestSourceKey: raw.requestSourceKey,
      requestSourceRevision: permissionRevision(raw.requestSourceRevision),
      allowNetwork: raw.allowNetwork,
      approvedNetwork: canonicalScopes(raw.approvedNetwork),
      approvedImports: canonicalScopes(raw.approvedImports),
    };
    if (decision && raw.decision !== "approve" && raw.decision !== "deny") {
      throw new PluginContractError(
        422,
        "invalid_permission_decision",
        "decision must be approve or deny",
      );
    }
    return await this.mutate(owner, source, () => {
      settingsGuard?.();
      return true;
    }, (next, before) => {
      if (
        controls.revision !== before.record.revision ||
        controls.signature !== before.signature
      ) {
        conflict(
          "permission controls changed; review the current ledger before retrying",
        );
      }
      if (
        controls.requestSourceKey !== source.key ||
        controls.requestSourceRevision !== source.revision
      ) {
        conflict(
          "permission request source changed",
          "permission_source_conflict",
        );
      }
      const request = decision
        ? next.requests.find((request) => request.id === decision.requestId)
        : undefined;
      if (
        decision &&
        (!request || !equalSource(request.source, source) ||
          request.state === "obsolete")
      ) {
        conflict(
          "permission request is obsolete or unavailable",
          "permission_request_conflict",
        );
      }
      if (decision && raw.decision === "deny") {
        request!.state = "denied";
        return;
      }
      const requested = requestedScopes(owner.staticRequests(), next);
      for (
        const [kind, selected, remembered] of [
          ["network", controls.approvedNetwork, next.approvedNetwork],
          ["imports", controls.approvedImports, next.approvedImports],
        ] as const
      ) {
        for (const scope of selected) {
          if (
            !remembered.some((previous) =>
              JSON.stringify(previous) === JSON.stringify(scope)
            ) && !scopesCover(requested[kind], scope)
          ) {
            throw new PluginContractError(
              422,
              "permission_not_requested",
              "new approval is not covered by current requested intent",
            );
          }
        }
      }
      if (
        request && !request.scopes.every((scope) =>
          scopesCover(
            request.kind === "network"
              ? controls.approvedNetwork
              : controls.approvedImports,
            scope,
          )
        )
      ) {
        throw new PluginContractError(
          422,
          "permission_request_unapproved",
          "approve must explicitly cover the request scopes",
        );
      }
      next.allowNetwork = controls.allowNetwork;
      next.approvedNetwork = controls.approvedNetwork;
      next.approvedImports = controls.approvedImports;
      for (const request of next.requests) {
        if (
          !equalSource(request.source, source) || request.state === "obsolete"
        ) continue;
        const grants = request.kind === "network"
          ? next.approvedNetwork
          : next.approvedImports;
        if (request.scopes.every((scope) => scopesCover(grants, scope))) {
          request.state = "approved";
        } else if (request.state === "approved") request.state = "revoked";
      }
    });
  }
}
