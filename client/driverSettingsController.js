// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly, shallowRef } from "vue";
import { getDrivers, postDriver, putDriver, deleteDriver, putDriverSecret, deleteDriverSecret, syncDriver, decideDriver } from "./api.js";
import { subscribe, TOPICS } from "./bus/index.js";
import { acquireVaultChanges } from "./vaultChanges.js";
import { validateSettingsInput } from "./settingsPageState.js";
import { visibleSettingsFields } from "./declarativeSettings.js";
import { createUnloadConfirmation } from "./unloadGuard.js";

const copy = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const conditionNotice = "This storage cannot check versions while writing; a change made there at the same moment can be overwritten.";
const statuses = { off:"Off", starting:"Starting", active:"Active", locked:"Locked", failed:"Failed", paused:"Paused" };
const reasons = { plugin_disabled:"Plugin is off", plugin_unavailable:"Plugin is unavailable", network_denied:"Network access needs approval", group_split:"This group was split at the resource limit" };

/** One Sync workflow owns drafts, retained wires and write-only inputs. No secret
 * value enters an immutable snapshot, recovery intent, bus or browser storage. */
export function createDriverSettings({ read = () => getDrivers(), create = payload => postDriver(payload), update = (id, payload) => putDriver(id, payload),
  remove = (id, payload) => deleteDriver(id, payload), setKey = (id, key, payload) => putDriverSecret(id, key, payload), clearKey = (id, key, payload) => deleteDriverSecret(id, key, payload), sync = (id, payload) => syncDriver(id, payload),
  decide = (id, payload) => decideDriver(id, payload), subscribe: on = subscribe, acquireChanges = acquireVaultChanges,
  writable = () => true, getSession = () => "sync", confirm = async () => "cancel", confirmRemove = async () => false,
  unload = createUnloadConfirmation(), clock = globalThis, timeout = 5000 } = {}) {
  const data = reactive({ loaded:false, loading:false, stale:false, error:"", notice:null, plugins:[],
    records:new Map(), adding:false, plugin:"", label:"", addError:"", busy:false, reviewing:false, unknown:false, needsReview:false, message:"" });
  const inputs = reactive(new Map()), inputVersions = new Map();
  let disposed = false, active = false, generation = 0, readTicket = 0, flight = null, dirty = false;
  const operation = shallowRef(null);
  let wire = null, releases = [], failureVersion = 0, identity = getSession();
  const inputId = (id, key) => `${id}:${key}`;
  const hasDraft = record => Object.keys(record.drafts).length > 0;
  const hasInputs = () => [...inputs.values()].some(Boolean);
  const hasWork = () => !!operation.value || data.busy || data.reviewing || data.unknown || hasInputs() || data.adding && !!data.label || [...data.records.values()].some(hasDraft);
  const updateUnload = () => unload.set(hasWork());
  const canMutate = () => !disposed && identity === getSession() && writable() && data.loaded && !data.busy && !data.reviewing && !operation.value && !data.stale;
  async function observe(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = clock.setTimeout(() => reject(Error("Sync response deadline")), timeout); })]); }
    finally { clock.clearTimeout(timer); }
  }
  function accept(result) {
    if (!Number.isSafeInteger(result?.revision) || !Array.isArray(result.instances) || !Array.isArray(result.plugins)) throw Error("Invalid Sync view");
    data.plugins = copy(result.plugins); data.notice = result.notice;
    const ids = new Set();
    for (const instance of result.instances) {
      ids.add(instance.id);
      let record = data.records.get(instance.id);
      if (!record) {
        record = reactive({ base:copy(instance), drafts:{}, versions:{}, errors:{}, changed:false, missing:false, draftDeclaration:null });
        data.records.set(instance.id, record);
      } else {
        if (hasDraft(record) && (record.base.revision !== instance.revision || !equal(record.base.declaration, instance.declaration))) record.changed = true;
        record.base = copy(instance); record.missing = false;
      }
    }
    for (const [id, record] of data.records) if (!ids.has(id)) {
      if (hasDraft(record) || [...inputs].some(([key, value]) => key.startsWith(`${id}:`) && value)) record.missing = true;
      else data.records.delete(id);
    }
    data.loaded = true; data.stale = false; data.error = "";
  }
  async function refresh() {
    if (disposed || !active) return false;
    if (identity !== getSession()) {
      if (hasWork()) { data.stale = true; data.error = "The session changed. Your Sync work is retained for recovery in its original session."; return false; }
      identity = getSession(); generation++; data.records.clear(); data.loaded = false;
    }
    if (data.busy) { dirty = true; return false; }
    if (flight) { dirty = true; return flight; }
    const own = generation, ticket = ++readTicket;
    data.loading = true;
    const work = (async () => {
      await Promise.resolve();
      try {
        const result = await observe(Promise.resolve().then(read));
        if (disposed || identity !== getSession() || own !== generation || ticket !== readTicket || dirty) return false;
        accept(result); return true;
      } catch {
        if (!disposed && own === generation && ticket === readTicket) { data.error = "Could not load sync settings. Your edits are retained."; data.stale = true; }
        return false;
      } finally {
        if (!disposed && own === generation && ticket === readTicket) {
          flight = null; data.loading = false;
          if (dirty) { dirty = false; void refresh(); }
        }
      }
    })();
    flight = work; return work;
  }
  function activate() {
    if (active || disposed) return;
    active = true;
    releases = [on(TOPICS.VAULT_DRIVERS, refresh), on(TOPICS.VAULT_RESET, refresh)];
    releases.push(acquireChanges()); void refresh();
  }
  function values(record) {
    return { label:record.drafts.label ?? record.base.label, enabled:record.drafts.enabled ?? record.base.enabled, settings:{ ...record.base.settings, ...record.drafts.settings } };
  }
  function snapshotRecord(record) {
    const base = record.base, draft = values(record), available = !record.missing && !!base.declaration;
    const schemaChanged = !!record.draftDeclaration && !equal(record.draftDeclaration, base.declaration);
    const editable = writable() && available && !schemaChanged;
    const canWrite = canMutate() && available && !record.changed && !schemaChanged;
    const fields = visibleSettingsFields({ fields:(record.draftDeclaration ?? base.declaration)?.settings ?? [] }, draft.settings).map(field => ({
      field, id:`driver-${base.id}-${field.key}`, value:record.drafts.settings && Object.hasOwn(record.drafts.settings, field.key) ? record.drafts.settings[field.key] : base.settings[field.key],
      display:String(draft.settings[field.key] ?? ""), error:record.errors[field.key] ?? "",
    }));
    const hasKeyInput = base.secrets.some(secret => !!inputs.get(inputId(base.id, secret.key)));
    const secrets = base.secrets.map(secret => {
      const name = inputId(base.id, secret.key);
      // Live getters deliberately avoid copying password strings into old snapshots.
      return { ...secret, id:`driver-key-${base.id}-${secret.key}`, get input() { return inputs.get(name) ?? ""; },
        get canSave() { return canWrite && !!inputs.get(name); }, canClear:canWrite && secret.set };
    });
    const attention = base.attention;
    return { ...base, label:draft.label, enabled:draft.enabled, enabledDraftLabel:Object.hasOwn(record.drafts,"enabled") ? `Your ${draft.enabled ? "On" : "Off"} choice is retained. Save settings to apply it.` : "", labelError:record.errors.label ?? "", fields, secrets, editable, missing:record.missing, changed:record.changed, schemaChanged,
      dirty:hasDraft(record), stateLabel:statuses[base.status] ?? base.status,
      reasonLabel:reasons[base.reason] ?? base.reason ?? base.error?.message ?? base.error?.code ?? "",
      lastSyncLabel:base.lastSync ? new Date(base.lastSync).toLocaleString() : "",
      retryLabel:base.nextRetry !== null ? `Next retry in ${Math.ceil(base.nextRetry / 1000)} seconds` : "",
      conditionNotice:Object.values(base.declaration?.capabilities?.mutations ?? {}).includes("emulated") ? conditionNotice : "",
      attentionCount:(attention?.held.length ?? 0) + (attention?.remoteEmpty?.files.length ?? 0) + (attention?.issues.length ?? 0),
      attentionNotices:(attention?.notices ?? []).map(notice => reasons[notice] ?? notice),
      canSave:canWrite && hasDraft(record) && !Object.keys(record.errors).length,
      canToggle:canWrite && !hasDraft(record) && !hasKeyInput, canSync:canWrite && base.enabled && !hasDraft(record), canRemove:canWrite && !hasDraft(record) && !hasKeyInput,
      canDecide:canWrite && !hasDraft(record) && !!attention, canDiscard:hasDraft(record) && !data.busy && !data.unknown,
    };
  }
  const state = readonly(reactive({ ...Object.fromEntries(Object.keys(data).filter(key => key !== "records").map(key => [key, computed(() => data[key])])),
    instances:computed(() => [...data.records.values()].map(snapshotRecord)),
    canAdd:computed(() => canMutate() && !!data.plugins.length), canCreate:computed(() => canMutate() && data.adding && !!data.label.trim() && data.plugins.some(plugin => plugin.id === data.plugin)),
    canReview:computed(() => !data.busy && !data.reviewing && (!!operation.value || [...data.records.values()].some(record => record.changed))),
    canDiscardChoice:computed(() => !!operation.value && !data.busy && !data.unknown && !data.needsReview),
  }));
  function edit(id, key, raw) {
    const record = data.records.get(id); if (!record || !writable()) return false;
    record.draftDeclaration ??= copy(record.base.declaration);
    if (key === "label") {
      record.drafts.label = raw;
      if (!raw.trim() || raw.length > 128) record.errors.label = "Enter a label of 1 to 128 characters."; else delete record.errors.label;
    } else {
      const field = record.base.declaration?.settings.find(field => field.key === key); if (!field) return false;
      (record.drafts.settings ??= {})[key] = raw;
      const checked = validateSettingsInput(field, raw);
      if (checked.error) record.errors[key] = checked.error; else delete record.errors[key];
    }
    record.versions[key] = (record.versions[key] ?? 0) + 1; updateUnload(); return true;
  }
  function editKey(id, key, value) {
    if (!writable() || !data.records.get(id)?.base.secrets.some(secret => secret.key === key)) return false;
    const name = inputId(id, key); inputs.set(name, value); inputVersions.set(name, (inputVersions.get(name) ?? 0) + 1); updateUnload(); return true;
  }
  function acknowledged(target, result) {
    if (disposed || identity !== getSession() || operation.value !== target || target.generation !== generation) return false;
    if (target.kind === "remove" ? result?.removed !== true || result.id !== target.id : !Number.isSafeInteger(result?.revision) || typeof result.id !== "string" || target.kind !== "create" && result.id !== target.id) throw Error("Incomplete sync acknowledgement");
    const record = data.records.get(target.id);
    if (target.kind === "update" && record) {
      record.base = { ...record.base, ...copy(target.payload), revision:result.revision };
      for (const [key, version] of Object.entries(target.versions)) if (record.versions[key] === version) {
        if (key === "label" || key === "enabled") delete record.drafts[key];
        else { delete record.drafts.settings?.[key]; if (!Object.keys(record.drafts.settings ?? {}).length) delete record.drafts.settings; }
        delete record.errors[key];
      }
      if (!hasDraft(record)) record.draftDeclaration = null;
    }
    if (record && target.kind === "key") record.base.revision = result.revision;
    if (target.kind === "remove") data.records.delete(target.id);
    if (target.kind === "create") { data.adding = false; data.label = ""; }
    operation.value = null; data.unknown = data.needsReview = false; data.message = "Saved.";
    // Control receipts do not contain a fresh attention token or full state.
    // Keep subsequent actions unavailable until the owning snapshot observes it.
    data.stale = true;
    if (active) void refresh();
    updateUnload(); return true;
  }
  async function dispatch(kind, id, payload, send, extra = {}) {
    if (!canMutate()) return false;
    const target = { kind, id, payload, generation, ...extra };
    operation.value = target; data.busy = true; data.message = "Saving sync settings..."; data.error = "";
    ++readTicket; flight = null; data.loading = false; updateUnload();
    let observed = false;
    const original = Promise.resolve().then(() => {
      if (disposed || identity !== getSession() || target.generation !== generation || !writable()) throw Object.assign(Error("Retired sync request"), { unsent:true });
      return send();
    }); wire = original;
    original.then(result => {
      if (!observed && data.unknown) {
        try { acknowledged(target, result); } catch { /* malformed late replies retain review */ }
      }
    }, () => {}).finally(() => {
      // A settled PUT releases its captured password even on a refused/unknown reply.
      if (extra.secret) {
        if (inputVersions.get(extra.secret) === extra.secretVersion) inputs.delete(extra.secret);
        if (payload) payload.value = "";
      }
      if (wire === original) { wire = null; data.busy = false; updateUnload(); }
      if (!disposed && active) { dirty = false; void refresh(); }
    }).catch(() => {});
    try {
      const result = await observe(original); observed = true;
      return acknowledged(target, result);
    } catch (error) {
      if (disposed || operation.value !== target) return false;
      const status = error.response?.status, code = error.response?.data?.code;
      const known = error.unsent || status && status < 500 && code !== "operation_partial";
      data.unknown = !known; data.needsReview = true; failureVersion++;
      data.message = known ? "Sync settings changed or the request was refused. Review current state; your edits are retained." : "The sync request outcome is unknown. Review current state before another explicit choice.";
      return false;
    }
  }
  async function refreshSnapshot() {
    const own = generation;
    try {
      await observe((async () => {
        // Joining an owned post-write read must not invalidate it and thereby
        // turn its failure into an unsolicited follow-up read.
        if (flight) await flight; else await refresh();
        // Own the accepted follow-up when invalidations supersede a read.
        while (flight && !disposed && own === generation) await flight;
      })());
      return !disposed && own === generation && identity === getSession() && !data.stale && data.loaded;
    } catch { return false; }
  }
  async function review() {
    if (disposed || data.busy || data.reviewing) return false;
    const target = operation.value, own = generation;
    data.reviewing = true; updateUnload();
    try {
      if (!await refreshSnapshot()) return false;
      if (disposed || own !== generation || identity !== getSession() || target !== operation.value || data.stale || !data.loaded) return false;
      // A rejected transport may still have reached the server. Fresh CAS bases,
      // not equality of write-only key status, fence the next explicit operation.
      operation.value = null; data.unknown = data.needsReview = false;
      for (const record of data.records.values()) record.changed = false;
      data.message = "Current sync state reviewed. Your edits are retained; choose explicitly to apply them.";
      return true;
    } catch { return false; }
    finally { data.reviewing = false; updateUnload(); }
  }
  async function save(id) {
    const record = data.records.get(id); if (!record || !snapshotRecord(record).canSave) return false;
    const draft = values(record), settings = { ...record.base.settings };
    for (const field of record.base.declaration.settings) if (record.drafts.settings && Object.hasOwn(record.drafts.settings, field.key)) settings[field.key] = validateSettingsInput(field, draft.settings[field.key]).value;
    const payload = { revision:record.base.revision, label:draft.label, settings, enabled:draft.enabled };
    return dispatch("update", id, payload, () => update(id, payload), { versions:{ ...record.versions } });
  }
  function toggle(id) {
    const record = data.records.get(id); if (!record || !snapshotRecord(record).canToggle) return false;
    const payload = { revision:record.base.revision, label:record.base.label, settings:copy(record.base.settings), enabled:!record.base.enabled };
    record.drafts.enabled = payload.enabled;
    record.versions.enabled = (record.versions.enabled ?? 0) + 1;
    return dispatch("update", id, payload, () => update(id, payload), { versions:{ enabled:record.versions.enabled } });
  }
  async function removeInstance(id) {
    const record = data.records.get(id); if (!record || !snapshotRecord(record).canRemove) return false;
    const base = record.base, own = generation;
    if (!await confirmRemove(base.label) || own !== generation || data.records.get(id) !== record ||
      record.base.revision !== base.revision || record.base.plugin !== base.plugin || record.base.label !== base.label ||
      !snapshotRecord(record).canRemove) return false;
    const payload = { revision:base.revision }; return dispatch("remove", id, payload, () => remove(id, payload));
  }
  function secret(id, key, clear = false) {
    const record = data.records.get(id), field = record && snapshotRecord(record).secrets.find(secret => secret.key === key);
    if (!field || !(clear ? field.canClear : field.canSave)) return false;
    const name = inputId(id, key), payload = { revision:record.base.revision, ...(clear ? {} : { value:inputs.get(name) }) };
    return dispatch("key", id, payload, () => clear ? clearKey(id, key, payload) : setKey(id, key, payload),
      clear ? {} : { secret:name, secretVersion:inputVersions.get(name) });
  }
  function syncNow(id) {
    const record = data.records.get(id); if (!record || !snapshotRecord(record).canSync) return false;
    const payload = { revision:record.base.revision }; return dispatch("sync", id, payload, () => sync(id, payload));
  }
  function decision(id, action, paths) {
    const record = data.records.get(id); if (!record || !snapshotRecord(record).canDecide) return false;
    const payload = { instanceRevision:record.base.revision, attentionRevision:record.base.attention.revision, action, ...(paths ? { paths:[...paths] } : {}) };
    return dispatch("decision", id, payload, () => decide(id, payload));
  }
  function startAdd() { if (!state.canAdd) return false; data.adding = true; data.plugin = data.plugins[0].id; data.label = ""; return true; }
  function editAdd(key, value) { if (!["plugin", "label"].includes(key) || data.busy) return; data[key] = value; updateUnload(); }
  function createInstance() {
    if (!state.canCreate) return false;
    const payload = { plugin:data.plugin, label:data.label }; return dispatch("create", null, payload, () => create(payload));
  }
  async function cancelAdd() {
    if (!await settle() || operation.value) return false;
    if (data.label && await confirm({ reason:"cancelling the new sync instance", pages:[{ page:{label:"New sync instance"}, canSave:false }], canSave:false }) !== "discard") return false;
    data.adding = false; data.label = ""; updateUnload(); return true;
  }
  function discard(id) {
    if (data.busy || data.reviewing || data.unknown || data.needsReview) return false;
    if (id) { const record = data.records.get(id); if (record) { record.drafts = {}; record.errors = {}; record.changed = false; record.draftDeclaration = null; } for (const key of inputs.keys()) if (key.startsWith(`${id}:`)) inputs.delete(key); }
    else { for (const key of data.records.keys()) discard(key); inputs.clear(); operation.value = null; data.adding = false; data.label = ""; }
    updateUnload(); return true;
  }
  async function settle() {
    const failures = failureVersion;
    if (wire) { try { await observe(wire.catch(() => null)); } catch { return false; } }
    return !disposed && failures === failureVersion && !data.busy && !data.reviewing && !data.unknown && !data.needsReview;
  }
  const departurePages = () => [{ page:{ label:"Sync" }, canSave:!operation.value && !hasInputs() && !data.adding && [...data.records.values()].every(record => !hasDraft(record) || snapshotRecord(record).canSave) }];
  async function resolveDeparture(reason, choice) {
    if (!await settle()) return false;
    if (!hasWork()) return true;
    const pages = departurePages(), selected = choice ?? await confirm({ reason, pages, canSave:pages[0].canSave });
    if (selected === "discard") return discard();
    if (selected === "save" && pages[0].canSave) {
      for (const [id, record] of data.records) if (hasDraft(record)) {
        if (!await save(id) || !await settle() || !await refreshSnapshot()) return false;
      }
      return !hasWork();
    }
    return false;
  }
  function dispose() {
    disposed = true; active = false; generation++; readTicket++;
    releases.splice(0).forEach(release => release());
    inputs.clear(); inputVersions.clear(); if (operation.value?.kind === "key") operation.value.payload.value = "";
    operation.value = null; data.records.clear(); unload.dispose();
  }
  return { state, activate, refresh, edit, editKey, startAdd, editAdd, createInstance, cancelAdd, save, toggle,
    remove:removeInstance, saveKey:(id, key) => secret(id, key), clearKey:(id, key) => secret(id, key, true),
    syncNow, decision, review, discard, hasWork, settle, departurePages, resolveDeparture, dispose };
}
