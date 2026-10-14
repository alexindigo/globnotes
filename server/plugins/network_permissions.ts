// SPDX-License-Identifier: LGPL-3.0-only

/** Semantic intersection followed by independent, query-only parent bounds. */
import { intersectScopes, type Kind, type Scope } from "./network_contracts.ts";

export type ParentQuery = (
  descriptor: Deno.PermissionDescriptor,
) => Pick<Deno.PermissionStatus, "state" | "partial">;
export function delegableScopes(
  kind: Kind,
  candidates: Scope[],
  query: ParentQuery = (descriptor) => Deno.permissions.querySync(descriptor),
): Scope[] {
  return candidates.filter((scope) => {
    const descriptor: Deno.PermissionDescriptor = scope.type === "all"
      ? { name: kind === "network" ? "net" : "import" }
      : { name: kind === "network" ? "net" : "import", host: scope.authority };
    try {
      const status = query(descriptor);
      return status.state === "granted" && !status.partial;
    } catch {
      return false;
    }
  });
}
export function effectiveScopes(
  kind: Kind,
  enabled: boolean,
  requested: Scope[],
  approved: Scope[],
  query?: ParentQuery,
): Scope[] {
  return enabled
    ? delegableScopes(kind, intersectScopes(requested, approved), query)
    : [];
}
export function denoScopes(scopes: Scope[]): false | true | string[] {
  if (!scopes.length) return false;
  if (scopes.some((scope) => scope.type === "all")) return true;
  return scopes.flatMap((scope) =>
    scope.type === "host" ? [scope.authority] : []
  );
}
export function permissionFingerprint(
  network: Scope[],
  imports: Scope[],
): string {
  return JSON.stringify({ network, imports });
}
