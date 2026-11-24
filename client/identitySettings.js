// SPDX-License-Identifier: LGPL-3.0-only
import { shallowRef, watch } from "vue";
import { createAccountSettingsState } from "./accountSettingsState.js";
import { createIdentityAccessSettingsState } from "./identityAccessSettingsState.js";
import { resolveParticipants } from "./sessionActions.js";
import { getToastOptions } from "./helpers.js";
import { createOwnershipScope } from "../shared/ownership.js";

// Authority revisions may change as a result of this very form's write. Its
// retained identity is the account, credential and concrete target, not that
// revision. New writes still require the controller's live permission checks.
function retainedScope(session, account, vault) {
  const token = session.tokens.getStoredToken();
  const credentialCurrent = session.captureCredential?.() ?? (() => session.tokens.getStoredToken() === token);
  const key = account == null ? null : JSON.stringify([account, vault]);
  return () => account != null && session.key() != null && session.snapshot().accountId === account &&
    credentialCurrent() &&
    (vault == null || session.snapshot().vaultId == null || session.snapshot().vaultId === vault) ? key : null;
}

function accountAdapters({ session, navigate, toast, account = {} }) {
  return { ...account, token: () => session.isDisposed?.() ? null : session.tokens.getStoredToken(),
    captureCredential: session.captureCredential,
    clearToken: () => session.tokens.clearStoredToken(), retire: session.invalidate,
    logout: session.logout, consumeProof: session.consumeLoginProof,
    beginHandoff: session.beginCredentialHandoff,
    signedOut: async value => {
      toast.add(getToastOptions(value.message, "Sign in", "info"));
      await navigate({ name: "login" });
    } };
}

/** Instance Account is independent of vault access, including at None. */
export function createIdentityAccountPage(options) {
  const { session } = options;
  return createAccountSettingsState({ ...accountAdapters(options),
    sessionKey: retainedScope(session, session.snapshot().accountId, null) });
}

/** Prepared Settings composition. No production session or route is installed.
 * Excluding the submitter from a departure decision must not end its custody. */
export function createIdentitySettingsControllers({ session, config = session.snapshot, navigate,
  toast, confirmDeparture = async () => "cancel", resolve = resolveParticipants,
  account: accountIO, access: accessIO } = {}) {
  let excluded = null, disposed = false, closing = null, resolvingDeparture = false;
  const custody = createOwnershipScope();
  const identity = () => [config().accountId, session.key(), session.tokens.getStoredToken()];
  let activeIdentity = identity();
  const sameIdentity = () => identity().every((value, index) => value === activeIdentity[index]);
  const active = shallowRef();
  async function before(kind) {
    excluded = kind;
    try { return await resolve(kind === "account" ? "changing your credentials" : "changing your access") === "proceed"; }
    finally { excluded = null; }
  }
  function create() {
    const id = config().accountId, vault = config().vaultId;
    const account = createAccountSettingsState({
      ...accountAdapters({ session, navigate, toast, account: accountIO }),
      sessionKey: retainedScope(session, id, null),
      resolve: async () => await before("account") ? "proceed" : "cancel",
    });
    custody.defer(async () => { (await account.dispose()).throwIfFailed(); });
    const access = createIdentityAccessSettingsState({ ...accessIO,
      token: () => session.isDisposed?.() ? null : session.tokens.getStoredToken(), sessionKey: retainedScope(session, id, vault),
      canManage: () => session.key() != null && config().accountId === id && config().vaultId === vault && config().capabilities?.canManageVault === true,
      currentAccount: () => ({ id, login: config().principal?.login }),
      beforeCommit: () => before("access"), confirmDeparture,
      completed: () => { void session.refresh(); },
      notify: value => toast.add(getToastOptions(value.detail, value.summary, "success")),
    });
    custody.defer(async () => { const reports = await access.dispose(); const errors = reports.flatMap(report => report.errors); if (errors.length) throw new AggregateError(errors, "Access cleanup failed"); });
    return { account, access };
  }
  active.value = create();
  const retainedWork = () => ["account", "access"].filter(kind => active.value[kind].retainedWork());
  const work = () => retainedWork().filter(kind => kind !== excluded);
  // Publish the clean replacement before invoking old cleanup, which may reenter.
  // G5 owns late reads; P02 joins their cleanup at whole-composition disposal.
  function replace(reload = true) {
    if (disposed || resolvingDeparture || session.key() == null || sameIdentity() || retainedWork().length) return false;
    const previous = active.value;
    const visible = ["account", "access"].filter(kind => previous[kind].state.view || previous[kind].state.loading);
    activeIdentity = identity();
    active.value = create();
    void previous.account.dispose(); void previous.access.dispose();
    if (reload) for (const kind of visible) void active.value[kind].load();
    return true;
  }
  const stop = watch([() => config().accountId, session.key, () => session.tokens.getStoredToken(),
    () => retainedWork().length], () => replace(), { flush: "sync" });
  const departurePages = () => work().map(kind => ({ page: { label: kind === "account" ? "Your account" : "Access" },
    canSave: kind === "access" && active.value.access.state.canSave,
    uncertain: kind === "access" && (active.value.access.state.unknown || active.value.access.state.provisioningUnknown) }));
  return Object.freeze({ sessionKey: session.key, captureSession: session.capture, captureCredential: session.captureCredential,
    get account() { return active.value.account; }, get access() { return active.value.access; },
    retainedWork, work, hasWork: () => work().length > 0, departurePages,
    async settle() {
      const group = active.value;
      for (const kind of work()) if (!await group[kind].settle()) return false;
      replace(); return true;
    },
    async resolveDeparture(reason, decision) {
      const group = active.value, kinds = work();
      if (!kinds.length) { replace(); return true; }
      const pages = departurePages();
      const choice = decision ?? await confirmDeparture({ reason, pages, canSave: pages.every(page => page.canSave) });
      if (disposed || active.value !== group) return false;
      if (choice === "save") {
        if (kinds.includes("account")) return false;
        const saved = await group.access.resolveDeparture(reason, "save");
        replace(); return saved;
      }
      if (choice !== "discard") return false;
      resolvingDeparture = true;
      try { for (const kind of kinds) if (!await group[kind].discard()) return false; }
      finally { resolvingDeparture = false; }
      replace(false); return true;
    },
    dispose() {
      if (closing) return closing;
      disposed = true; stop();
      closing = Promise.resolve().then(() => custody.releaseAll());
      custody.retire();
      // Fence every child before P02 joins any one original wire. The registered
      // cached disposals still own all-attempt cleanup and its error report.
      void active.value.account.dispose(); void active.value.access.dispose();
      return closing;
    },
  });
}
