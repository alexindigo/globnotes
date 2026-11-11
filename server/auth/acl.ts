// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { createUuid } from "../../shared/uuid.ts";
import { StoredConfigConflict } from "../config/file_store.ts";
import {
  type Account,
  AccountRepository,
  normalizeLogin,
  validateAccount,
} from "./accounts.ts";
import {
  fields,
  identity,
  IdentityFile,
  type IdentitySnapshot,
  IdentityStateError,
  integer,
  record,
} from "./records.ts";
import type { Principal } from "./sessions.ts";

export const ACCESS_LEVELS = ["none", "view", "edit", "admin"] as const;
export type AccessLevel = typeof ACCESS_LEVELS[number];
export type EverybodyLevel = Exclude<AccessLevel, "admin">;
export interface AclValues {
  readonly everybody: EverybodyLevel;
  readonly grants: Readonly<Record<string, AccessLevel>>;
}
export interface AclState extends AclValues {
  readonly version: 1;
  readonly vaultId: string;
  readonly revision: number;
  readonly updateId: string | null;
  readonly updateActorId: string | null;
}
export type AclSnapshot = IdentitySnapshot<AclState>;
const level = (value: unknown): value is AccessLevel =>
  typeof value === "string" && ACCESS_LEVELS.includes(value as AccessLevel);
function validateValues(value: unknown): AclValues {
  if (
    !record(value) || !fields(value, ["everybody", "grants"]) ||
    !level(value.everybody) || value.everybody === "admin" ||
    !record(value.grants)
  ) {
    throw new IdentityStateError();
  }
  for (const [id, grant] of Object.entries(value.grants)) {
    if (!identity(id) || !level(grant)) throw new IdentityStateError();
  }
  return value as unknown as AclValues;
}
export function validateAcl(value: unknown, vaultId: string): AclState {
  if (
    !identity(vaultId) || !record(value) || !fields(value, [
      "version",
      "vaultId",
      "revision",
      "updateId",
      "updateActorId",
      "everybody",
      "grants",
    ]) || value.version !== 1 || value.vaultId !== vaultId ||
    !integer(value.revision) ||
    !(value.updateId === null || identity(value.updateId)) ||
    !(value.updateActorId === null || identity(value.updateActorId))
  ) throw new IdentityStateError();
  validateValues({ everybody: value.everybody, grants: value.grants });
  return value as unknown as AclState;
}

/** Preparation only: piece 3 owns create/adopt consent, journal and publication. */
export function prepareInitialAcl(
  vaultId: string,
  creator: Account,
  everybody: EverybodyLevel,
): AclState {
  validateAccount(creator);
  if (creator.passwordChangeRequired) throw new IdentityStateError();
  return validateAcl({
    version: 1,
    vaultId,
    revision: 1,
    updateId: createUuid(),
    updateActorId: creator.id,
    everybody,
    grants: { [creator.id]: "admin" },
  }, vaultId);
}

/** Vault-owned ACL. Declaration-owned Admin is evaluated live but never saved as
 * an inferred grant. It has no credentials or process-wide current principal. */
export class AclRepository {
  readonly #file: IdentityFile<AclState>;
  readonly #accounts: AccountRepository;
  readonly #adminLogin: string | null;
  constructor(
    root: string,
    readonly vaultId: string,
    options: { accounts: AccountRepository; declaredAdmin?: string },
  ) {
    this.#accounts = options.accounts;
    this.#adminLogin = options.declaredAdmin
      ? normalizeLogin(options.declaredAdmin)
      : null;
    this.#file = new IdentityFile(
      join(root, "access.json"),
      (value) => validateAcl(value, vaultId),
      {
        version: 1,
        vaultId,
        revision: 0,
        updateId: null,
        updateActorId: null,
        everybody: "none",
        grants: {},
      },
    );
  }
  capture(): AclSnapshot {
    return this.#file.capture();
  }
  prepareParents(): void {
    this.#file.prepareParents();
  }
  assertUnchanged(expected = this.capture()): void {
    this.#file.assertUnchanged(expected);
  }
  get declaredAdmin() {
    const accountId = this.#adminLogin
      ? this.#accounts.byLogin(this.#adminLogin)?.id ?? null
      : null;
    return Object.freeze({
      login: this.#adminLogin,
      accountId,
      pending: !!this.#adminLogin && !accountId,
      pinned: !!this.#adminLogin,
    });
  }
  get revision(): number {
    return this.capture().value.revision;
  }
  /** Includes only this vault's deployment overlay, not global account-store churn. */
  get policyKey(): string {
    return JSON.stringify([
      this.vaultId,
      this.revision,
      this.#adminLogin,
      this.declaredAdmin.accountId,
    ]);
  }
  effectiveLevel(principal: Principal): AccessLevel {
    const value = this.capture().value;
    if (principal.kind === "guest") return value.everybody;
    if (principal.accountId === this.declaredAdmin.accountId) return "admin";
    return Object.hasOwn(value.grants, principal.accountId)
      ? value.grants[principal.accountId]
      : value.everybody;
  }
  async view() {
    const before = this.capture(),
      policy = this.policyKey,
      declaredAdmin = this.declaredAdmin;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        before.persistence.raw === null
          ? "absent-vault-access-v1"
          : `present:${before.persistence.raw}`,
      ),
    );
    this.assertUnchanged(before);
    if (policy !== this.policyKey) throw new StoredConfigConflict();
    return Object.freeze({
      vaultId: this.vaultId,
      revision: before.value.revision,
      signature: [...new Uint8Array(digest)].map((b) =>
        b.toString(16).padStart(2, "0")
      ).join(""),
      updateId: before.value.updateId,
      everybody: before.value.everybody,
      grants: before.value.grants,
      declaredAdmin,
    });
  }
  save(
    values: AclValues,
    expected = this.capture(),
    options: { updateId: string; actorId: string | null },
    guard: () => void = () => {},
  ): AclState {
    validateValues(values);
    for (const id of Object.keys(values.grants)) {
      if (!this.#accounts.byId(id)) throw new IdentityStateError();
    }
    // Byte signature is checked by the workflow's view, and the bound capture
    // always rechecks exact bytes/inodes, including same-byte replacement.
    return this.#file.commit(
      {
        ...expected.value,
        ...values,
        revision: expected.value.revision + 1,
        updateId: options.updateId,
        updateActorId: options.actorId,
      },
      expected,
      guard,
    );
  }
  initializeForCreator(
    creator: Account,
    everybody: EverybodyLevel,
    expected = this.capture(),
    guard: () => void = () => {},
  ): AclState {
    const current = this.#accounts.byId(creator.id);
    if (
      expected.persistence.raw !== null || !current ||
      current.credentialRevision !== creator.credentialRevision ||
      current.passwordChangeRequired
    ) throw new StoredConfigConflict();
    return this.#file.commit(
      prepareInitialAcl(this.vaultId, creator, everybody),
      expected,
      guard,
    );
  }
  /** Import writes a validated bound record; it never reads v2 files or publishes a vault. */
  importAcl(
    value: AclState,
    expected = this.capture(),
    guard: () => void = () => {},
  ): AclState {
    validateAcl(value, this.vaultId);
    if (expected.persistence.raw !== null) throw new StoredConfigConflict();
    for (const id of Object.keys(value.grants)) {
      if (!this.#accounts.byId(id)) throw new IdentityStateError();
    }
    return this.#file.commit(value, expected, guard);
  }
}
