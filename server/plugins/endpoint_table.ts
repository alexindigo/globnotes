// SPDX-License-Identifier: LGPL-3.0-only

/** Pure descriptor compilation shared by activation and request admission. */
import { CompiledMatcher } from "@pathfinder/pathfinder";
import {
  type EndpointDescriptor,
  HTTP_METHODS,
  record,
  text,
} from "./contracts.ts";

export interface EndpointBinding {
  readonly handlerId: string;
  readonly descriptor: unknown;
}
export interface CompiledEndpointTable {
  readonly matcher: CompiledMatcher;
  readonly handlers: ReadonlyMap<string, string>;
}
export function compileEndpointTable(
  bindings: readonly EndpointBinding[],
): CompiledEndpointTable {
  const handlers = new Map<string, string>();
  const routes = bindings.map(({ handlerId, descriptor }) => {
    text(handlerId, "endpoint handler identity");
    const raw = record(descriptor, "endpoint descriptor");
    if (
      Object.keys(raw).some((key) => !["method", "pattern"].includes(key)) ||
      !HTTP_METHODS.includes(raw.method as EndpointDescriptor["method"]) ||
      typeof raw.pattern !== "string" || !raw.pattern.startsWith("/")
    ) {
      throw new Error("invalid endpoint descriptor");
    }
    const method = raw.method as EndpointDescriptor["method"],
      pattern = raw.pattern;
    const key = `${method} ${pattern}`;
    handlers.set(key, handlerId);
    return { method, pattern, data: key, handler: () => key };
  });
  // Public constructor validates grammar and equivalent same-method shapes.
  return { matcher: new CompiledMatcher(routes), handlers };
}
export function endpointMethods(
  table: CompiledEndpointTable,
  encodedPath: string,
): string[] | null {
  const methods = new Set<string>();
  for (const method of HTTP_METHODS) {
    const result = table.matcher.lookup(method, encodedPath);
    if (result.kind === "match") methods.add(method);
    else if (result.kind === "method-miss") {
      for (const allowed of result.allowed) {
        methods.add(allowed);
      }
    }
  }
  return methods.size ? [...methods].sort() : null;
}
export function advertisedEndpointMethods(actual: readonly string[]): string[] {
  return [
    ...new Set([
      ...actual,
      ...actual.includes("GET") ? ["HEAD"] : [],
      "OPTIONS",
    ]),
  ].sort();
}
