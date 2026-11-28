// SPDX-License-Identifier: LGPL-3.0-only
import {
  type AccountIdentity,
  AccountRepository,
} from "../../server/auth/accounts.ts";
import {
  type CredentialAuthority,
  type CredentialChangeRequest,
  type CredentialOptions,
} from "../../server/auth/account_credentials.ts";
import { bindCredentialAuthority } from "../../server/auth/internal/account_credentials.ts";
import { OwnAccount } from "../../server/auth/account.ts";
import { InstanceAuthority } from "../../server/auth/authority.ts";
import { StoredConfigConflict } from "../../server/config/file_store.ts";
import type { TotpEnrollmentBundle } from "../../server/auth/totp_enrolment.ts";
import { createOperationLease } from "../../server/operation_lease.ts";
import type { OperationLease } from "../../server/operation_lease.ts";
import {
  InstanceSessions,
  SessionRepository,
} from "../../server/auth/sessions.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  identityAccount,
  identityFixture,
  UPDATE,
} from "./identity.ts";
import { fixturePasswordHash } from "./config.ts";
import { authenticatorCode } from "./totp.ts";
import { importFixtureAccount } from "./account_preparation.ts";
import {
  decodeStoredTotpSecret,
  storedTotpManualSecret,
} from "../../server/auth/credentials.ts";

export const COMMAND_NOW = 1_800_000_000_000;
export const NEXT_UPDATE = "00000000-0000-4000-8000-000000000006";
function credentialBinding(
  accounts: AccountRepository,
  account: AccountIdentity,
  lease: OperationLease<"live">,
): CredentialAuthority {
  return bindCredentialAuthority(
    accounts.credentials,
    account,
    lease,
  );
}
export async function withCredentialAuthority<T>(
  accounts: AccountRepository,
  id: string,
  run: (authority: CredentialAuthority) => Promise<T>,
): Promise<T> {
  const lifetime = createOperationLease("live", [() => undefined]);
  try {
    return await run(
      credentialBinding(accounts, accounts.byId(id)!, lifetime.lease),
    );
  } finally {
    lifetime.retire();
  }
}
export interface CommandFixture {
  readonly root: string;
  readonly options: CredentialOptions;
  readonly accounts: AccountRepository;
  readonly sessions: InstanceSessions;
  readonly ownAccount: OwnAccount;
  addPeer(): void;
  readonly authority: CredentialAuthority;
  now: number;
  retire(): boolean;
  bound(account?: AccountIdentity): CredentialAuthority;
  request(changes?: Partial<CredentialChangeRequest>): CredentialChangeRequest;
  code(
    key?: string,
    encoding?: "base32" | null,
    offset?: number,
  ): Promise<string>;
}
export async function credentialCommandFixture(
  run: (fixture: CommandFixture) => Promise<void>,
  options: CredentialOptions = {},
  stored: { key: string; encoding?: "base32" | null; floor?: number } | null =
    null,
  restricted = false,
): Promise<void> {
  await identityFixture(async (root, scope) => {
    let now = COMMAND_NOW;
    const credentialOptions: CredentialOptions = {
      now: () => now,
      hash: (password) => Promise.resolve(fixturePasswordHash(password)),
      renderQr: (uri) => Promise.resolve(`qr:${uri}`),
      ...options,
    };
    const accounts = new AccountRepository(root, undefined, credentialOptions);
    importFixtureAccount(
      accounts,
      identityAccount({
        passwordHash: fixturePasswordHash("password"),
        passwordChangeRequired: restricted,
        ...(stored
          ? {
            totpKey: stored.key,
            ...(Object.hasOwn(stored, "encoding")
              ? { totpKeyEncoding: stored.encoding }
              : {}),
            lastTotpStep: stored.floor ?? null,
          }
          : {}),
      }),
    );
    const signing = new SessionRepository(root);
    signing.initialize();
    const sessions = new InstanceSessions(accounts, signing, {
      expirySeconds: 86400,
    }, { now: () => now });
    const lifetime = createOperationLease("live", [() => undefined]);
    scope.onCancel(() => lifetime.retire());
    scope.onCancel(() => accounts.retireCredentials());
    const bound = (
      account = accounts.identityById(ACCOUNT_A)!,
    ): CredentialAuthority => {
      const { id, credentialRevision } = account;
      const operation = createOperationLease("live", [() => {
        if (
          accounts.identityById(id)?.credentialRevision !== credentialRevision
        ) throw new StoredConfigConflict();
        return undefined;
      }], [lifetime.lease]);
      return credentialBinding(accounts, account, operation.lease);
    };
    await run({
      root,
      options: credentialOptions,
      accounts,
      sessions,
      ownAccount: new OwnAccount(
        new InstanceAuthority(sessions, () => null, lifetime.lease),
      ),
      addPeer() {
        importFixtureAccount(
          accounts,
          identityAccount({
            id: ACCOUNT_B,
            login: "bob",
            passwordHash: fixturePasswordHash("password"),
          }),
        );
      },
      authority: bound(),
      retire: lifetime.retire,
      bound,
      get now() {
        return now;
      },
      set now(value) {
        now = value;
      },
      request: (changes) => ({
        credentialRevision: 0,
        updateId: UPDATE,
        current: { password: "password" },
        authenticator: { kind: "keep" },
        ...changes,
      }),
      code: (
        key = stored?.key ?? "key",
        encoding = stored?.encoding,
        offset = 0,
      ) =>
        authenticatorCode(
          storedTotpManualSecret(decodeStoredTotpSecret(key, encoding)),
          now + offset * 30_000,
        ),
    });
  });
}
/** Deterministic server issuance for effective-key identity controls only. */
export function enrollmentWithBytes(
  fixture: CommandFixture,
  bytes: Uint8Array,
  authority = fixture.authority,
): Promise<TotpEnrollmentBundle> {
  if (bytes.length !== 20) {
    return Promise.reject(new Error("Candidate fixture requires 20 bytes"));
  }
  const random = crypto.getRandomValues;
  crypto.getRandomValues = function <T extends ArrayBufferView>(array: T): T {
    if (array instanceof Uint8Array && array.length === 20) {
      array.set(bytes);
      return array;
    }
    return random.call(crypto, array) as T;
  };
  // beginEnrollment draws candidate bytes synchronously, so the stub is
  // restored before any renderer settles; overlapping calls never inherit it.
  try {
    return fixture.accounts.credentials.beginEnrollment(authority);
  } finally {
    crypto.getRandomValues = random;
  }
}
