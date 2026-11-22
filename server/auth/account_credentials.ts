// SPDX-License-Identifier: LGPL-3.0-only
/** Safe errors and erased command types. Runtime binders stay private. */
export class AuthenticationError extends Error {
  constructor(readonly code?: "authenticator_required") {
    super("Invalid authentication credentials.");
  }
}
export type {
  AccountCredentials,
  AccountPreparationAuthority,
  AccountPreparationRequest,
  AuthenticatorChange,
  CredentialAuthority,
  CredentialChangeRequest,
  CredentialOptions,
  LoginClaim,
  LoginProof,
  OfflineAccountRequest,
  OfflinePasswordRequest,
  PreparedAccount,
  PreparedCredentialTransition,
} from "./internal/account_credentials.ts";
