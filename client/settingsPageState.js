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
  isGuest = () => getSession() === null, captureSession, canRead = () => true, canWrite = () => true }) {
  const records = reactive(new Map());
  const retained = new Map();
  const lifetime = createSessionContext({ key: getSession });
  let session = getSession(), scope = getRecoveryScope?.(), guest = isGuest();
  function synchronize() {
    if (lifetime.disposed) return;
    const next = getSession(), authorized = getRecoveryScope?.(), nextGuest = isGuest();
    if (next === session && authorized === scope && nextGuest === guest) return;
    if (scope) for (const record of records.values()) {
      // A sent version belongs only to the original wire, not to the new
      // draft. Later typing and work that was never submitted may be kept.
      const entries = Object.entries(record.drafts).filter(([key]) =>
        record.submitted?.versions[key] !== record.versions[key]);
      if (entries.length) retained.set(record.id, { scope, values: Object.fromEntries(entries) });
    }
    for (const record of records.values()) record.retired = true;
    records.clear();
    lifetime.advanceProjection();
    session = next;
    scope = authorized;
    guest = nextGuest;
    if (!guest) for (const [id, draft] of retained) {
      if (!scope || draft.scope !== scope) retained.delete(id);
    }
  }
  const stopSession = watch(() => [getSession(), getRecoveryScope?.(), isGuest()], synchronize, { flush: "sync" });
  const recordKey = id => { synchronize(); return JSON.stringify([lifetime.generation, id]); };
  const currentRecords = () => { synchronize(); return [...records.values()]; };
  const requests = new Map();
  const wires = reactive(new Map());
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
      record = reactive({ id, key, page, session: getSession(), available: page.available !== false, values: {}, revision: 0, sourceKey: undefined, fields: {}, drafts: {}, versions: {}, errors: {}, status: "unloaded", loaded: false, generation: 0, message: "", uncertain: null, changedDescriptor: null });
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
    const fieldViews = Object.fromEntries((record.page.descriptor?.fields ?? []).map(field => [field.key, {
      value:Object.hasOwn(record.drafts, field.key) ? record.drafts[field.key] : values[field.key],
      recovered: record.recovered && Object.hasOwn(record.drafts, field.key),
      currentValue: record.values[field.key],
      readonly:!writable || record.session !== getSession() || !record.available || !record.loaded || !!record.fields[field.key]?.readonly,
      error:record.errors[field.key] ?? '', pin:pinExplanation(record.fields[field.key]),
    }]));
    return { ...record, recoverySave: record.recovered && dirty(record), fieldViews, fieldGroups:settingsFieldGroups(record.page.descriptor ?? {}, values), retainedText:JSON.stringify(record.drafts, null, 2),
      blockingText:blocking?.actions?.length ? `${blocking.active===false ? 'Can block when on' : 'Can block'}: ${blocking.actions.join(', ')}. Errors or timeouts also cancel the action.` : '',
      recovery:{visible:record.status==='conflict'||record.status==='error'||!record.available||!!record.changedDescriptor,label:record.uncertain?'Check current status':'Retry'},
      canRetry:writable && retryAdmissible(record),
      values, committed: record.values, dirty: dirty(record), pending: requests.has(record.key) || wires.has(record.key) || loads.has(record.key) || reviews.has(record.key), canSave: record.available && record.loaded && !blockingLoad(record) && !reviews.has(record.key) && !record.changedDescriptor && !Object.keys(record.errors).length };
  }
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
          const recovery = retained.get(id);
          if (scope && recovery?.scope === scope) {
            retained.delete(id);
            record.recovered = true;
            for (const [field, value] of Object.entries(recovery.values)) {
              if (page.descriptor?.fields?.some(entry => entry.key === field) && !Object.hasOwn(record.drafts, field)) edit(id, field, value);
            }
          }
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
    record.values = copy(result.values);
    record.revision = result.revision;
    record.sourceKey = result.sourceKey;
    record.fields = copy(result.fields ?? {});
    for (const [key, version] of Object.entries(submitted.versions)) {
      if (record.versions[key] === version) {
        delete record.drafts[key];
        delete record.errors[key];
      }
    }
    record.status = "idle";
    record.message = "";
    record.uncertain = null;
    if (!dirty(record)) record.recovered = false;
  }
  async function commit(id, key) {
    if (lifetime.disposed) return false;
    const record = ensure(id);
    const scope = record.key;
    if (!canRead(record.page) || !canWrite() || key !== undefined && record.recovered) return false;
    if (requests.has(scope)) {
      const current = captureRecord(record);
      const result = await requests.get(scope);
      if (!result || !current()) return false;
      return commit(id, key); // serial admission; an acknowledged edit is deduplicated below
    }
    if (wires.has(scope) || blockingLoad(record) || reviews.has(scope)) return false;
    if (!dirty(record)) return true;
    if (!record.loaded || !record.available || record.changedDescriptor || record.uncertain || record.status === "conflict") return false;
    if (key ? record.errors[key] : Object.keys(record.errors).length) return false;
    const versions = Object.fromEntries(Object.keys(record.drafts).filter(key => !record.errors[key]).map(key => [key, record.versions[key]]));
    if (!Object.keys(versions).length) return false;
    const submitted = { page: record.page, session: record.session, key: record.key, values: copy(envelope(record)), revision: record.revision, sourceKey: record.sourceKey, versions };
    record.submitted = submitted;
    ++record.generation; // late GETs cannot overwrite an admitted edit/PUT
    const current = captureRecord(record).bind(canWrite);
    record.status = "saving";
    let observed = false;
    const original = wire({ ...submitted, kind: "write", current });
    wires.set(scope, original);
    original.then(result => {
      if (!observed && current() && record.uncertain && wires.get(scope) === original) acknowledge(record, submitted, result);
    }, () => { /* Unknown decisions remain retained for explicit read-back. */ })
      .finally(() => { if (wires.get(scope) === original) wires.delete(scope); adoptDescriptor(record); })
      .catch(() => { /* Malformed late data is not an acknowledgement. */ });
    const request = (async () => {
      try {
        const result = await bounded(() => original);
        observed = true;
        if (current()) acknowledge(record, submitted, result);
        return true;
      } catch (error) {
        if (current()) {
          record.status = error.response?.status === 409 ? "conflict" : "error";
          record.message = error.response?.data?.detail ?? error.message;
          if (!error.clientScopeRetired && (!error.response || error.response.data?.code === "plugin_settings_source_commit_failed")) record.uncertain = submitted;
        }
        return false;
      } finally { requests.delete(scope); adoptDescriptor(record); }
    })();
    requests.set(scope, request);
    return request;
  }
  function retryAdmissible(record) {
    const { key } = record;
    return !lifetime.disposed && !record.retired && canRead(record.page) && canWrite() && !wires.has(key) && !requests.has(key) && !blockingLoad(record) && !reviews.has(key) &&
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
        try { await bounded(() => wires.get(key).catch(() => null)); } catch { /* Observation is not cancellation. */ }
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
      if (!record.uncertain) record.status = "unloaded";
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
  }
  async function settle() {
    const selected = currentRecords();
    await Promise.all(selected.map(({ key }) => requests.get(key)));
    for (const { key } of selected) {
      const wire = wires.get(key);
      if (wire) try { await bounded(() => wire.catch(() => null)); } catch {}
    }
    return selected.every(record => !wires.has(record.key) && !record.uncertain);
  }
  return { snapshot, edit, commit, load, retry, resolveDeparture, reconcile,
    settle,
    pageIds: () => currentRecords().map(record => record.id),
    hasWork: () => currentRecords().some(record => dirty(record) || record.status === "saving" || wires.has(record.key) || record.uncertain),
    recoveryPages: () => currentRecords().filter(record => !record.available && dirty(record)).map(record => record.page),
    dispose() { lifetime.dispose(); stopSession(); retained.clear(); records.clear(); return operations.dispose(); },
  };
}
