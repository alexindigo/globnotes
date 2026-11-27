// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly, ref, shallowReactive, shallowRef } from "vue";
import { createUuid } from "../shared/uuid.ts";
import { createOperationOwner } from "./operationOwner.js";
import { getStoredToken } from "./tokenStorage.js";
import { getIdentityAccess, putIdentityAccess, getIdentityAccessOutcome, postIdentityAccount, getIdentityAccountOutcome } from "./api.js";

export const accessLevels = Object.freeze([
  { value: "admin", label: "Admin" }, { value: "edit", label: "Edit" },
  { value: "view", label: "View" }, { value: "none", label: "No access" },
].map(Object.freeze));
export const accessLevelLabel = value => accessLevels.find(level => level.value === value)?.label ?? "No access";
const snapshot = values => Object.freeze({ everybody: values.everybody, grants: Object.freeze({ ...values.grants }),
  ...(values.additions ? { additions: Object.freeze(values.additions.map(row => Object.freeze({ ...row }))) } : {}) });

/** Prepared Access workflow. The form owns its original credential and drafts;
 * live Admin permission, original wire completion and receipt reads are distinct. */
export function createIdentityAccessSettingsState({ read = getIdentityAccess, write = putIdentityAccess,
  readStatus = getIdentityAccessOutcome, createAccount = postIdentityAccount, readCreation = getIdentityAccountOutcome,
  token = getStoredToken, sessionKey = token, currentAccount = () => null, canManage = () => false,
  completed = () => {}, notify = () => {}, beforeCommit = async () => true,
  confirmDeparture = async () => "cancel", timeoutMs = 5000,
} = {}) {
  const account = currentAccount();
  const form = Object.freeze({ scope: sessionKey(), token: token(), account: account ? Object.freeze({ ...account }) : null });
  const fields = reactive({ view: null, demoted: false, loading: false, needsReview: false,
    error: "", status: "", dialog: null, confirmation: null, login: "", temporaryPassword: "", level: "edit" });
  const aclAction = shallowRef(null), submission = shallowRef(null), aclReview = shallowRef(null), creation = shallowRef(null);
  const revoked = ref(false), disposed = ref(false);
  const wireCompletions = new Set();
  let ticket = 0, confirmation = null, readCompletion = null, closing = null;
  const changes = reactive(new Map());
  const everyone = Symbol("Everybody else");
  const levelAt = (view, id) => id === everyone ? view?.everybody : view?.grants[id];
  function setChange(id, next) {
    const before = levelAt(fields.view, id);
    if (before === next) changes.delete(id);
    else changes.set(id, { before, next });
  }
  const grants = computed(() => {
    const result = { ...fields.view?.grants };
    for (const [id, { next }] of changes) if (id !== everyone) {
      if (next === undefined) delete result[id];
      else result[id] = next;
    }
    return result;
  });
  const everybody = computed(() => changes.get(everyone)?.next ?? fields.view?.everybody ?? "none");
  const original = () => !disposed.value && form.scope != null && form.scope === sessionKey() && form.token === token();
  const current = () => !revoked.value && !fields.demoted && original();
  function requireLive() {
    const allowed = canManage();
    if (!allowed || !current()) throw Object.assign(Error("Original access authority retired; choices are retained."), { status: 403 });
  }
  const dirty = computed(() => changes.size > 0);
  const pending = computed(() => !!aclAction.value);
  const inFlight = computed(() => !!submission.value?.wirePending);
  const unknown = computed(() => !!submission.value?.unknown);
  const reviewing = computed(() => !!aclReview.value);
  const provisioning = computed(() => !!creation.value && (!creation.value.unknown || creation.value.checking));
  const provisioningUnknown = computed(() => !!creation.value?.unknown);
  const busy = computed(() => fields.loading || pending.value || inFlight.value || reviewing.value || provisioning.value);
  const mutable = computed(() => current() && canManage() && !!fields.view && !busy.value && !fields.confirmation && !unknown.value && !fields.needsReview && !provisioningUnknown.value);
  const editableRows = computed(() => mutable.value && !fields.dialog);
  const rows = computed(() => {
    const labels = new Map((fields.view?.named ?? []).map(row => [row.id, row.login]));
    const declared = fields.view?.declaredAdmin, ids = new Set(Object.keys(grants.value));
    if (declared?.accountId) ids.add(declared.accountId);
    return [...ids].map(id => ({ id, login: labels.get(id) ?? (id === declared?.accountId ? declared.login : id),
      level: id === declared?.accountId ? "admin" : grants.value[id], serverSet: id === declared?.accountId,
      you: id === form.account?.id, canEdit: editableRows.value && id !== declared?.accountId }));
  });
  const canReview = computed(() => original() && (unknown.value || fields.needsReview) && !pending.value && !reviewing.value && !fields.loading);
  const canCheckCreation = computed(() => original() && provisioningUnknown.value && !creation.value.checking);
  const state = readonly(reactive({ ...Object.fromEntries(Object.keys(fields).map(key => [key, computed(() => fields[key])])),
    pending, inFlight, unknown, reviewing, provisioning, provisioningUnknown,
    dirty, busy, mutable, editableRows, rows, grants, everybody, namedLevels: accessLevels, everybodyLevels: accessLevels.filter(level => level.value !== "admin"),
    dialogTitle: computed(() => fields.dialog === "create" ? "Create and add account" : "Add existing account"),
    canSave: computed(() => editableRows.value && dirty.value),
    canReview, canCheckCreation,
  }));
  // Retained work is not a renderable projection. The form still owns exact
  // receipts and departure decisions after the Admin view is withheld.
  const presentation = computed(() => canManage() && current() ? state : Object.freeze({
    status: original() && ["Access saved.", "Account created and added."].includes(fields.status) ? fields.status : "",
    canReview: original() && unknown.value && state.canReview,
    canCheckCreation: canCheckCreation.value,
    checkingCreation: original() && !!creation.value?.checking,
    error: !original() ? "" : provisioningUnknown.value ? "Check the outcome of your submitted account creation." :
      unknown.value ? "Review the outcome of your submitted access change." : "",
  }));
  const adapters = {
    owner: form,
    prepare(intent) {
      const value = { ...intent };
      if (!original()) throw Object.assign(Error("Access form is no longer current."), { status: 403 });
      if (!["acl-outcome", "create-outcome"].includes(value.kind)) requireLive();
      return { value };
    },
    dispatch(intent) {
      // Recheck after preparation getters and immediately before transport entry.
      if (!original()) throw Object.assign(Error("Access form is no longer current."), { status: 403 });
      if (!["acl-outcome", "create-outcome"].includes(intent.kind)) requireLive();
      const options = { token: form.token };
      if (intent.kind === "read") return read(options);
      if (intent.kind === "write") return write(intent.payload, options);
      if (intent.kind === "create") return createAccount(intent.payload, options);
      if (intent.kind === "acl-outcome") return readStatus(intent.id, options);
      return readCreation(intent.id, options);
    },
    channels: { view: {
      prepare(value) {
        const view = { ...value.view };
        view.grants = { ...view.grants }; view.named = view.named?.map(row => ({ ...row })); view.declaredAdmin = { ...view.declaredAdmin };
        const captured = { ...value, view };
        const allowed = canManage();
        if (!allowed || !current() || captured.ticket !== ticket || !captured.retain && dirty.value) void live.release(captured.operation);
        return { value: captured };
      },
      deliver(value) {
        const previous = fields.view;
        if (value.retain) {
          const conflicts = [];
          for (const [id, change] of changes) {
            if (levelAt(value.view, id) === change.before && id !== value.view.declaredAdmin?.accountId) continue;
            changes.delete(id);
            conflicts.push(id === everyone ? "Everybody else" : previous?.named?.find(row => row.id === id)?.login ?? id);
          }
          fields.status = conflicts.length ? `Updated by someone else: ${conflicts.join(", ")}.` : "";
        } else changes.clear();
        fields.view = value.view;
        fields.error = "";
      },
    } },
    completion: {
      prepare(value) {
        const result = { ...value.result };
        if (result.capabilities) result.capabilities = { ...result.capabilities };
        return { value: { ...value, result } };
      },
      deliver(value) {
        if (value.kind === "write") acknowledge(value.attempt, value.result);
        else acknowledgeCreation(value.attempt, value.result);
      },
    },
  };
  const live = createOperationOwner(adapters), recovery = createOperationOwner(adapters);
  async function observe(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Connection lost. Please review the current access.")), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  function start(owner, kind, intent, mode = "live") {
    const operation = owner.operation(mode);
    // G5 owns the acquisition before calling transport. This queued dispatch
    // still belongs to the captured form, never the later browser credential.
    const promise = Promise.resolve().then(() => owner.dispatch(operation, { kind, ...intent }));
    return { owner, operation, promise };
  }
  function trackWire(work, settle) {
    const wire = work.promise.then(
      handle => settle(handle.value), error => settle(undefined, error),
    ).finally(() => work.owner.release(work.operation));
    const completion = wire.catch(() => {});
    wireCompletions.add(completion);
    void completion.then(() => wireCompletions.delete(completion));
    return wire;
  }
  function releaseReview(work) {
    void work.promise.finally(() => work.owner.release(work.operation)).catch(() => {});
  }
  async function load({ retain = false } = {}, creationOwner) {
    if (!current() || !canManage() || inFlight.value || provisioning.value && creation.value !== creationOwner || !retain && (dirty.value || unknown.value || provisioningUnknown.value)) return null;
    const own = ++ticket, work = start(live, "read", {}); fields.loading = true;
    const wire = work.promise.then(handle => live.deliver(work.operation, "view", { operation: work.operation, ticket: own, view: handle.value, retain }))
      .finally(() => live.release(work.operation));
    readCompletion = wire.catch(() => {});
    try { return await observe(wire) ? fields.view : null; }
    catch (error) { if (current() && own === ticket) fields.error = error.response?.data?.detail ?? error.message; return null; }
    finally { if (own === ticket) fields.loading = false; }
  }
  function setLevel(id, level) {
    if (!editableRows.value || id === fields.view?.declaredAdmin?.accountId || !Object.hasOwn(grants.value, id) || !accessLevels.find(item => item.value === level)) return false;
    setChange(id, level); return true;
  }
  function remove(id) {
    if (!editableRows.value || id === fields.view?.declaredAdmin?.accountId || !Object.hasOwn(grants.value, id)) return false;
    setChange(id, undefined); return true;
  }
  function setEverybody(level) { if (editableRows.value && ["edit", "view", "none"].includes(level)) setChange(everyone, level); }
  function setField(name, value) {
    if (!mutable.value || !fields.dialog || !["login", "temporaryPassword", "level"].includes(name)) return;
    if (name === "level" && !accessLevels.find(item => item.value === value)) return;
    fields[name] = value;
  }
  const payload = () => snapshot({ everybody: everybody.value, grants: grants.value });
  const ownsAcl = attempt => !disposed.value && submission.value === attempt;
  function acknowledge(attempt, result) {
    if (!ownsAcl(attempt) || result.updateId !== attempt.payload.updateId || result.committed !== true) return;
    attempt.receipt = result; fields.needsReview = false; fields.error = "";
    if (result.capabilities?.canManageVault === false) fields.demoted = true;
    changes.clear(); fields.status = "Access saved.";
    if (attempt.payload.additions) fields.dialog = null;
    submission.value = null;
    if (original()) completed(result);
  }
  async function refresh() { if (current() && canManage()) await load(); }
  function preflight(before, authorize, action) {
    const own = {};
    own.observation = Promise.resolve().then(async () => {
      try {
        if (await authorize() !== true || !canManage() || !current() || before !== fields.view) return false;
      } catch {
        if (current() && aclAction.value === own) fields.error = "Access was not saved. Review your choices and try again.";
        return false;
      }
      return await action();
    }).finally(() => { if (aclAction.value === own) aclAction.value = null; });
    // Publish the owner and its join before calling even a synchronous adapter.
    aclAction.value = own;
    return own.observation;
  }
  function refuseAcl(attempt, error) {
    if (!ownsAcl(attempt)) return;
    const status = error?.response?.status ?? error?.status;
    const loginRefused = error?.response?.data?.code === "access_login_conflict";
    attempt.unknown = !status || status >= 500;
    fields.needsReview = attempt.unknown || status === 409 && !loginRefused;
    fields.error = attempt.unknown ? "Connection lost. Review current access before continuing." : loginRefused ? "The account could not be added. Check the login and try again." : "Access was not saved. Review your choices and try again.";
    if (!attempt.unknown) submission.value = null;
  }
  function commit(before, authorize = beforeCommit, additions) {
    if (!mutable.value || before !== fields.view) return aclAction.value?.observation ?? Promise.resolve(false);
    const proposed = snapshot({ ...payload(), additions });
    return preflight(before, authorize, async () => {
      const payload = Object.freeze({ ...proposed, revision: before.revision, signature: before.signature, updateId: createUuid() });
      const attempt = shallowReactive({ payload, wirePending: true, unknown: false, receipt: null });
      fields.error = ""; submission.value = attempt;
      const work = start(live, "write", { payload }, "retained");
      const wire = trackWire(work, async (result, error) => {
        if (!ownsAcl(attempt)) return !!attempt.receipt;
        if (!error) live.complete(work.operation, { kind: "write", attempt, result });
        if (!attempt.receipt) refuseAcl(attempt, error);
        attempt.wirePending = false;
        if (attempt.receipt?.capabilities?.canManageVault) await refresh();
        return !!attempt.receipt;
      });
      try { return await observe(wire); }
      catch (error) { if (!attempt.unknown) refuseAcl(attempt, error); return !!attempt.receipt; }
    });
  }
  async function requestCommit({ alreadyResolved = false } = {}) {
    if (!state.canSave) return false;
    const before = fields.view, proposed = payload();
    const oldLevel = form.account?.id === before.declaredAdmin?.accountId ? "admin" : before.grants[form.account?.id] ?? before.everybody;
    const newLevel = form.account?.id === before.declaredAdmin?.accountId ? "admin" : proposed.grants[form.account?.id] ?? proposed.everybody;
    if (oldLevel === "admin" && newLevel !== "admin") {
      return await preflight(before, alreadyResolved ? () => true : beforeCommit, () => {
        confirmation = Object.freeze({ before });
        fields.confirmation = { title: "Remove your Admin access?", login: form.account.login, current: "Admin", next: accessLevelLabel(newLevel),
          consequence: newLevel === "edit" ? "You will be able to read and edit notes, but not manage this vault's access, settings or plugins." : newLevel === "view" ? "You will only be able to read notes, not edit them or manage this vault's access, settings or plugins." : "You will not be able to open notes or manage this vault's access, settings or plugins.",
          confirmLabel: `Change my access to ${accessLevelLabel(newLevel)}` };
        return true;
      });
    }
    return await commit(before, alreadyResolved ? async () => true : beforeCommit);
  }
  function confirmChange() {
    const request = confirmation;
    if (!request || busy.value || !current() || !canManage()) return Promise.resolve(false);
    fields.confirmation = null; confirmation = null;
    return commit(request.before, async () => true);
  }
  async function review() {
    if (!canReview.value) return false;
    const attempt = submission.value, own = {};
    aclReview.value = own;
    const ownsReview = () => original() && aclReview.value === own && (attempt ? ownsAcl(attempt) : fields.needsReview);
    try {
      if (!attempt) {
        if (!await load({ retain: true }) || !ownsReview()) return false;
        fields.needsReview = false;
        fields.error = dirty.value ? "Current access reviewed. Save explicitly to apply your remaining choices." : "";
        return true;
      }
      const updateId = attempt.payload.updateId;
      const work = start(recovery, "acl-outcome", { id: updateId }, "retained");
      try {
        const handle = await observe(work.promise);
        const result = { ...handle.value };
        if (!ownsReview()) return false;
        if (result.matched === true) {
          recovery.complete(work.operation, { kind: "write", attempt, result: { ...result, committed: true, updateId, recovered: true } });
          if (attempt.receipt?.capabilities?.canManageVault) await refresh();
          return !!attempt.receipt;
        }
        fields.error = attempt.wirePending ? "The original access change is still pending. Review its outcome again before continuing." : "The submitted access change could not be confirmed. Your choices are retained; do not repeat it automatically.";
        return false;
      } finally { releaseReview(work); }
    } catch { if (ownsReview()) fields.error = "Connection lost. Your access choices are retained."; return false; }
    finally { if (aclReview.value === own) aclReview.value = null; }
  }
  async function discard() {
    if (disposed.value || inFlight.value || pending.value || reviewing.value || creation.value) return false;
    fields.needsReview = false; submission.value = null; fields.error = "";
    changes.clear();
    fields.dialog = null; fields.login = ""; fields.temporaryPassword = ""; confirmation = null; fields.confirmation = null;
    if (!current() || !canManage()) return true;
    return !!await load();
  }
  async function resolveDeparture(reason, decision) {
    if (aclAction.value) await aclAction.value.observation;
    if (fields.confirmation || inFlight.value || reviewing.value || provisioning.value) return false;
    if (!dirty.value && !unknown.value && !provisioningUnknown.value) return true;
    const choice = decision ?? await confirmDeparture({ reason, pages: [{ page: { label: "Access" }, uncertain: unknown.value || provisioningUnknown.value, canSave: state.canSave }], canSave: state.canSave });
    if (choice === "save") { await requestCommit({ alreadyResolved: decision !== undefined }); return !fields.confirmation && !dirty.value && !unknown.value && !inFlight.value && !creation.value; }
    if (choice === "discard") return await discard();
    return false;
  }
  async function openDialog(kind) {
    if (!mutable.value || fields.dialog || !["existing", "create"].includes(kind) || !await resolveDeparture("adding an account") || !mutable.value) return false;
    fields.dialog = kind; fields.login = ""; fields.temporaryPassword = ""; fields.level = "edit"; fields.error = ""; return true;
  }
  const ownsCreation = attempt => !disposed.value && creation.value === attempt;
  function acknowledgeCreation(attempt, result) {
    if (!ownsCreation(attempt) || result.operationId !== attempt.operationId || result.committed !== true || typeof result.accountId !== "string" || !result.accountId) return;
    attempt.committed = true;
    fields.temporaryPassword = ""; fields.error = ""; fields.status = "Account created and added.";
    if (original()) notify({ summary: "Account created and added", detail: `${attempt.login} has ${accessLevelLabel(attempt.level)} access after choosing a password.` });
    fields.dialog = null;
    creation.value = null;
  }
  function refuseCreation(attempt, error) {
    if (!ownsCreation(attempt)) return;
    const status = error?.response?.status ?? error?.status;
    if (status >= 400 && status < 500) {
      fields.needsReview = status === 409 && error.response?.data?.code !== "access_login_conflict";
      fields.error = fields.needsReview ? "Access changed. Review current access before creating this account." : "The account could not be added. Check the login and try again.";
      creation.value = null;
    } else attempt.unknown = true;
  }
  async function submitDialog() {
    if (!mutable.value || !fields.dialog || !fields.login.trim()) return false;
    if (fields.dialog === "existing") {
      return await commit(fields.view, beforeCommit, [{ login: fields.login, level: fields.level }]);
    }
    if (!fields.temporaryPassword) { fields.error = "Enter a temporary password."; return false; }
    const payload = Object.freeze({ login: fields.login, temporaryPassword: fields.temporaryPassword, level: fields.level,
      revision: fields.view.revision, signature: fields.view.signature, operationId: createUuid() });
    const attempt = shallowReactive({ operationId: payload.operationId, login: payload.login, level: payload.level,
      unknown: false, checking: false, committed: false });
    fields.error = ""; creation.value = attempt;
    const work = start(live, "create", { payload }, "retained");
    const wire = trackWire(work, async (result, error) => {
      if (!ownsCreation(attempt)) return;
      if (!error) live.complete(work.operation, { kind: "create", attempt, result });
      if (attempt.committed) await refresh();
      else refuseCreation(attempt, error);
    });
    try { await observe(wire); }
    catch { if (ownsCreation(attempt)) attempt.unknown = true; }
    if (ownsCreation(attempt)) await reviewCreation();
    return attempt.committed;
  }
  async function reviewCreation() {
    const attempt = creation.value;
    if (!canCheckCreation.value) return false;
    attempt.checking = true;
    const work = start(recovery, "create-outcome", { id: attempt.operationId }, "retained");
    try {
      const handle = await observe(work.promise), result = { ...handle.value };
      if (!original() || !ownsCreation(attempt)) return attempt.committed;
      if (result.committed === true) {
        recovery.complete(work.operation, { kind: "create", attempt, result });
        if (attempt.committed) { await refresh(); return true; }
        throw Error("Missing account outcome.");
      }
      if (result.committed !== false || result.operationId !== attempt.operationId) throw Error("Missing account outcome.");
      // A browser rejection cannot prove server settlement, and an unqualified
      // absence may have been sampled before the server admitted the POST.
      if (result.settled !== true) {
        fields.error = "The original account creation is still pending. Check its outcome again before continuing."; return false;
      }
      fields.temporaryPassword = "";
      await load({ retain: true }, attempt);
      if (original() && ownsCreation(attempt)) {
        fields.error = "The account was not added. Check your details and try again.";
        if (!current() || !canManage()) { fields.dialog = null; fields.login = ""; }
        creation.value = null;
      }
      return attempt.committed;
    } catch { if (original() && ownsCreation(attempt)) fields.error = "Connection lost. Please try checking this account creation again."; return attempt.committed; }
    finally { attempt.checking = false; releaseReview(work); }
  }
  return { state, get presentation() { return presentation.value; }, load: options => load(options), requestCommit, confirmChange, review, discard, resolveDeparture, setLevel, setEverybody, remove, setField, openDialog, submitDialog, reviewCreation,
    retainedWork: () => dirty.value || pending.value || !!submission.value || fields.needsReview || !!creation.value || !!fields.confirmation || !!fields.dialog,
    cancelConfirmation() { if (!busy.value) { confirmation = null; fields.confirmation = null; } },
    cancelDialog() { if (!busy.value && !creation.value) { fields.dialog = null; fields.temporaryPassword = ""; } },
    hasWork: () => dirty.value || pending.value || !!submission.value || !!creation.value || !!fields.confirmation || live.hasWork() || recovery.hasWork(),
    async settle() {
      try {
        await observe((async () => {
          if (aclAction.value) await aclAction.value.observation;
          await Promise.all([...wireCompletions, readCompletion]);
          await Promise.all([live.settle(), recovery.settle()]);
        })());
      } catch { return false; }
      return !inFlight.value && !provisioning.value;
    },
    invalidate() { if (dirty.value || unknown.value || creation.value || busy.value) return false; ticket++; fields.view = null; return true; },
    revoke() { revoked.value = true; live.revoke(); },
    dispose() {
      if (closing) return closing;
      disposed.value = true; ticket++; fields.temporaryPassword = ""; confirmation = null; fields.confirmation = null; creation.value = null; submission.value = null;
      closing = Promise.all([live.dispose(), recovery.dispose()]); return closing;
    },
  };
}
