// SPDX-License-Identifier: LGPL-3.0-only
import { reactive } from "vue";

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
export function createSettingsPageState({ registry, confirm }) {
  const records = reactive(new Map());
  const requests = new Map();
  const wires = reactive(new Map());
  const loads = reactive(new Map());
  const reviews = reactive(new Map());
  let disposed = false;
  const dirty = record => Object.keys(record.drafts).length > 0;
  // A new-schema/initial load has no authoritative base yet. A refresh of an
  // already-loaded definition keeps its known CAS and explicit Save admission;
  // that admitted commit advances generation and fences the older GET.
  const blockingLoad = record => loads.has(record.id) && !record.loaded;
  function ensure(id) {
    let record = records.get(id);
    if (!record) {
      const page = registry.find(id);
      if (!page) throw new Error(`Unavailable settings page: ${id}`);
      record = reactive({ id, page, available: page.available !== false, values: {}, revision: 0, drafts: {}, versions: {}, errors: {}, status: "unloaded", loaded: false, generation: 0, message: "", uncertain: null, changedDescriptor: null });
      records.set(id, record);
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
  function snapshot(id) {
    const record = ensure(id);
    return { ...record, values: envelope(record), committed: record.values, dirty: dirty(record), pending: requests.has(id) || wires.has(id) || loads.has(id) || reviews.has(id), canSave: record.available && record.loaded && !blockingLoad(record) && !reviews.has(id) && !record.changedDescriptor && !Object.keys(record.errors).length };
  }
  // Re-read the registry at settlement: a retained D2 is not necessarily the
  // current definition. Never project old acknowledgement values as new-schema
  // data, or adopt while any original owner still has unresolved work.
  function adoptDescriptor(record) {
    if (disposed) return false;
    const page = registry.find(record.id);
    record.available = !!page && page.available !== false;
    if (!record.available || dirty(record) || Object.keys(record.errors).length || requests.has(record.id) || wires.has(record.id) || loads.has(record.id) || reviews.has(record.id) || record.uncertain) return false;
    if (JSON.stringify(page.descriptor) === JSON.stringify(record.page.descriptor)) {
      record.changedDescriptor = null;
      return false;
    }
    ++record.generation;
    record.page = page;
    record.changedDescriptor = null;
    record.values = {};
    record.revision = 0;
    record.loaded = false;
    record.status = "unloaded";
    record.message = "";
    void load(record.id);
    return true;
  }
  function edit(id, key, raw) {
    const record = ensure(id);
    const field = record.page.descriptor?.fields?.find(field => field.key === key);
    if (!field) throw new Error(`Unknown setting: ${key}`);
    record.drafts[key] = raw;
    record.versions[key] = (record.versions[key] ?? 0) + 1;
    const result = validateSettingsInput(field, raw);
    if (result.error) record.errors[key] = result.error;
    else delete record.errors[key];
    return snapshot(id);
  }
  async function load(id) {
    const record = ensure(id);
    if (loads.has(id)) { await loads.get(id); return snapshot(id); }
    if (dirty(record) || requests.has(id) || wires.has(id) || reviews.has(id) || record.uncertain || !record.available) return snapshot(id);
    const generation = ++record.generation;
    const page = record.page;
    record.status = "loading";
    const loading = (async () => {
      try {
        const result = await bounded(() => registry.read(page));
        if (!disposed && generation === record.generation && (!dirty(record) || !record.loaded)) {
          record.values = copy(result.values);
          record.revision = result.revision;
          record.status = "idle";
          record.loaded = true;
          record.message = "";
        }
      } catch (error) {
        if (!disposed && generation === record.generation) {
          record.status = "error";
          record.message = error.response?.data?.detail ?? error.message;
        }
      }
    })();
    loads.set(id, loading);
    try { await loading; }
    finally { if (loads.get(id) === loading) loads.delete(id); adoptDescriptor(record); }
    return snapshot(id);
  }
  function acknowledge(record, submitted, result) {
    record.values = copy(result.values);
    record.revision = result.revision;
    for (const [key, version] of Object.entries(submitted.versions)) {
      if (record.versions[key] === version) {
        delete record.drafts[key];
        delete record.errors[key];
      }
    }
    record.status = "idle";
    record.message = "";
    record.uncertain = null;
  }
  async function commit(id, key) {
    if (disposed) return false;
    const record = ensure(id);
    if (requests.has(id)) {
      const result = await requests.get(id);
      if (!result) return false;
      return commit(id, key); // serial admission; an acknowledged edit is deduplicated below
    }
    if (wires.has(id) || blockingLoad(record) || reviews.has(id)) return false;
    if (!dirty(record)) return true;
    if (!record.loaded || !record.available || record.changedDescriptor || record.uncertain || record.status === "conflict") return false;
    if (key ? record.errors[key] : Object.keys(record.errors).length) return false;
    const versions = Object.fromEntries(Object.keys(record.drafts).filter(key => !record.errors[key]).map(key => [key, record.versions[key]]));
    if (!Object.keys(versions).length) return false;
    const submitted = { page: record.page, values: copy(envelope(record)), revision: record.revision, versions };
    ++record.generation; // late GETs cannot overwrite an admitted edit/PUT
    record.status = "saving";
    let observed = false;
    const wire = Promise.resolve().then(() => registry.commit(submitted.page, submitted.values, submitted.revision));
    wires.set(id, wire);
    wire.then(result => {
      if (!observed && !disposed && record.uncertain && wires.get(id) === wire) acknowledge(record, submitted, result);
    }, () => { /* Unknown decisions remain retained for explicit read-back. */ })
      .finally(() => { if (wires.get(id) === wire) wires.delete(id); adoptDescriptor(record); })
      .catch(() => { /* Malformed late data is not an acknowledgement. */ });
    const request = (async () => {
      try {
        const result = await bounded(() => wire);
        observed = true;
        if (!disposed) acknowledge(record, submitted, result);
        return true;
      } catch (error) {
        if (!disposed) {
          record.status = error.response?.status === 409 ? "conflict" : "error";
          record.message = error.response?.data?.detail ?? error.message;
          if (!error.response || error.response.data?.code === "plugin_settings_source_commit_failed") record.uncertain = submitted;
        }
        return false;
      } finally { requests.delete(id); adoptDescriptor(record); }
    })();
    requests.set(id, request);
    return request;
  }
  async function retry(id) {
    if (disposed) return false;
    const record = ensure(id);
    if (wires.has(id) || requests.has(id) || blockingLoad(record) || reviews.has(id) || (loads.has(id) && record.uncertain)) return false;
    if (!record.available || (!record.uncertain && (record.changedDescriptor || record.status === "conflict"))) return false;
    if (record.uncertain) {
      const submitted = record.uncertain, generation = record.generation;
      reviews.set(id, submitted);
      try {
        const result = await bounded(() => registry.read(record.page));
        if (disposed || generation !== record.generation || record.uncertain !== submitted) return false;
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
          record.uncertain = null;
        }
      } catch (error) { record.message = error.message; return false; }
      finally { if (reviews.get(id) === submitted) reviews.delete(id); adoptDescriptor(record); }
    }
    if (!dirty(record) && !record.uncertain) return true;
    return commit(id);
  }
  async function resolveDeparture(ids, reason, confirmedDecision) {
    for (const id of ids) if (requests.has(id)) await requests.get(id);
    for (const id of ids) {
      if (wires.has(id)) {
        try { await bounded(() => wires.get(id).catch(() => null)); } catch { /* Observation is not cancellation. */ }
        if (wires.has(id)) return false;
      }
    }
    if (ids.some(id => ensure(id).uncertain)) return false;
    const changed = ids.filter(id => dirty(ensure(id)));
    if (!changed.length) return true;
    // A session participant may supply the decision already collected by
    // its own confirmation. This is explicit permission, never force-discard.
    const decision = confirmedDecision ?? await confirm({ reason, pages: changed.map(snapshot), canSave: changed.every(id => snapshot(id).canSave) });
    if (decision === "save" || decision === "retry") {
      for (const id of changed) if (!await retry(id)) return false;
      return changed.every(id => !dirty(ensure(id)));
    }
    if (decision !== "discard") return false;
    for (const id of changed) {
      const record = ensure(id);
      record.drafts = {};
      record.errors = {};
      record.message = "";
      // Explicit discard approves only these records. A future retry still
      // needs read-back if an already-admitted write had an unknown outcome.
      if (!record.uncertain) record.status = "unloaded";
      adoptDescriptor(record);
    }
    return true;
  }
  function reconcile() {
    for (const record of records.values()) {
      const page = registry.find(record.id);
      record.available = !!page && page.available !== false;
      if (!page) continue;
      if (JSON.stringify(page.descriptor) !== JSON.stringify(record.page.descriptor)) {
        record.changedDescriptor = page;
      }
      if (!adoptDescriptor(record) && !dirty(record) && !requests.has(record.id) && !wires.has(record.id) && !loads.has(record.id) && !reviews.has(record.id) && !record.uncertain) load(record.id);
    }
  }
  async function settle() {
    await Promise.all([...requests.values()]);
    for (const wire of [...wires.values()]) { try { await bounded(() => wire.catch(() => null)); } catch {} }
    return !wires.size && [...records.values()].every(record => !record.uncertain);
  }
  return { snapshot, edit, commit, load, retry, resolveDeparture, reconcile,
    settle,
    pageIds: () => [...records.keys()],
    hasWork: () => [...records.values()].some(record => dirty(record) || record.status === "saving" || wires.has(record.id) || record.uncertain),
    recoveryPages: () => [...records.values()].filter(record => !record.available && dirty(record)).map(record => record.page),
    dispose() { disposed = true; for (const record of records.values()) ++record.generation; },
  };
}
