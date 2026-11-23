// SPDX-License-Identifier: LGPL-3.0-only

/** v2 configured-access glue; keeps the existing account and policy gate. */
import { HttpError } from "@pathfinder/pathfinder";
import { createUuid } from "../../shared/uuid.ts";
import {
  AuthType,
  type GlobalConfig,
  type StoredConfig,
  StoredConfigConflict,
} from "../config.ts";
import { hashPassword } from "../helpers.ts";
import { state } from "../state.ts";
import { LocalAuth } from "./local.ts";
import { pendingTotpEnrollments } from "./totp_enrolment.ts";
import { settingsWriteGuard } from "./middleware.ts";
import {
  type AuthorityVault,
  InstanceAuthority,
  sameAuthorityVault,
} from "./authority.ts";
import { type AccessLevel, isAccessLevel, isEverybodyLevel } from "./acl.ts";
import { parseLoginName } from "./login_name.ts";
import type { AccountPrincipal, Principal } from "./sessions.ts";
import { AuthenticationError } from "./account_credentials.ts";
import {
  fields,
  identity,
  integer,
  parseDenseArray,
  record,
} from "./records.ts";
import { readAuthorityState } from "./authority_context.ts";
import { readRequestJson } from "./request_json.ts";

function conflict(message: string): never {
  throw new HttpError(409, message);
}
function revision(config = state.config): number {
  const value = config.storedConfig?.access_revision ?? 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    conflict("Invalid saved access revision; original configuration retained.");
  }
  return value as number;
}
async function contentSignature(raw: string | null): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      raw === null ? "absent-access-v1" : `present:${raw}`,
    ),
  );
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
function assertPersistence(
  config: GlobalConfig,
  snapshot: ReturnType<GlobalConfig["captureStoredConfig"]>,
) {
  try {
    config.assertStoredConfigUnchanged(snapshot);
  } catch (error) {
    if (error instanceof StoredConfigConflict) {
      conflict(
        "Configuration changed; review current settings before retrying.",
      );
    }
    throw error;
  }
}
function freezeBase(value: StoredConfig): StoredConfig {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freezeBase(child as StoredConfig);
  }
  return Object.freeze(value);
}
async function captureAccessSnapshot() {
  const config = state.config, auth = state.auth, lifecycle = state.lifecycle;
  const epoch = lifecycle?.epoch, stored = JSON.stringify(config.storedConfig);
  const authType = config.authType, setupRequired = config.setupRequired;
  const readOnlySettings = config.readOnlySettings;
  const settingsWritable = config.settingsWritable,
    savedRevision = revision(config);
  const persistence = config.captureStoredConfig(), raw = persistence.raw;
  let base: StoredConfig = {};
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (
        !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        JSON.stringify(parsed) !== JSON.stringify(config.storedConfig)
      ) {
        conflict(
          "Configuration changed externally; reload deployment before editing access.",
        );
      }
      base = freezeBase(parsed);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      conflict("Invalid stored configuration; original bytes retained.");
    }
  } else if (config.storedConfig !== null) {
    conflict("Stored configuration changed externally.");
  }
  const assertCurrent = () => {
    if (
      state.config !== config || state.auth !== auth ||
      state.lifecycle !== lifecycle ||
      lifecycle?.epoch !== epoch || config.authType !== authType ||
      config.setupRequired !== setupRequired ||
      JSON.stringify(config.storedConfig) !== stored ||
      revision(config) !== savedRevision ||
      config.readOnlySettings !== readOnlySettings ||
      config.settingsWritable !== settingsWritable
    ) conflict("Access settings changed while this request was pending.");
    assertPersistence(config, persistence);
  };
  const signature = await contentSignature(raw);
  assertCurrent();
  const view = {
    mode: authType === AuthType.TOTP ? "password" : authType,
    username: auth?.username ?? "",
    totpEnabled: auth?.isTotpEnabled ?? false,
    readOnlySettings,
    settingsWritable,
    revision: savedRevision,
    signature,
    lastUpdateId: config.storedConfig?.access_update_id ?? null,
    pinned: {
      mode: false,
      username: false,
      password: false,
      totp: false,
      readOnlySettings: false,
      sessions: false,
    },
  };
  return { view, base, persistence, config, auth, assertCurrent };
}
export async function accessView() {
  return (await captureAccessSnapshot()).view;
}
export async function updateAccess(
  req: Request,
  input: unknown,
  admittedGuard?: () => void,
) {
  const guard = admittedGuard ?? await settingsWriteGuard(req);
  guard();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(422, "Access settings require an object.");
  }
  const data = input as Record<string, unknown>;
  if (
    typeof data.mode !== "string" ||
    !["password", "none", "read_only"].includes(data.mode)
  ) {
    throw new HttpError(422, "Invalid access mode.");
  }
  const fields = [
    "mode",
    "username",
    "password",
    "totpEnabled",
    "totpKey",
    "totpCode",
    "readOnlySettings",
    "revision",
    "signature",
    "currentPassword",
    "currentTotp",
    "updateId",
  ];
  if (Object.keys(data).some((key) => !fields.includes(key))) {
    throw new HttpError(422, "Unsupported access setting.");
  }
  for (
    const key of [
      "username",
      "password",
      "totpKey",
      "totpCode",
      "currentPassword",
      "currentTotp",
      "signature",
    ]
  ) {
    if (data[key] !== undefined && typeof data[key] !== "string") {
      throw new HttpError(422, `${key} must be text.`);
    }
  }
  for (const key of ["totpEnabled", "readOnlySettings"]) {
    if (data[key] !== undefined && typeof data[key] !== "boolean") {
      throw new HttpError(422, `${key} must be a boolean.`);
    }
  }
  if (
    data.updateId !== undefined &&
    (typeof data.updateId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(data.updateId))
  ) throw new HttpError(422, "Invalid access update identity.");
  const snapshot = await captureAccessSnapshot(), before = snapshot.view;
  if (
    data.revision !== before.revision || data.signature !== before.signature
  ) {
    conflict(
      "Access settings changed; review current configuration before retrying.",
    );
  }
  const { auth, config } = snapshot;
  const protectedMode = data.mode === "password";
  const enabled = protectedMode &&
    (data.totpEnabled ?? before.totpEnabled) === true;
  const mode = protectedMode
    ? enabled ? AuthType.TOTP : AuthType.PASSWORD
    : data.mode === "none"
    ? AuthType.NONE
    : AuthType.READ_ONLY;
  const username = protectedMode
    ? ((data.username as string | undefined) ?? before.username).trim()
      .toLowerCase()
    : before.username;
  const password = data.password as string | undefined;
  const newKey = data.totpKey as string | undefined;
  if (protectedMode && (!username || (!auth && !password))) {
    throw new HttpError(
      400,
      "Username and password are required to create password protection.",
    );
  }
  if (password !== undefined && !password) {
    throw new HttpError(
      400,
      "A new password cannot be empty; omit it to keep the current password.",
    );
  }
  if (
    (!enabled && (newKey !== undefined || data.totpCode !== undefined)) ||
    (newKey === "")
  ) throw new HttpError(422, "Invalid authenticator enrolment.");
  const enrollment = enabled && (!before.totpEnabled || newKey !== undefined)
    ? pendingTotpEnrollments(config).confirm("access", newKey, data.totpCode)
    : undefined;
  const securityChanged = protectedMode &&
    (!auth || username !== before.username || password !== undefined ||
      enabled !== before.totpEnabled || newKey !== undefined);
  const readOnlySettings = data.readOnlySettings ??
    (before.mode === "none"
      ? before.readOnlySettings
      : data.mode === "none"
      ? true
      : before.readOnlySettings);
  const newHash = password !== undefined
    ? await hashPassword(password)
    : undefined;
  const commit = async () => {
    guard();
    snapshot.assertCurrent();
    enrollment?.assertCurrent();
    if (auth) {
      if (typeof data.currentPassword !== "string") {
        throw new HttpError(
          401,
          "Confirm your current password and authenticator before changing access.",
        );
      }
      try {
        await auth.confirmCredentials(
          data.currentPassword,
          data.currentTotp as string | undefined,
        );
      } catch {
        throw new HttpError(
          401,
          "Current password or authenticator confirmation failed.",
        );
      }
    }
    guard();
    snapshot.assertCurrent();
    enrollment?.assertCurrent();
    const next: StoredConfig = {
      ...snapshot.base,
      auth_type: mode,
      read_only_settings: readOnlySettings as boolean,
      access_revision: before.revision + 1,
      access_update_id: data.updateId as string | undefined ??
        createUuid(),
    };
    if (protectedMode) {
      if (!auth || data.username !== undefined) next.username = username;
      if (newHash !== undefined) next.password_hash = newHash;
      if (enabled && newKey !== undefined) {
        next.totp_key = newKey;
        next.totp_key_encoding = enrollment!.encoding;
      }
      if (securityChanged) {
        next.secret_key = [...crypto.getRandomValues(new Uint8Array(32))].map((
          byte,
        ) => byte.toString(16).padStart(2, "0")).join("");
      }
    }
    if (!enabled) {
      delete next.totp_key;
      delete next.totp_key_encoding;
    }
    try {
      config.saveStoredConfig(next, snapshot.persistence);
    } catch (error) {
      if (error instanceof StoredConfigConflict) {
        conflict("Configuration changed before access commit.");
      }
      throw error;
    }
    const authorizationChanged = config.authType !== mode || securityChanged;
    const previouslyWritable = config.authType !== AuthType.READ_ONLY;
    config.authType = mode;
    config.setupRequired = false;
    state.auth = protectedMode
      ? securityChanged ? new LocalAuth(config) : auth
      : null;
    if (state.auth?.isTotpEnabled && securityChanged) {
      state.auth.markTotpUsed(
        newKey !== undefined ? String(data.totpCode) : String(data.currentTotp),
      );
    }
    if (authorizationChanged) state.lifecycle?.bumpEpoch();
    if (previouslyWritable !== (mode !== AuthType.READ_ONLY)) {
      state.plugins?.runtime?.suspend();
      state.plugins?.stop();
    }
    state.lifecycle?.notifyInvalidation("catalog");
    await enrollment?.complete();
    return {
      view: await accessView(),
      requiresLogin: protectedMode && securityChanged,
    };
  };
  const result = state.lifecycle
    ? await state.lifecycle.gate.run(commit)
    : await commit();
  // Settings-only locking leaves unrelated plugin owners intact.
  if (before.mode !== data.mode) await state.plugins?.runtime?.reconcile();
  return result;
}

const json = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { headers: { "content-type": "application/json" } });
const UPDATE_FIELDS = [
  "revision",
  "signature",
  "updateId",
  "everybody",
  "grants",
  "additions",
];

function parseAccessChange(input: unknown) {
  if (
    !record(input) ||
    Object.keys(input).some((key) => !UPDATE_FIELDS.includes(key))
  ) {
    throw new HttpError(422, "Invalid vault access change.");
  }
  const { revision, signature, updateId, everybody, grants, additions } = input;
  if (
    !integer(revision) || typeof signature !== "string" ||
    !identity(updateId) ||
    !isEverybodyLevel(everybody) || !record(grants)
  ) throw new HttpError(422, "Invalid vault access change.");
  const named: Record<string, AccessLevel> = {};
  for (const [id, level] of Object.entries(grants)) {
    if (!identity(id) || !isAccessLevel(level)) {
      throw new HttpError(422, "Invalid named grant.");
    }
    named[id] = level;
  }
  function invalidExact(): never {
    throw new HttpError(422, "Invalid exact-login grant.");
  }
  const exact = parseDenseArray(
    additions === undefined ? [] : additions,
    (entry) => {
      if (!record(entry) || !fields(entry, ["login", "level"])) {
        invalidExact();
      }
      const { login, level } = entry;
      if (typeof login !== "string" || !isAccessLevel(level)) {
        invalidExact();
      }
      return { login, level };
    },
    invalidExact,
  );
  return { revision, signature, updateId, everybody, grants: named, exact };
}

/** Prepared v3 vault Access workflow; the active legacy entries above remain
 * until cutover. Every read and edit is admitted by the target's live Admin
 * lease. Only lease-bound bodies leave it, including the self-demotion ACK. */
export class VaultAccess {
  readonly authority: InstanceAuthority;
  readonly vault: AuthorityVault;
  constructor(authority: InstanceAuthority, vault: AuthorityVault) {
    this.authority = authority;
    this.vault = Object.freeze({ ...vault });
  }
  /** P05 target Admin; never a guest or another bound vault. */
  admit(principal: Principal) {
    if (
      !sameAuthorityVault(
        readAuthorityState((context) => this.authority.currentVault(context)),
        this.vault,
      )
    ) {
      throw new HttpError(404, "Vault unavailable.");
    }
    return this.authority.lease(principal, "manageVault");
  }
  /** Exact login only, deliberately no account-list/search operation. */
  #exact(login: string) {
    const normalized = parseLoginName(login);
    return normalized === null
      ? null
      : this.authority.sessions.accounts.byLogin(normalized);
  }
  async view(principal: Principal, signal?: AbortSignal) {
    const admin = this.admit(principal);
    const accounts = this.authority.sessions.accounts, acl = this.vault.acl;
    const snapshot = acl.capture();
    const view = await acl.view();
    const disclosure = this.authority.vaultDisclosure(
      admin.principal as AccountPrincipal,
      this.vault,
      snapshot,
      { admin, signal },
    );
    const named = Object.entries(view.grants).map(([id, level]) =>
      Object.freeze({ id, login: accounts.byId(id)?.login ?? null, level })
    );
    return disclosure.body(
      disclosure.prepare(
        Object.freeze({ ...view, named: Object.freeze(named) }),
      ),
    );
  }
  resolve(principal: Principal, login: unknown, signal?: AbortSignal) {
    const admin = this.admit(principal);
    if (typeof login !== "string") {
      throw new HttpError(422, "Invalid exact login.");
    }
    const disclosure = this.authority.vaultDisclosure(
      admin.principal as AccountPrincipal,
      this.vault,
      this.vault.acl.capture(),
      { admin, signal },
    );
    const account = this.#exact(login);
    return disclosure.body(disclosure.prepare(
      account ? Object.freeze({ id: account.id, login: account.login }) : null,
    ));
  }
  async update(principal: Principal, input: unknown, signal?: AbortSignal) {
    const lease = this.admit(principal);
    const actor = lease.principal as AccountPrincipal;
    const { revision, signature, updateId, everybody, grants, exact } =
      parseAccessChange(input);
    for (const { login, level } of exact) {
      const account = this.#exact(login);
      if (!account || Object.hasOwn(grants, account.id)) {
        throw new HttpError(409, "Exact login is missing or duplicated.");
      }
      grants[account.id] = level;
    }
    const acl = this.vault.acl,
      expected = acl.capture(),
      view = await acl.view();
    if (
      revision !== view.revision || signature !== view.signature ||
      updateId === view.updateId
    ) throw new StoredConfigConflict();
    const guard = () => {
      signal?.throwIfAborted();
      lease.assertCurrent(updateId);
    };
    guard();
    acl.save(
      { everybody, grants },
      expected,
      { updateId, actorId: actor.accountId },
      guard,
    );
    // Self-demotion retires Admin admission, not the actor's right to the
    // acknowledgment. Its capabilities are qualified by the new ACL snapshot.
    const disclosure = this.authority.vaultDisclosure(
      actor,
      this.vault,
      acl.capture(),
      { signal },
    );
    return disclosure.body(disclosure.prepare(Object.freeze({
      updateId,
      committed: true as const,
      capabilities: this.authority.capabilities(actor, this.vault),
    })));
  }
  /** Actor-bound lost-reply status. A demoted actor learns only whether its own
   * update is the current ACL revision, never the grants or another actor's edit. */
  outcome(principal: Principal, updateId: unknown, signal?: AbortSignal) {
    if (principal.kind !== "account") throw new AuthenticationError();
    this.authority.sessions.assertCurrent(principal);
    if (
      !identity(updateId) ||
      !sameAuthorityVault(
        readAuthorityState((context) => this.authority.currentVault(context)),
        this.vault,
      )
    ) throw new HttpError(422, "Invalid outcome request.");
    const snapshot = this.vault.acl.capture();
    const disclosure = this.authority.vaultDisclosure(
      principal,
      this.vault,
      snapshot,
      { signal },
    );
    return disclosure.body(disclosure.prepare(Object.freeze({
      matched: snapshot.value.updateId === updateId &&
        snapshot.value.updateActorId === principal.accountId,
      capabilities: this.authority.capabilities(principal, this.vault),
    })));
  }
}
/** Injection-only adapters, not discovered on the active legacy route tree. */
export function vaultAccessHandlers(
  workflow: VaultAccess,
  principal: (request: Request) => Promise<Principal>,
) {
  return Object.freeze({
    async get(request: Request) {
      return json(
        await workflow.view(await principal(request), request.signal),
      );
    },
    async put(request: Request) {
      const admitted = await principal(request);
      workflow.admit(admitted);
      return json(
        await workflow.update(
          admitted,
          await readRequestJson(request),
          request.signal,
        ),
      );
    },
    async resolve(request: Request, login: string) {
      return json(
        workflow.resolve(await principal(request), login, request.signal),
      );
    },
    async outcome(request: Request, updateId: string) {
      return json(
        workflow.outcome(await principal(request), updateId, request.signal),
      );
    },
  });
}
