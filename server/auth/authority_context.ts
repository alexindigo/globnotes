// SPDX-License-Identifier: LGPL-3.0-only
/** Erased callback contract. Contexts are issued by the authority evaluator,
 * never constructed by service eligibility or retained as background authority. */
export type {
  AuthorityPrincipalCheck,
  AuthorityReadContext,
} from "./internal/authority_context.ts";
import type { AuthorityReadContext } from "./internal/authority_context.ts";
import { withAuthorityContext } from "./internal/authority_context.ts";
/** Every injected authority check receives the current read context explicitly. */
export type AuthorityCallback<T> = (context: AuthorityReadContext) => T;
/** Ordinary/background callers get an explicit scoped context, never the native
 * context of an enclosing callback. Public custody fences still apply. */
export function readAuthorityState<T>(read: AuthorityCallback<T>): T {
  return withAuthorityContext(undefined, read);
}
