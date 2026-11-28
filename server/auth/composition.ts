// SPDX-License-Identifier: LGPL-3.0-only
import type { GlobalConfig } from "../config.ts";
import type { OperationLease } from "../operation_lease.ts";
import {
  PluginLifecycle,
  type PluginServiceEligibility,
} from "../plugins/lifecycle.ts";
import type { PluginManager } from "../plugins/manager.ts";
import type { PluginDataStore } from "../plugins/data.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { PluginContractError } from "../plugins/contracts.ts";
import type { AclRepository } from "./acl.ts";
import { AdmissionRefusal } from "./admission_refusal.ts";
import {
  type AuthorityDisclosure,
  InstanceAuthority,
  type PreparedAuthorityRead,
  type VaultAuthorityLease,
} from "./authority.ts";
import { createInstanceAuth, type StatusAdmission } from "./middleware.ts";
import { deliveryJson, singleIdentityVault } from "./http_policy.ts";
import type { AuthorityCallback } from "./authority_context.ts";
import { createIdentityProjections } from "./projection.ts";
import type { InstanceSessions } from "./sessions.ts";
import { identityTokenScope } from "../../shared/identity_token.ts";

/** Target-bound stream admission. The lease fences every delivered chunk; the
 * subscription only lets the stream close and release promptly. */
export interface IdentityStreamAccess {
  readonly lease: VaultAuthorityLease;
  readonly lifecycle: Pick<PluginLifecycle, "epoch" | "subscribeInvalidation">;
  readonly canManageVault: boolean;
  /** Account, concrete-vault ACL and access-policy changes; never other vaults. */
  subscribe(listener: () => void): () => void;
}

const eligibilityBySession = new WeakMap<
  InstanceSessions,
  PluginServiceEligibility
>();

/** Instance-owned readiness, never the access level of a browser. A read never
 * initializes signing or writes; an unavailable/incomplete store is ineligible. */
export function identityServiceEligibility(
  sessions: InstanceSessions,
): PluginServiceEligibility {
  const current = eligibilityBySession.get(sessions);
  if (current) return current;
  const operational: AuthorityCallback<boolean> = (context) => {
    try {
      return context.accounts(sessions.accounts).value.initialized &&
        context.signing(sessions.signing).initialized;
    } catch {
      return false;
    }
  };
  const eligibility = Object.freeze({ operational, writable: operational });
  eligibilityBySession.set(sessions, eligibility);
  return eligibility;
}

const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
};
function jsonResponse<T>(
  disclosure: AuthorityDisclosure,
  handle: PreparedAuthorityRead<T>,
): Response {
  return new Response(disclosure.body(handle), { headers: JSON_HEADERS });
}

/** The instance supplies and retires the live lifetime shared by all consumers. */
export function createIdentityComposition(adapters: {
  sessions: InstanceSessions;
  acl: AclRepository;
  vaultId: string;
  config: GlobalConfig;
  lifecycle?: PluginLifecycle;
  cookieName?: string;
  lifetime: OperationLease<"live">;
  plugins(): PluginManager;
  setupStatus(): { setupRequired: boolean };
  release: { version: string | null; revision: string | null };
}) {
  const { sessions, acl, lifetime } = adapters;
  const eligibility = identityServiceEligibility(sessions);
  const lifecycle = adapters.lifecycle ??
    new PluginLifecycle(adapters.config, eligibility);
  lifecycle.assertServiceEligibility(eligibility);
  const vault = Object.freeze({
    identity: {},
    id: adapters.vaultId,
    acl,
    lifecycle,
  });
  const authority = new InstanceAuthority(sessions, () => vault, lifetime);
  const auth = createInstanceAuth({
    sessions,
    vault: singleIdentityVault(vault),
    cookieName: adapters.cookieName ??
      identityTokenScope(adapters.config.pathPrefix).cookieName,
    lifetime: () => lifetime,
  });
  const projections = createIdentityProjections(adapters);
  const subscribe = (listener: () => void): () => void => {
    const releases: (() => unknown)[] = [];
    try {
      const observe = () => {
        listener();
        return undefined;
      };
      releases.push(sessions.accounts.subscribe(observe));
      releases.push(acl.subscribe(observe));
      releases.push(lifecycle.onPolicyChange(listener));
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  };
  const projectionResponse = async (
    request: Request,
    project: (
      admission: StatusAdmission,
    ) => ReturnType<typeof projections.status>,
  ) => {
    const admission = await auth.statusAdmission(request);
    const { lease } = admission;
    return jsonResponse(lease, lease.prepare(project(admission)));
  };
  return Object.freeze({
    auth,
    authority,
    eligibility,
    lifecycle,
    vault,
    subscribe,
    responses: Object.freeze({
      status: (request: Request) =>
        projectionResponse(request, projections.status),
      config: (request: Request) =>
        projectionResponse(request, projections.config),
      async catalog(request: Request): Promise<Response> {
        const principal = await auth.principal(request);
        const manage = authority.capabilities(principal).canManageVault;
        const lease = await auth.lease(
          request,
          manage ? "manageVault" : "readVault",
        );
        return jsonResponse(
          lease,
          await lease.read(() => projections.catalog(manage)),
        );
      },
      async pluginSettings(
        request: Request,
        data: PluginDataStore,
        id: string,
        pageId: string,
      ): Promise<Response> {
        const reader = await auth.readLease(request);
        const manage = authority.capabilities(reader.principal).canManageVault;
        const lease = manage
          ? await auth.lease(request, "manageVault")
          : reader;
        const plugins = adapters.plugins();
        if (manage) {
          return jsonResponse(
            lease,
            await lease.read(async () => {
              const inventory = await plugins.catalog();
              const page = inventory.plugins.find((plugin) => plugin.id === id)
                ?.pages.find(({ id }) => id === pageId);
              if (!page) throw new HttpError(404, "Not Found");
              const current = await data.forPlugin(id).page(page);
              return {
                values: current.values,
                revision: current.revision,
                sourceKey: current.sourceKey,
                fields: current.fields,
              };
            }),
          );
        }
        lease.assertCurrent();
        const owner = plugins.browserOwner(id);
        if (!owner?.manifest.settings.some(({ id }) => id === pageId)) {
          throw new AdmissionRefusal("operation_not_permitted");
        }
        const source = data.forPlugin(id).settingsLease(
          owner.manifest.settings,
        );
        const assertCurrent = () => {
          lease.assertCurrent();
          const current = plugins.browserOwner(id);
          if (
            adapters.plugins() !== plugins || !current ||
            current.epoch !== owner.epoch
          ) {
            throw new PluginContractError(
              409,
              "plugin_settings_source_conflict",
              "Plugin browser contribution changed.",
            );
          }
          source.assertCurrent();
        };
        const projection = { values: source.values[pageId] };
        assertCurrent();
        return deliveryJson(() => {
          assertCurrent();
          return projection;
        });
      },
    }),
    async streamAccess(request: Request): Promise<IdentityStreamAccess> {
      const lease = await auth.readLease(request);
      const canManageVault =
        authority.capabilities(lease.principal).canManageVault;
      lease.assertCurrent();
      return Object.freeze({
        lease,
        lifecycle,
        canManageVault,
        subscribe,
      });
    },
  });
}
