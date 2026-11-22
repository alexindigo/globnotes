// SPDX-License-Identifier: LGPL-3.0-only
import { resolve } from "@std/path";
import {
  assertOperationLease,
  type OperationLease,
} from "../operation_lease.ts";
import {
  operationValidationOrigin,
  withOperationValidation,
} from "./operation_validation.ts";

interface ValidationScope {
  readonly root?: string;
  readonly setId?: string;
  readonly fence?: object;
}
const scopes = new WeakMap<object, ValidationScope>();
export function publicationValidation(root: string, setId: string): object {
  const context = Object.freeze({});
  scopes.set(context, { root: resolve(root), setId });
  return context;
}
export function setValidation(fence: object): object {
  const context = Object.freeze({});
  scopes.set(context, { fence });
  return context;
}
export function matchesPublicationValidation(
  context: object | undefined,
  fence: object,
  root?: string,
  setId?: string,
): boolean {
  const origin = context && operationValidationOrigin(context);
  const scope = origin && scopes.get(origin);
  return !!scope &&
    (scope.fence
      ? scope.fence === fence
      : root !== undefined && scope.root === resolve(root) &&
        scope.setId === setId);
}
export function withPublicationValidation<T>(context: object, run: () => T): T {
  return withOperationValidation(context, run);
}
export function assertPublicationAuthority(
  lease: OperationLease<"live">,
  root: string,
  setId: string,
): void {
  withPublicationValidation(
    publicationValidation(root, setId),
    () => assertOperationLease(lease, "live"),
  );
}
