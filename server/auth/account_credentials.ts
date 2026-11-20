// SPDX-License-Identifier: LGPL-3.0-only
/** Safe errors and erased command types. Runtime binders stay private. */
export class AuthenticationError extends Error {
  constructor() {
    super("Invalid authentication credentials.");
  }
}
export type {
  AccountCredentials,
  AuthenticatorChange,
  CredentialAuthority,
  CredentialChangeRequest,
  CredentialOptions,
  LoginClaim,
  LoginProof,
  PreparedCredentialTransition,
} from "./internal/account_credentials.ts";
