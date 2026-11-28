// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { StoredConfigConflict } from "../config/file_store.ts";
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
import { AccessLoginConflict } from "./access_login_conflict.ts";
import { deliveryJsonBody, singleIdentityVault } from "./http_policy.ts";

const json = (body: ReadableStream<Uint8Array>) =>
  new Response(body, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
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

/** Every read and edit is admitted by the target's live Admin lease. Only
 * lease-bound bodies leave it, including the self-demotion ACK. */
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
    for (const { login, level } of exact) {
      const account = this.#exact(login);
      if (!account || Object.hasOwn(grants, account.id)) {
        throw new AccessLoginConflict();
      }
      grants[account.id] = level;
    }
    acl.save(
      { everybody, grants },
      expected,
      { updateId, actorId: actor.accountId },
      guard,
    );
    // The original request owns the exact receipt even if a peer publishes
    // a newer ACL. Only the caller's own current capabilities accompany it.
    const capabilities = this.authority.vaultUpdateReceipt(
      actor,
      this.vault,
      signal,
    );
    return deliveryJsonBody(() => ({
      updateId,
      committed: true as const,
      capabilities: capabilities(),
    }));
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
      const lease = workflow.admit(admitted);
      const input = await readRequestJson(request);
      lease.assertCurrent();
      try {
        return json(await workflow.update(admitted, input, request.signal));
      } catch (error) {
        if (error instanceof AccessLoginConflict) return error.response();
        throw error;
      }
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

/** Branch of the existing status route; receipt reads never reopen the
 * Admin-only Access list. */
export function identityAuthCheck(
  request: Request,
  workflow: VaultAccess,
  principal: (request: Request) => Promise<Principal>,
  status: (request: Request) => Response | Promise<Response>,
) {
  const ids = new URL(request.url).searchParams.getAll("accessUpdateId");
  if (!ids.length) return status(request);
  if (ids.length !== 1) throw new HttpError(422, "Invalid outcome request.");
  singleIdentityVault(workflow.vault)(request);
  return vaultAccessHandlers(workflow, principal).outcome(request, ids[0]);
}
