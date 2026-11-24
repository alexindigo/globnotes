// SPDX-License-Identifier: LGPL-3.0-only
import { reactive, watch } from "vue";
import { settingsFieldGroups } from "./declarativeSettings.js";
import { pinExplanation } from "./configurationProvenance.js";
import { createOperationOwner } from "./operationOwner.js";
import { bindContext, createSessionContext, retiredContext } from "./sessionContext.js";

const copy = value => JSON.parse(JSON.stringify(value));
export function validateSettingsInput(field, raw) {
  let value = raw;
  if (field.type === "number" || field.type === "slider") {
    if (typeof raw === "string" && !raw.trim()) return { error: "Enter a number." };
    value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) return { error: "Enter a finite number." };
    if (field.min !== undefined && value < field.min) return { error: `Minimum: ${field.min}` };
    if (field.max !== undefined && value > field.max) return { error: `Maximum: ${field.max}` };
    if (field.step !== undefined) {
      const ratio = (value - (field.min ?? 0)) / field.step;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-8) return { error: `Use steps of ${field.step}.` };
    }
  } else if (field.type === "toggle") {
    if (typeof value !== "boolean") return { error: "Choose on or off." };
  } else if (field.type === "select") {
    if (!field.options?.some(option => option.value === value)) return { error: "Choose a declared option." };
  } else {
    if (typeof value !== "string") return { error: "Enter text." };
    if (field.minLength !== undefined && value.length < field.minLength) return { error: `Minimum length: ${field.minLength}` };
    if (field.maxLength !== undefined && value.length > field.maxLength) return { error: `Maximum length: ${field.maxLength}` };
    if (field.type === "color" && !/^#[a-fA-F0-9]{6}$/.test(value)) return { error: "Use a six-digit color." };
  }
  return { value };
}

async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Settings request outcome is unknown; read back before retrying.")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Records outlive rendered pages. Registry adapters own effects; this
 * controller owns drafts, request admission, revisions and decisions. */
export function createSettingsPageState({ registry, confirm, getSession = () => null, getRecoveryScope,
  isGuest = () => getSession() === null, captureSession, captureCredential,
  canRead = () => true, canWrite = () => true }) {
  const records = reactive(new Map());
  const retained = new Map();
  const requests = new Map();
  const wires = reactive(new Map());
  const reopen = new Set();
  const lifetime = createSessionContext({ key: getSession });
  let session = getSession(), scope = getRecoveryScope?.(), guest = isGuest();
  function synchronize() {
    if (lifetime.disposed) return;
    const next = getSession(), authorized = getRecoveryScope?.(), nextGuest = isGuest();
    if (next === session && authorized === scope && nextGuest === guest) return;
    if (scope) for (const record of records.values()) {
      // A sent version belongs only to the original wire, not to the new
      // draft. Later typing and work that was never submitted may be kept.
      if (wires.has(record.key)) {
        const entries = Object.entries(record.drafts).filter(([key]) => record.submitted?.versions[key] !== record.versions[key]);
        if (entries.length) preserve(record, Object.fromEntries(entries));
      } else if (dirty(record) || record.uncertain) preserve(record, record.drafts, writeFailure(record));
      if (next === null || authorized === scope) reopen.add(record.id);
    }
    for (const record of records.values()) record.retired = true;
    records.clear();
    lifetime.advanceProjection();
    session = next;
    scope = authorized;
    guest = nextGuest;
    if (guest && next !== null) for (const draft of retained.values()) draft.fellBack = true;
    if (!guest) for (const [id, draft] of retained) {
      if (!scope || draft.scope !== scope) retained.delete(id);
    }
  }
  const stopSession = watch(() => [getSession(), getRecoveryScope?.(), isGuest()], synchronize, { flush: "sync" });
  const recordKey = id => { synchronize(); return JSON.stringify([lifetime.generation, id]); };
  const currentRecords = () => { synchronize(); return [...records.values()]; };
  const loads = reactive(new Map());
  const reviews = reactive(new Map());
  const capture = () => {
    synchronize();
    const local = lifetime.capture(), application = captureSession?.();
    return bindContext(() => { synchronize(); return local() && (application?.() ?? true); });
  };
  const captureRecord = (record, page = record.page) => capture().bind(() => record.generation, () => canRead(page));
  const operations = createOperationOwner({ owner: Object.freeze({}),
    prepare(intent) {
      const value = { ...intent, values: intent.values && copy(intent.values) };
      return { value };
    },
    dispatch: intent => intent.kind === "read" ? registry.read(intent.page) : intent.sourceKey === undefined
      ? registry.commit(intent.page, intent.values, intent.revision)
      : registry.commit(intent.page, intent.values, intent.revision, intent.sourceKey),
    completion: {
      prepare(value) {
        const result = copy(value.result);
        return { value: { result, receipt: value.receipt } };
      },
      deliver: value => { value.receipt.value = value.result; },
    },
  });
  async function wire(intent) {
    const operation = operations.operation(intent.kind === "read" ? "live" : "outcome", intent.current), receipt = {};
    try {
      const result = (await operations.dispatch(operation, intent)).value;
      if (!operations.complete(operation, { result, receipt })) throw retiredContext();
      return receipt.value;
    } finally { await operations.release(operation); }
  }
  const dirty = record => Object.keys(record.drafts).length > 0;
  // A new-schema/initial load has no authoritative base yet. A refresh of an
  // already-loaded definition keeps its known CAS and explicit Save admission;
  // that admitted commit advances generation and fences the older GET.
  const blockingLoad = record => loads.has(record.key) && !record.loaded;
  function ensure(id) {
    const key = recordKey(id);
    let record = records.get(key);
    if (!record) {
      const page = registry.find(id);
      if (!page) throw new Error(`Unavailable settings page: ${id}`);
      record = reactive({ id, key, page, session: getSession(), recoveryScope: scope, credentialCurrent: captureCredential?.(), available: page.available !== false, values: {}, revision: 0, sourceKey: undefined, fields: {}, drafts: {}, versions: {}, errors: {}, status: "unloaded", loaded: false, generation: 0, message: "", uncertain: null, writeFailed: false, changedDescriptor: null });
      records.set(key, record);
    }
    return record;
  }
  function envelope(record) {
    const values = { ...record.values };
    for (const field of record.page.descriptor?.fields ?? []) {
      if (!Object.hasOwn(values, field.key)) values[field.key] = field.default;
      if (Object.hasOwn(record.drafts, field.key)) {
        const result = validateSettingsInput(field, record.drafts[field.key]);
        if (!result.error) values[field.key] = result.value;
      }
    }
    return values;
  }
  function snapshot(id, writable = true) {
    const record = lifetime.disposed ? null : records.get(recordKey(id)) ?? (registry.find(id) ? ensure(id) : null);
    if (!record || !canRead(record.page)) return { page: null, recovery: { visible: false }, values: {}, committed: {}, drafts: {}, fields: {}, fieldViews: {}, fieldGroups: [], retainedText: "", available: false, loaded: false, dirty: false, pending: false, canSave: false, canRetry: false };
    const values = envelope(record);
    const current=registry.find(id);
    // Draft schemas are retained; current runtime status is not schema state.
    const blocking=current ? current.blocking : record.page.blocking && {...record.page.blocking,active:false};
    const recovery = !record.loaded && record.available && !guest && scope ? retained.get(id) : null;
    const revalidating = recovery && recovery.scope === scope && !recovery.fellBack && recovery.credentialCurrent?.() &&
      current && current.available !== false && JSON.stringify(current.descriptor) === JSON.stringify(recovery.page.descriptor)
      ? recovery.values : {};
    const fieldViews = Object.fromEntries((record.page.descriptor?.fields ?? []).map(field => {
      const retainControl = Object.hasOwn(revalidating, field.key);
      const raw = revalidating[field.key];
      return [field.key, {
        value: retainControl ? raw : Object.hasOwn(record.drafts, field.key) ? record.drafts[field.key] : values[field.key],
        recovered: record.recovered && Object.hasOwn(record.drafts, field.key),
        currentValue: record.values[field.key],
        readonly: !writable || !record.available || !record.loaded || !!record.fields[field.key]?.readonly,
        retainControl,
        error: (retainControl ? validateSettingsInput(field, raw).error : record.errors[field.key]) ?? '', pin:pinExplanation(record.fields[field.key]),
      }];
    }));
    return { ...record, recoverySave: record.recovered && dirty(record), fieldViews, fieldGroups:settingsFieldGroups(record.page.descriptor ?? {}, values), retainedText:JSON.stringify(record.drafts, null, 2),
      blockingText:blocking?.actions?.length ? `${blocking.active===false ? 'Can block when on' : 'Can block'}: ${blocking.actions.join(', ')}. Errors or timeouts also cancel the action.` : '',
      recovery:{visible:record.status==='conflict'||record.status==='error'||!record.available||!!record.changedDescriptor,label:record.uncertain?'Check current status':'Retry'},
      canRetry:writable && retryAdmissible(record),
      values, committed: record.values, dirty: dirty(record), pending: requests.has(record.key) || pendingWrite(record) || loads.has(record.key) || reviews.has(record.key), canSave: writable && record.available && record.loaded && !blockingLoad(record) && !reviews.has(record.key) && !record.changedDescriptor && record.status !== "conflict" && !Object.keys(record.errors).length && !hasPinnedDraft(record) };
  }
  const hasPinnedDraft = record => Object.keys(record.drafts).some(key => record.fields[key]?.readonly);
  // Re-read the registry at settlement: a retained D2 is not necessarily the
  // current definition. Never project old acknowledgement values as new-schema
  // data, or adopt while any original owner still has unresolved work.
  function adoptDescriptor(record) {
    if (lifetime.disposed || record.retired || record.key !== recordKey(record.id)) return false;
    const page = registry.find(record.id);
    record.available = !!page && page.available !== false;
    if (!record.available || dirty(record) || Object.keys(record.errors).length || requests.has(record.key) || wires.has(record.key) || loads.has(record.key) || reviews.has(record.key) || record.uncertain) return false;
    if (JSON.stringify(page.descriptor) === JSON.stringify(record.page.descriptor)) {
      record.changedDescriptor = null;
      return false;
    }
    ++record.generation;
    record.page = page;
    record.changedDescriptor = null;
    record.values = {};
    record.revision = 0;
    record.sourceKey = undefined;
    record.fields = {};
    record.loaded = false;
    record.status = "unloaded";
    record.message = "";
    void load(record.id);
    return true;
  }
  function edit(id, key, raw) {
    if (lifetime.disposed) return snapshot(id);
    const record = ensure(id);
    const field = record.page.descriptor?.fields?.find(field => field.key === key);
    if (!field) throw new Error(`Unknown setting: ${key}`);
    if (!canRead(record.page) || record.fields[key]?.readonly) return snapshot(id);
    record.drafts[key] = raw;
    record.versions[key] = (record.versions[key] ?? 0) + 1;
    const result = validateSettingsInput(field, raw);
    if (result.error) record.errors[key] = result.error;
    else delete record.errors[key];
    return snapshot(id);
  }
  function preserve(record, values, failure, older = false) {
    const previous = retained.get(record.id);
    const existing = previous?.scope === record.recoveryScope ? previous : null;
    retained.set(record.id, { scope: record.recoveryScope, page: record.page, credentialCurrent: record.credentialCurrent, session: record.session,
      fellBack: existing?.fellBack, baseline: older && existing?.baseline ? existing.baseline : {
        revision: record.revision, sourceKey: record.sourceKey, values: copy(record.values), conflict: record.status === "conflict",
      },
      values: older ? { ...values, ...existing?.values } : { ...existing?.values, ...values }, failure: failure ?? existing?.failure });
  }
  function restore(record) {
    const recovery = retained.get(record.id);
    if (!scope || recovery?.scope !== scope || !record.loaded || !canRead(record.page)) return;
    retained.delete(record.id);
    const { baseline } = recovery;
    const sameCredential = !recovery.fellBack && (recovery.credentialCurrent?.() ?? record.session === recovery.session);
    const changed = baseline.conflict || baseline.revision !== record.revision ||
      baseline.sourceKey !== undefined && baseline.sourceKey !== record.sourceKey ||
      Object.entries(baseline.values).some(([key, value]) => value !== record.values[key]);
    record.recovered = !sameCredential;
    for (const field of record.page.descriptor?.fields ?? []) {
      const key = field.key;
      if (!Object.hasOwn(recovery.values, key) || Object.hasOwn(record.drafts, key)) continue;
      record.drafts[key] = recovery.values[key];
      record.versions[key] = 1;
      const { error } = validateSettingsInput(field, recovery.values[key]);
      if (error) record.errors[key] = error;
    }
    const failure = recovery.failure;
    if (!failure) {
      if (sameCredential && changed) { record.status = "conflict"; record.message = "Settings changed elsewhere. Your draft is retained."; }
      return;
    }
    record.writeFailed = true;
    record.status = failure.status;
    record.message = failure.message;
    const submitted = failure.uncertain;
    if (submitted) {
      // Read-back of the original write may clear only matching recovered
      // values, never newer typing that was not part of that wire.
      const versions = Object.fromEntries(Object.keys(submitted.versions).filter(key =>
        Object.hasOwn(record.drafts, key) && record.drafts[key] === submitted.raw[key]).map(key => [key, record.versions[key]]));
      record.uncertain = { ...submitted, versions };
    }
  }
  async function load(id) {
    if (lifetime.disposed) return snapshot(id);
    if (!registry.find(id) && !records.has(recordKey(id))) return snapshot(id);
    const record = ensure(id);
    const { key } = record;
    if (loads.has(key)) { await loads.get(key); return snapshot(id); }
    if (dirty(record) || requests.has(key) || wires.has(key) || reviews.has(key) || record.uncertain || !record.available || !canRead(record.page)) return snapshot(id);
    ++record.generation;
    const page = record.page;
    const current = captureRecord(record, page);
    record.status = "loading";
    const loading = (async () => {
      try {
        const result = await bounded(() => wire({ kind: "read", page, current }));
        if (current() && (!dirty(record) || !record.loaded)) {
          record.values = copy(result.values);
          record.revision = result.revision;
          record.sourceKey = result.sourceKey;
          record.fields = copy(result.fields ?? {});
          record.status = "idle";
          record.loaded = true;
          record.message = "";
          record.writeFailed = false;
          restore(record);
        }
      } catch (error) {
        if (current()) {
          record.status = "error";
          record.message = error.response?.data?.detail ?? error.message;
        }
      }
    })();
    loads.set(key, loading);
    try { await loading; }
    finally { if (loads.get(key) === loading) loads.delete(key); adoptDescriptor(record); }
    return snapshot(id);
  }
  function acknowledge(record, submitted, result) {
    const projection = result.committed !== true;
    record.values = projection ? copy(result.values) : {};
    record.loaded = projection;
    record.revision = result.revision;
    record.sourceKey = result.sourceKey;
    record.fields = copy(result.fields ?? {});
    for (const [key, version] of Object.entries(submitted.versions)) {
      if (record.versions[key] === version) {
        delete record.drafts[key];
        delete record.errors[key];
      }
    }
    record.status = projection ? "idle" : "unloaded";
    record.message = "";
    record.uncertain = null;
    record.writeFailed = false;
    if (!dirty(record)) record.recovered = false;
  }
  function rejectWrite(record, submitted, error) {
    record.writeFailed = true;
    record.status = error.response?.status === 409 ? "conflict" : "error";
    record.message = error.response?.data?.detail ?? error.message;
    record.uncertain = !error.clientScopeRetired && (!error.response || error.response.data?.code === "plugin_settings_source_commit_failed") ? submitted : null;
  }
  function writeFailure(record) {
    // A recovered outcome belongs to the record even when this generation
    // has never submitted a wire of its own.
    return record.writeFailed && ["conflict", "error"].includes(record.status)
      ? { status: record.status, message: record.message, uncertain: record.uncertain } : undefined;
  }
  function pendingWrite(record) {
    return wires.has(record.key) || !!record.recoveryScope && [...wires.values()].some(entry =>
      entry.record.id === record.id && entry.record.recoveryScope === record.recoveryScope);
  }
  async function commit(id, key) {
    if (lifetime.disposed) return false;
    if (!registry.find(id) && !records.has(recordKey(id))) return false;
    const record = ensure(id);
    const keyForWrite = record.key;
    if (!canRead(record.page) || !canWrite() || key !== undefined && record.recovered) return false;
    if (requests.has(keyForWrite)) {
      const current = captureRecord(record);
      const result = await requests.get(keyForWrite);
      if (!result || !current()) return false;
      return commit(id, key); // serial admission; an acknowledged edit is deduplicated below
    }
    if (pendingWrite(record) || blockingLoad(record) || reviews.has(scope)) return false;
    if (!dirty(record)) return true;
    if (!record.loaded || !record.available || record.changedDescriptor || record.uncertain || record.status === "conflict") return false;
    if (key ? record.errors[key] || record.fields[key]?.readonly : Object.keys(record.errors).length || hasPinnedDraft(record)) return false;
    const versions = Object.fromEntries(Object.keys(record.drafts).filter(key => !record.errors[key] && !record.fields[key]?.readonly).map(key => [key, record.versions[key]]));
    if (!Object.keys(versions).length) return false;
    const submitted = { page: record.page, session: record.session, key: record.key, values: copy(envelope(record)), revision: record.revision, sourceKey: record.sourceKey, versions,
      raw: Object.fromEntries(Object.keys(versions).map(key => [key, record.drafts[key]])) };
    record.submitted = submitted;
    ++record.generation; // late GETs cannot overwrite an admitted edit/PUT
    const current = captureRecord(record).bind(canWrite);
    record.status = "saving";
    let observed = false, finished = false;
    const original = wire({ ...submitted, kind: "write", current });
    const entry = { record, original };
    wires.set(keyForWrite, entry);
    const mayRecordOutcome = () => !lifetime.disposed && (current() || record.retired);
    function finish() {
      if (!finished || requests.has(keyForWrite) || !wires.has(keyForWrite)) return;
      wires.delete(keyForWrite);
      const failure = writeFailure(record);
      // An outcome belongs to its original record even after the projection
      // retires. Only failure recovery, never the ACK, may be re-projected.
      if (!lifetime.disposed && record.retired && failure && record.recoveryScope && (guest || scope === record.recoveryScope)) {
        preserve(record, record.drafts, failure, true);
        const replacement = records.get(recordKey(id));
        if (replacement) restore(replacement);
      }
      adoptDescriptor(record);
      if (!record.loaded && !record.retired && !record.writeFailed && current()) void load(id);
    }
    original.then(result => {
      if (!observed && mayRecordOutcome() && record.uncertain) acknowledge(record, submitted, result);
    }, error => { if (!observed && mayRecordOutcome() && record.uncertain) rejectWrite(record, submitted, error); })
      .finally(() => { finished = true; finish(); })
      .catch(() => { /* Malformed late data is not an acknowledgement. */ });
    const request = (async () => {
      try {
        const result = await bounded(() => original);
        observed = true;
        if (mayRecordOutcome()) acknowledge(record, submitted, result);
        return true;
      } catch (error) {
        if (mayRecordOutcome()) rejectWrite(record, submitted, error);
        return false;
      } finally { requests.delete(keyForWrite); finish(); }
    })();
    requests.set(keyForWrite, request);
    return request;
  }
  function retryAdmissible(record) {
    const { key } = record;
    return !lifetime.disposed && !record.retired && canRead(record.page) && canWrite() && !pendingWrite(record) && !requests.has(key) && !blockingLoad(record) && !reviews.has(key) &&
      !(loads.has(key) && record.uncertain) && record.available &&
      !!(record.uncertain || (!record.changedDescriptor && record.status !== "conflict"));
  }
  async function retry(id) {
    if (lifetime.disposed) return false;
    const record = ensure(id);
    const { key } = record;
    if (!retryAdmissible(record)) return false;
    if (record.uncertain) {
      const submitted = record.uncertain, current = captureRecord(record).bind(() => record.uncertain);
      reviews.set(key, submitted);
      try {
        const result = await bounded(() => wire({ kind: "read", page: record.page, current }));
        if (!current()) return false;
        if (result.revision === submitted.revision && submitted.sourceKey !== undefined && result.sourceKey !== submitted.sourceKey) {
          record.uncertain = null;
          record.retiredSubmission = submitted;
          record.status = "conflict";
          record.message = "The settings source changed. Your original draft is retained; no write was retried.";
          return false;
        }
        if (result.revision > submitted.revision && Object.keys(result.values).length === Object.keys(submitted.values).length && Object.entries(submitted.values).every(([key, value]) => result.values[key] === value)) {
          acknowledge(record, submitted, result);
        } else if (result.revision !== submitted.revision) {
          // The accepted current revision retires the original CAS. This is
          // current-state review, not proof of whose request committed.
          record.uncertain = null;
          record.status = "conflict";
          record.message = "Settings changed elsewhere. Your draft is retained.";
          return false;
        } else if (record.changedDescriptor) {
          record.message = "The page definition changed while the original outcome remains uncertain. Your original draft is retained; no write was retried.";
          return false;
        } else {
          record.values = copy(result.values);
          record.revision = result.revision;
          record.sourceKey = result.sourceKey;
          record.fields = copy(result.fields ?? {});
          record.uncertain = null;
          record.writeFailed = false;
          record.status = "idle";
          record.message = "";
        }
      } catch (error) { if (current()) record.message = error.message; return false; }
      finally { if (reviews.get(key) === submitted) reviews.delete(key); adoptDescriptor(record); }
    }
    if (!dirty(record) && !record.uncertain) return true;
    return commit(id);
  }
  async function resolveDeparture(ids, reason, confirmedDecision) {
    const current = capture(), selected = ids.map(id => records.get(recordKey(id))).filter(Boolean);
    for (const { key } of selected) if (requests.has(key)) await requests.get(key);
    for (const { key } of selected) {
      if (wires.has(key)) {
        try { await bounded(() => wires.get(key).original.catch(() => null)); } catch { /* Observation is not cancellation. */ }
        if (wires.has(key)) return false;
      }
    }
    if (!current() || selected.some(record => record.uncertain)) return false;
    const changed = selected.filter(dirty);
    if (!changed.length) return true;
    // A session participant may supply the decision already collected by
    // its own confirmation. This is explicit permission, never force-discard.
    const decision = confirmedDecision ?? await confirm({ reason, pages: changed.map(({ id }) => snapshot(id)), canSave: changed.every(({ id }) => snapshot(id).canSave) });
    if (!current()) return false;
    if (decision === "save" || decision === "retry") {
      for (const { id } of changed) if (!current() || !await retry(id)) return false;
      return current() && changed.every(record => !dirty(record));
    }
    if (decision !== "discard") return false;
    for (const record of changed) {
      record.drafts = {};
      record.errors = {};
      record.recovered = false;
      record.message = "";
      // Explicit discard approves only these records. A future retry still
      // needs read-back if an already-admitted write had an unknown outcome.
      if (!record.uncertain) { record.status = "unloaded"; record.writeFailed = false; }
      adoptDescriptor(record);
    }
    return true;
  }
  function reconcile() {
    for (const record of currentRecords()) {
      const page = registry.find(record.id);
      record.available = !!page && page.available !== false;
      if (!page) continue;
      if (JSON.stringify(page.descriptor) !== JSON.stringify(record.page.descriptor)) {
        record.changedDescriptor = page;
      }
      if (!adoptDescriptor(record) && !dirty(record) && !requests.has(record.key) && !wires.has(record.key) && !loads.has(record.key) && !reviews.has(record.key) && !record.uncertain) load(record.id);
    }
    if (getSession() != null) for (const id of reopen) {
      if (registry.find(id) && canRead(registry.find(id))) { reopen.delete(id); void load(id); }
    }
  }
  async function settle() {
    const selected = currentRecords(), originals = [...wires.values()];
    await Promise.all(requests.values());
    await Promise.all(originals.map(async ({ original }) => {
      try { await bounded(() => original.catch(() => null)); } catch { /* Observation is not cancellation. */ }
    }));
    return !wires.size && [...selected, ...originals.map(({ record }) => record), ...currentRecords()].every(record => !record.uncertain);
  }
  return { snapshot, edit, commit, load, retry, resolveDeparture, reconcile,
    settle,
    pageIds: () => currentRecords().map(record => record.id),
    hasWork: () => wires.size > 0 || currentRecords().some(record => dirty(record) || record.status === "saving" || record.uncertain),
    recoveryPages: () => currentRecords().filter(record => !record.available && dirty(record)).map(record => record.page),
    dispose() { lifetime.dispose(); stopSession(); retained.clear(); records.clear(); return operations.dispose(); },
  };
}
