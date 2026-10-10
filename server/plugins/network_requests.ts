// SPDX-License-Identifier: LGPL-3.0-only

/** Vault-owned request/approval service. HTTP and Worker facades share one projection. */
import * as path from "@std/path";
import { PluginContractError, record, type SettingsPage } from "./contracts.ts";
import {
  assertSettingsSchemaCurrent,
  validateSettingsPages,
} from "./settings.ts";
import {
  type PersistenceAdapters,
  PluginDataStore,
  type PreparedSettingsCommit,
  type SettingsCommitChange,
} from "./data.ts";
import type { RpcAuthority } from "./host.ts";
import { pluginCodePath, type PluginManifest } from "./manifest.ts";
import {
  type AccessAdmission,
  type BlockedReason,
  canonicalScopes,
  equalSource,
  type PermissionDeclaration,
  type PermissionRow,
  permissionSource,
  type PermissionView,
  scopeCovers,
  scopesCover,
  type Source,
  unionScopes,
} from "./network_contracts.ts";
import {
  effectiveScopes,
  permissionFingerprint,
} from "./network_permissions.ts";
import {
  effectiveSourceKey,
  installedSettingsFingerprint,
  type SettingsContext,
} from "./settings_environment.ts";
import {
  type NetworkOwner,
  type NetworkRecord,
  PluginNetworkStore,
  requestedScopes,
} from "./network_store.ts";

export interface NetworkPlugin {
  id: string;
  dir: string;
  manifest?: PluginManifest;
  browserComponents: ("editor" | "runtime")[];
}
export interface NetworkPolicy {
  source: Source;
  effective: PermissionDeclaration;
  fingerprint: string;
}
/** Captured owner intent; implementations fence now and admit bounded recovery
 * later without awaiting Worker startup or using explicit source replacement. */
export interface SettingsOwnerRecovery {
  validate(): void;
  fence(): void;
  admit(): Promise<void>;
}
export interface NetworkAdapters extends PersistenceAdapters {
  plugins(): NetworkPlugin[];
  changed(): void;
  /** Synchronous reduction fencing, then asynchronous replacement of this ID only. */
  revokeReduced(id: string, effective: PermissionDeclaration): void;
  reload(id: string, policy: NetworkPolicy): Promise<void>;
  sourceDurable?(): boolean;
  activeSources?(id: string): Source[];
  captureSettingsRecovery?(
    id: string,
    policy: NetworkPolicy,
  ): SettingsOwnerRecovery;
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(hash)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
export function settingsSourceKey(
  id: string,
  codeFingerprint: string,
  settingsRevision: number,
  overrideFingerprint?: string,
): Promise<string> {
  return digest(
    new TextEncoder().encode(
      JSON.stringify({
        pluginId: id,
        codeFingerprint,
        settingsRevision,
        ...(overrideFingerprint === undefined ? {} : { overrideFingerprint }),
      }),
    ),
  );
}
/** Actual installed contents, not manifest.version; no plugin module is executed. */
export async function installedCodeFingerprint(dir: string): Promise<string> {
  const root = Deno.realPathSync(dir),
    rows: { path: string; hash: string; target?: string }[] = [];
  const visited = new Set<string>();
  async function visit(relative = "") {
    const directory = relative ? pluginCodePath(root, relative) : root;
    if (visited.has(directory)) {
      throw new PluginContractError(
        409,
        "permission_source_invalid",
        "plugin code contains a directory cycle",
      );
    }
    visited.add(directory);
    for (
      const entry of [...Deno.readDirSync(directory)].sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    ) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = pluginCodePath(root, name), info = Deno.statSync(file);
      if (info.isDirectory) await visit(name);
      else if (info.isFile) {
        rows.push({
          path: name,
          hash: await digest(await Deno.readFile(file)),
          ...(entry.isSymlink
            ? { target: Deno.readLinkSync(path.join(root, name)) }
            : {}),
        });
      } else {throw new PluginContractError(
          409,
          "permission_source_invalid",
          "plugin code contains an unsupported entry",
        );}
    }
    visited.delete(directory);
  }
  await visit();
  return await digest(new TextEncoder().encode(JSON.stringify(rows)));
}
function staticRequests(plugin: NetworkPlugin): PermissionDeclaration {
  const capabilities = plugin.manifest?.capabilities;
  return {
    network: canonicalScopes(capabilities?.network ?? false),
    imports: canonicalScopes(
      capabilities?.imports ?? capabilities?.network ?? false,
    ),
  };
}
function effective(
  current: NetworkRecord,
  requested: PermissionDeclaration,
): PermissionDeclaration {
  return {
    network: effectiveScopes(
      "network",
      current.allowNetwork,
      requested.network,
      current.approvedNetwork,
    ),
    imports: effectiveScopes(
      "imports",
      current.allowNetwork,
      requested.imports,
      current.approvedImports,
    ),
  };
}
function blocked(
  requested: boolean,
  approved: boolean,
  enabled: boolean,
  delegable: boolean,
): BlockedReason[] {
  return [
    ...!requested ? ["not-requested" as const] : [],
    ...!approved ? ["unapproved" as const] : [],
    ...!enabled ? ["master-off" as const] : [],
    ...requested && approved && enabled && !delegable
      ? ["parent-unavailable" as const]
      : [],
  ];
}

export class PluginNetworkRequests {
  readonly store: PluginNetworkStore;
  private readonly reloads = new Map<string, PermissionView["reload"]>();
  private readonly replacements = new Map<
    string,
    { id: string; fingerprint: string; source: Source }
  >();
  private readonly settingsRecoveries = new Map<
    string,
    { source: Source; recovery: SettingsOwnerRecovery; started: boolean }
  >();
  constructor(
    private readonly statePath: string,
    private readonly adapters: NetworkAdapters,
  ) {
    this.store = new PluginNetworkStore(statePath, {
      ...adapters,
      committed: (owner, current) => {
        const policy = effective(
          current,
          requestedScopes(owner.staticRequests(), current),
        );
        const recovery = this.settingsRecoveries.get(owner.id);
        if (
          current.source && recovery &&
          equalSource(current.source, recovery.source)
        ) recovery.recovery.fence();
        this.adapters.revokeReduced(owner.id, policy);
      },
    });
  }
  private plugin(id: string) {
    return this.adapters.plugins().find((plugin) => plugin.id === id);
  }
  /** Host-only source-owned schema provider for every persistence consumer. */
  settingsSchema(id: string): SettingsPage[] {
    const plugin = this.plugin(id);
    if (!plugin?.manifest) {
      throw new PluginContractError(
        409,
        "plugin_settings_schema_conflict",
        "plugin settings source is no longer available",
      );
    }
    return plugin.manifest.settings;
  }
  settingsContext(id: string): SettingsContext {
    const selected = this.plugin(id);
    if (!selected?.manifest) {
      throw new PluginContractError(
        409,
        "plugin_settings_source_conflict",
        "plugin settings source unavailable",
      );
    }
    const fingerprint = installedSettingsFingerprint(selected.dir);
    const override = this.adapters.settingsEnvironment?.fingerprint(id);
    this.adapters.settingsEnvironment?.pages(id, selected.manifest.settings);
    return {
      codeFingerprint: fingerprint,
      key: (revision) =>
        effectiveSourceKey(id, fingerprint, revision, override),
      assertCurrent: () => {
        const current = this.plugin(id);
        if (
          !current?.manifest || current.dir !== selected.dir ||
          installedSettingsFingerprint(current.dir) !== fingerprint ||
          this.adapters.settingsEnvironment?.fingerprint(id) !== override
        ) {
          throw new PluginContractError(
            409,
            "plugin_settings_source_conflict",
            "plugin installed configuration source changed",
          );
        }
      },
    };
  }
  private owner(id: string): { plugin: NetworkPlugin; owner: NetworkOwner } {
    const plugin = this.plugin(id);
    if (!plugin) {
      throw new PluginContractError(
        404,
        "permission_plugin_not_found",
        "plugin is not discovered",
      );
    }
    const owner: NetworkOwner = {
      id,
      staticRequests: () => staticRequests(this.plugin(id) ?? plugin),
      source: async () => {
        const installed = this.plugin(id);
        if (!installed) {
          throw new PluginContractError(
            409,
            "permission_source_conflict",
            "plugin source is no longer available",
          );
        }
        const context = this.settingsContext(id);
        const settings = await new PluginDataStore(
          this.statePath,
          {
            ...this.adapters,
            settingsSchema: (owner) => this.settingsSchema(owner),
            settingsContext: () => context,
          },
        ).forPlugin(id).settings(installed.manifest?.settings ?? []);
        const settingsRevision = settings.revision;
        context.assertCurrent();
        return {
          key: settings.sourceKey!,
          codeFingerprint: context.codeFingerprint,
          settingsRevision,
        };
      },
    };
    return { plugin, owner };
  }
  private captureRecovery(id: string, policy: NetworkPolicy) {
    const recovery = this.adapters.captureSettingsRecovery?.(id, policy) ??
      { validate() {}, fence() {}, admit: () => Promise.resolve() };
    return { source: policy.source, recovery, started: false };
  }
  private rememberRecovery(id: string, policy: NetworkPolicy) {
    const previous = this.settingsRecoveries.get(id);
    if (previous && equalSource(previous.source, policy.source)) {
      return previous;
    }
    const ticket = this.captureRecovery(id, policy);
    this.settingsRecoveries.set(id, ticket);
    return ticket;
  }
  private async admitRecovery(
    id: string,
    ticket: {
      source: Source;
      recovery: SettingsOwnerRecovery;
      started: boolean;
    },
    fingerprint: string,
  ): Promise<void> {
    if (this.settingsRecoveries.get(id) !== ticket || ticket.started) return;
    ticket.started = true;
    try {
      await ticket.recovery.admit();
      if (this.settingsRecoveries.get(id) === ticket) {
        this.settingsRecoveries.delete(id);
      }
    } catch (error) {
      if (this.settingsRecoveries.get(id) === ticket) {
        this.reloads.set(id, {
          state: "failed",
          fingerprint,
          detail: error instanceof Error
            ? error.message
            : "settings-source recovery admission failed",
        });
      }
      throw error;
    }
  }
  async prepareSettingsCommit(
    change: SettingsCommitChange,
  ): Promise<PreparedSettingsCommit> {
    const definition = validateSettingsPages([change.definition]);
    const assertSchemaCurrent = () =>
      assertSettingsSchemaCurrent(
        definition,
        this.settingsSchema(change.pluginId),
      );
    assertSchemaCurrent();
    const { owner } = this.owner(change.pluginId);
    const original = await owner.source();
    if (original.settingsRevision !== change.previousRevision) {
      throw new PluginContractError(
        409,
        "permission_source_conflict",
        "settings source changed before preparation",
      );
    }
    const identity = {
      ...original,
      settingsRevision: change.nextRevision,
      key: await settingsSourceKey(
        change.pluginId,
        original.codeFingerprint,
        change.nextRevision,
        this.adapters.settingsEnvironment?.fingerprint(change.pluginId),
      ),
    };
    const prepared = await this.store.prepareSourceTransition(owner, identity);
    const rights = effective(
      prepared.next,
      requestedScopes(owner.staticRequests(), prepared.next),
    );
    const policy = {
      source: prepared.source,
      effective: rights,
      fingerprint: permissionFingerprint(rights.network, rights.imports),
    };
    // Uncommitted preparation must not become shared recovery intent: a CAS
    // rejection can be followed by a fresh same-source attempt with new owners.
    const ticket = this.captureRecovery(change.pluginId, policy);
    return {
      assertSchemaCurrent,
      validateLedgerSnapshot: async () => {
        const latest = await owner.source();
        if (
          latest.key !== original.key ||
          latest.codeFingerprint !== original.codeFingerprint ||
          latest.settingsRevision !== change.previousRevision
        ) {
          throw new PluginContractError(
            409,
            "permission_source_conflict",
            "installed code or settings source changed before settings effect",
          );
        }
        this.store.validatePreparedSource(prepared);
        assertSchemaCurrent();
        ticket.recovery.validate();
      },
      fenceCommittedSettings: () => {
        this.settingsRecoveries.set(change.pluginId, ticket);
        ticket.recovery.fence();
        this.adapters.revokeReduced(change.pluginId, rights);
      },
      publishRetirement: async () => {
        try {
          await this.store.publishSourceTransition(prepared);
          await this.admitRecovery(change.pluginId, ticket, policy.fingerprint);
        } catch (error) {
          this.reloads.set(change.pluginId, {
            state: "failed",
            fingerprint: policy.fingerprint,
            detail:
              `Settings persisted; permission source/recovery failed and requires read-back. ${
                error instanceof Error ? error.message : "source commit failed"
              }`,
          });
          throw error;
        } finally {
          this.adapters.changed();
        }
      },
    };
  }
  async view(id: string, caller?: Source): Promise<PermissionView> {
    const { plugin, owner } = this.owner(id);
    const before = await this.store.read(id);
    const identity = await owner.source();
    let retirement: {
      source: Source;
      recovery: SettingsOwnerRecovery;
      started: boolean;
    } | undefined;
    let retiredFingerprint = "";
    if (before.record.source && before.record.source.key !== identity.key) {
      const prepared = await this.store.prepareSourceTransition(
        owner,
        identity,
      );
      const rights = effective(
        prepared.next,
        requestedScopes(owner.staticRequests(), prepared.next),
      );
      retiredFingerprint = permissionFingerprint(
        rights.network,
        rights.imports,
      );
      retirement = this.rememberRecovery(id, {
        source: prepared.source,
        effective: rights,
        fingerprint: retiredFingerprint,
      });
    }
    let snapshot;
    try {
      snapshot = await this.store.synchronize(owner);
    } catch (error) {
      this.adapters.revokeReduced(id, { network: [], imports: [] });
      throw error;
    }
    const current = snapshot.record,
      requested = requestedScopes(owner.staticRequests(), current),
      policy = effective(current, requested);
    if (retirement) {
      retirement.recovery.fence();
      await this.admitRecovery(id, retirement, retiredFingerprint);
    }
    this.adapters.revokeReduced(id, policy);
    const rows: PermissionRow[] = [];
    const declared = owner.staticRequests();
    for (const kind of ["network", "imports"] as const) {
      const approvals = kind === "network"
        ? current.approvedNetwork
        : current.approvedImports;
      for (const scope of unionScopes(requested[kind], approvals)) {
        const isRequested = scopesCover(requested[kind], scope),
          isApproved = scopesCover(approvals, scope),
          isEffective = scopesCover(policy[kind], scope);
        const sources: PermissionRow["sources"] = [];
        if (scopesCover(declared[kind], scope)) {
          sources.push(
            kind === "imports" &&
              plugin.manifest?.capabilities.imports === undefined
              ? "legacy"
              : "static",
          );
        }
        for (const role of ["service", "render"] as const) {
          if (scopesCover(current.contributors[role]?.[kind] ?? [], scope)) {
            sources.push(role);
          }
        }
        if (
          current.requests.some((request) =>
            request.kind === kind && request.state !== "obsolete" &&
            equalSource(request.source, snapshot.source) &&
            scopesCover(request.scopes, scope)
          )
        ) sources.push("access-request");
        rows.push({
          kind,
          scope,
          requested: isRequested,
          approved: isApproved,
          effective: isEffective,
          approvalCoverage: approvals.filter((approval) =>
            scopeCovers(approval, scope)
          ),
          sources,
          blockedReasons: blocked(
            isRequested,
            isApproved,
            current.allowNetwork,
            isEffective,
          ),
        });
      }
    }
    const reload =
      [...caller ? [caller] : [], ...this.adapters.activeSources?.(id) ?? []]
          .some((active) =>
            active.codeFingerprint !== snapshot.source.codeFingerprint
          )
        ? {
          state: "failed" as const,
          fingerprint: permissionFingerprint(policy.network, policy.imports),
          detail:
            "source-reload-required: installed code changed; use the source replacement/enablement workflow",
        }
        : this.reloads.get(id) ??
          {
            state: "none" as const,
            fingerprint: permissionFingerprint(policy.network, policy.imports),
          };
    return {
      pluginId: id,
      revision: current.revision,
      signature: snapshot.signature,
      requestSourceKey: snapshot.source.key,
      requestSourceRevision: snapshot.source.revision,
      source: snapshot.source,
      allowNetwork: current.allowNetwork,
      approvedNetwork: current.approvedNetwork,
      approvedImports: current.approvedImports,
      requestedNetwork: requested.network,
      requestedImports: requested.imports,
      effectiveNetwork: policy.network,
      effectiveImports: policy.imports,
      rows,
      pendingRequests: current.requests.filter((request) =>
        request.state === "pending" &&
        equalSource(request.source, snapshot.source)
      ),
      reload,
      runsInBrowser: plugin.browserComponents.length > 0,
      browserComponents: plugin.browserComponents,
    };
  }
  async policy(id: string): Promise<NetworkPolicy> {
    const view = await this.view(id);
    const permissions = {
      network: view.effectiveNetwork,
      imports: view.effectiveImports,
    };
    return {
      source: view.source,
      effective: permissions,
      fingerprint: permissionFingerprint(
        permissions.network,
        permissions.imports,
      ),
    };
  }
  async pending() {
    // The manager supplies discovered identities, not caller-controlled vault selectors.
    return (await Promise.all(
      this.adapters.plugins().map((plugin) => this.view(plugin.id)),
    )).flatMap((view) => view.pendingRequests);
  }
  private async replace(id: string, source: Source, fingerprint: string) {
    const scheduled = this.replacements.get(id);
    if (
      !scheduled || !equalSource(scheduled.source, source) ||
      scheduled.fingerprint !== fingerprint
    ) return;
    const current = await this.policy(id);
    if (
      !equalSource(current.source, source) ||
      current.fingerprint !== fingerprint
    ) {
      this.replacements.delete(id);
      return;
    }
    this.reloads.set(id, { id: scheduled.id, state: "reloading", fingerprint });
    this.adapters.changed();
    try {
      await this.adapters.reload(id, current);
      if (this.replacements.get(id) !== scheduled) return;
      const readyPolicy = await this.policy(id);
      if (this.replacements.get(id) !== scheduled) return;
      if (
        !equalSource(readyPolicy.source, source) ||
        readyPolicy.fingerprint !== fingerprint
      ) {
        throw new PluginContractError(
          409,
          "permission_reload_superseded",
          "permission source changed before ready publication",
        );
      }
      this.reloads.set(id, { id: scheduled.id, state: "ready", fingerprint });
    } catch (error) {
      if (this.replacements.get(id) !== scheduled) return;
      this.reloads.set(id, {
        id: scheduled.id,
        state: "failed",
        fingerprint,
        detail: error instanceof Error
          ? error.message
          : "permission replacement failed",
      });
    } finally {
      if (this.replacements.get(id) === scheduled) this.replacements.delete(id);
      this.adapters.changed();
    }
  }
  private schedule(view: PermissionView, authority?: RpcAuthority) {
    const fingerprint = permissionFingerprint(
      view.effectiveNetwork,
      view.effectiveImports,
    );
    const previous = this.replacements.get(view.pluginId);
    if (
      previous && previous.fingerprint === fingerprint &&
      equalSource(previous.source, view.source)
    ) return;
    const id = crypto.randomUUID();
    this.replacements.set(view.pluginId, {
      id,
      fingerprint,
      source: view.source,
    });
    this.reloads.set(view.pluginId, { id, state: "scheduled", fingerprint });
    this.adapters.changed();
    const admitted = authority
      ? Promise.all([
        authority.receipt!,
        authority.release,
        authority.readiness!,
      ]).then((outcomes) =>
        outcomes.every((outcome) => outcome.status === "settled")
      )
      : Promise.resolve(true);
    admitted.then((ready) => {
      if (ready) return this.replace(view.pluginId, view.source, fingerprint);
      if (this.replacements.get(view.pluginId)?.id === id) {
        this.replacements.delete(view.pluginId);
        this.reloads.set(view.pluginId, {
          id,
          state: "failed",
          fingerprint,
          detail:
            "request admission or originating invocation did not settle; no replay",
        });
        this.adapters.changed();
      }
    }).catch(() => {
      if (this.replacements.get(view.pluginId)?.id !== id) return;
      this.replacements.delete(view.pluginId);
      this.reloads.set(view.pluginId, {
        id,
        state: "failed",
        fingerprint,
        detail: "request admission failed; review current status",
      });
      this.adapters.changed();
    });
  }
  async controls(
    id: string,
    input: unknown,
    requestId?: string,
    settingsGuard?: () => void,
  ): Promise<{ view: PermissionView }> {
    const { owner } = this.owner(id), before = await this.view(id);
    await this.store.controls(
      owner,
      before.source,
      input,
      requestId ? { requestId } : undefined,
      settingsGuard,
    );
    const view = await this.view(id);
    if (
      permissionFingerprint(
        before.effectiveNetwork,
        before.effectiveImports,
      ) !== permissionFingerprint(view.effectiveNetwork, view.effectiveImports)
    ) this.schedule(view);
    this.adapters.changed();
    return { view: await this.view(id) };
  }
  async rpc(
    id: string,
    method: string,
    args: unknown[],
    authority: RpcAuthority,
  ): Promise<unknown> {
    if (!authority.source || !authority.current()) {
      throw new PluginContractError(
        409,
        "permission_source_conflict",
        "permission caller/source is unavailable",
      );
    }
    const before = await this.view(id, authority.source);
    if (method === "permissions.status") return before;
    if (!authority.receipt || !authority.readiness) {
      throw new PluginContractError(
        409,
        "permission_admission_unavailable",
        "permission publication transport is unavailable",
      );
    }
    if (authority.source.codeFingerprint !== before.source.codeFingerprint) {
      throw new PluginContractError(
        409,
        "permission_source_conflict",
        "source-reload-required: old code cannot publish for installed replacement code",
      );
    }
    const options = args[1] === undefined
      ? undefined
      : record(args[1], "permission publication options");
    if (
      options &&
      (Object.keys(options).length !== 1 || !Object.hasOwn(options, "source"))
    ) {
      throw new PluginContractError(
        422,
        "invalid_permission_source",
        "publication options contain a source token only",
      );
    }
    const source = options
      ? permissionSource(options.source)
      : authority.source;
    const { owner } = this.owner(id);
    let requestId: string | undefined;
    if (method === "permissions.declare") {
      await this.store.declare(
        owner,
        authority.role,
        source,
        authority.current,
        args[0],
      );
    } else if (method === "permissions.requestAccess") {
      requestId = (await this.store.requestAccess(
        owner,
        source,
        authority.current,
        args[0],
      )).value;
    } else {throw new PluginContractError(
        422,
        "invalid_permission_method",
        "unsupported permission publication method",
      );}
    const view = await this.view(id, authority.source);
    if (
      permissionFingerprint(
        before.effectiveNetwork,
        before.effectiveImports,
      ) !== permissionFingerprint(view.effectiveNetwork, view.effectiveImports)
    ) this.schedule(view, authority);
    this.adapters.changed();
    if (!requestId) return view;
    const request = (await this.store.read(id)).record.requests.find(
      (request) => request.id === requestId,
    )!;
    const approvals = request.kind === "network"
      ? view.approvedNetwork
      : view.approvedImports;
    const currentEffective = request.kind === "network"
      ? view.effectiveNetwork
      : view.effectiveImports;
    return {
      requestId,
      revision: view.revision,
      status: request.state,
      blockedReasons: [
        ...new Set(request.scopes.flatMap((scope) =>
          blocked(
            true,
            scopesCover(approvals, scope),
            view.allowNetwork,
            scopesCover(currentEffective, scope),
          )
        )),
      ],
    } satisfies AccessAdmission;
  }
}
