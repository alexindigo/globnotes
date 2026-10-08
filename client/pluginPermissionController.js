// SPDX-License-Identifier: LGPL-3.0-only
import { reactive, ref } from "vue";

const copy = value => JSON.parse(JSON.stringify(value));
export const permissionScopeKey = scope => scope.type === "all" ? "all" : `host:${scope.authority}`;
export const hasServerContribution = plugin => !!(plugin?.rendering || plugin?.runtime?.server || plugin?.endpoints);
export function permissionControls(view) {
  return copy({ revision: view.revision, signature: view.signature,
    requestSourceKey: view.requestSourceKey, requestSourceRevision: view.requestSourceRevision,
    allowNetwork: view.allowNetwork, approvedNetwork: view.approvedNetwork, approvedImports: view.approvedImports });
}
const sameSource = (left, right) => left.requestSourceKey === right.requestSourceKey && left.requestSourceRevision === right.requestSourceRevision;
const sameAdmission = (left, right) => sameSource(left, right) && left.revision === right.revision && left.signature === right.signature;
const bucket = kind => kind === "imports" ? "approvedImports" : "approvedNetwork";
function intentControls(view, intent) {
  const controls = permissionControls(view);
  if (intent.type === "master") controls.allowNetwork = intent.value;
  if (intent.type === "approve") {
    const key = bucket(intent.kind), scopes = new Map(controls[key].map(scope => [permissionScopeKey(scope), scope]));
    scopes.set(permissionScopeKey(intent.scope), copy(intent.scope)); controls[key] = [...scopes.values()];
  }
  if (intent.type === "remove") {
    const remove = new Set(intent.coverage.map(permissionScopeKey)), key = bucket(intent.kind);
    controls[key] = controls[key].filter(scope => !remove.has(permissionScopeKey(scope)));
  }
  if (intent.type === "decision") {
    controls.decision = intent.decision;
    if (intent.decision === "approve") {
      controls.allowNetwork = intent.allowNetwork;
      const key = bucket(intent.kind), scopes = new Map(controls[key].map(scope => [permissionScopeKey(scope), scope]));
      for (const scope of intent.scopes) scopes.set(permissionScopeKey(scope), copy(scope));
      controls[key] = [...scopes.values()];
    }
  }
  return controls;
}

/** Host operator state only. Adapters own transport; components receive snapshots
 * and callbacks. Request admission never changes local effective permissions. */
export function createPluginPermissionController({ readView, writeView, readPending,
  decideRequest, changed = () => {}, timeout = 10000, clock = globalThis }) {
  const sessionKey = ref("initial"), eligible = ref(false), writable = ref(false), pendingRequests = ref([]);
  const namespaces = new Map(), queues = new Map();
  let epoch = 0, pendingGeneration = 0, disposed = false;
  function namespace() {
    let value = namespaces.get(sessionKey.value);
    if (!value) { value = { records: reactive(new Map()), requestDrafts: reactive(new Map()), deferred: reactive(new Set()) }; namespaces.set(sessionKey.value, value); }
    return value;
  }
  function ensure(id) {
    const records = namespace().records;
    if (!records.has(id)) records.set(id, { id, plugin: null, view: null, available: true,
      pending: 0, inFlight: 0, loadGeneration: 0, intentVersion: 0, draft: null, error: "", status: "unloaded",
      needsReview: false, unknown: false, readBack: false });
    return records.get(id);
  }
  function snapshot(id) {
    const record = ensure(id);
    return { ...record, busy: record.pending > 0 || record.inFlight > 0, writable: writable.value && eligible.value && record.available,
      hasServer: hasServerContribution(record.plugin), controls: record.draft?.controls ?? (record.view ? permissionControls(record.view) : null) };
  }
  async function bounded(operation) {
    let timer;
    try { return await Promise.race([operation(), new Promise((_, reject) => {
      timer = clock.setTimeout(() => reject(Error("Permission write outcome is unknown. Read current status before an explicit retry.")), timeout);
    })]); } finally { clock.clearTimeout(timer); }
  }
  function install(record, view) {
    if (view?.pluginId !== record.id) throw Error("Permission response belongs to another plugin.");
    if (record.view && view.source.revision < record.view.source.revision) return false;
    if (record.view && sameSource(view, record.view) && view.revision < record.view.revision) return false;
    const obsolete = record.draft && !sameSource(record.draft.base, view);
    record.view = copy(view);
    if (obsolete) {
      record.needsReview = true; record.error = "The request source changed. Your permission choices are retained; review the current source before retrying.";
    }
    return true;
  }
  async function load(id, { force = false } = {}) {
    const record = ensure(id), ownerEpoch = epoch, ticket = ++record.loadGeneration;
    const current = () => !disposed && eligible.value && ownerEpoch === epoch && ticket === record.loadGeneration && record.available;
    const receipt = (status, acceptedView) => ({ status, snapshot: snapshot(id), current: () => status === "accepted" && current() && record.view === acceptedView });
    if (!eligible.value || disposed || !record.available) return receipt("inactive");
    if (!force && record.pending) return receipt("superseded");
    try {
      const view = await bounded(() => readView(id));
      if (!current() || !install(record, view)) return receipt("superseded");
      if (!record.draft) { record.status = "idle"; record.error = ""; }
      record.readBack = true;
      return receipt("accepted", record.view);
    } catch (error) {
      if (!current()) return receipt("superseded");
      record.error = error.response?.data?.detail ?? error.message; record.status = "error";
      return receipt("error");
    }
  }
  async function refreshPending() {
    const ownerEpoch = epoch, ticket = ++pendingGeneration;
    if (!eligible.value || disposed) return;
    try {
      const requests = await bounded(() => readPending());
      if (!disposed && eligible.value && ownerEpoch === epoch && ticket === pendingGeneration) pendingRequests.value = copy(requests);
    } catch { /* Keep current pending records; catalogue/source reconciliation still fences them. */ }
  }
  function reconcile(catalog) {
    const wanted = new Map((catalog?.plugins ?? []).map(plugin => [plugin.id, plugin]));
    for (const record of namespace().records.values()) {
      record.available = wanted.has(record.id);
      if (!record.available) { if (record.draft) record.error = "Plugin unavailable. Your permission choices are retained."; continue; }
      record.plugin = copy(wanted.get(record.id));
      if (record.plugin.permissions && !record.pending) install(record, record.plugin.permissions);
    }
    for (const plugin of wanted.values()) {
      const record = ensure(plugin.id); record.available = true; record.plugin = copy(plugin);
      if (plugin.permissions && !record.pending) install(record, plugin.permissions);
    }
    pendingRequests.value = pendingRequests.value.filter(request => {
      const plugin = wanted.get(request.pluginId);
      if (!plugin) return false;
      const view = plugin.permissions;
      return !view || (request.source.key === view.source.key && request.source.revision === view.source.revision && view.pendingRequests.some(item => item.id === request.id));
    });
  }
  function setSession(key, { active, canWrite }) {
    if (key !== sessionKey.value || active !== eligible.value || canWrite !== writable.value) {
      epoch++; pendingGeneration++; pendingRequests.value = [];
      sessionKey.value = key; eligible.value = active; writable.value = canWrite;
    }
  }
  async function admit(id, intent, reviewed = false, expectedView) {
    const record = ensure(id);
    if (!eligible.value || !writable.value || !record.available || !hasServerContribution(record.plugin)) {
      record.error = "Sandboxed server permission controls are unavailable in this session."; return false;
    }
    if (!record.view) await load(id);
    if (!record.view || record.inFlight || (record.unknown && !record.readBack) || (record.needsReview && !reviewed)) return false;
    if (expectedView && !sameAdmission(expectedView, record.view)) {
      record.draft = { intent: copy(intent), base: permissionControls(expectedView), controls: intentControls(expectedView, intent), version: ++record.intentVersion };
      record.needsReview = true; record.error = "Permissions or source changed during confirmation. Your choice is retained; review updated status."; return false;
    }
    if (intent.type === "decision" && !record.view.pendingRequests.some(request => request.id === intent.requestId && request.kind === intent.kind)) {
      record.error = "That request is no longer pending. Review current status; no stale decision was sent."; return false;
    }
    const base = permissionControls(record.view), controls = intentControls(record.view, intent);
    const ownerEpoch = epoch, version = ++record.intentVersion;
    const active = () => !disposed && eligible.value && ownerEpoch === epoch;
    record.draft = { intent: copy(intent), base, controls, version }; record.pending++; ++record.loadGeneration;
    const queueKey = `${sessionKey.value}\0${id}`, previous = queues.get(queueKey) ?? Promise.resolve();
    const task = previous.then(async () => {
      if (!active()) return false;
      if (!sameAdmission(base, record.view)) {
        record.needsReview = true; record.error = "Permissions changed while your choice was queued. Review updated status; your choice is retained."; return false;
      }
      record.status = "saving"; record.error = ""; record.readBack = false;
      let observed = false;
      record.inFlight++;
      const wire = Promise.resolve().then(() => intent.type === "decision"
        ? decideRequest(id, intent.requestId, controls) : writeView(id, controls));
      wire.then(result => {
        if (!observed && active() && record.status === "unknown") {
          install(record, result.view);
          if (sameSource(base, record.view) && record.draft?.version === version) {
            record.draft = null; record.unknown = false; record.needsReview = false;
            record.status = "idle"; record.error = "Late permission acknowledgement received; review current status.";
          }
        }
      }, () => { /* The observed error/read-back path retains the decision. */ })
        .finally(() => { record.inFlight--; }).catch(() => { /* Malformed late response is not acknowledgement. */ });
      try {
        const result = await bounded(() => wire);
        observed = true;
        if (!active()) return false;
        install(record, result.view);
        if (record.draft?.version === version) record.draft = null;
        record.needsReview = false; record.unknown = false; record.status = "idle";
        if (intent.type === "decision") namespace().requestDrafts.delete(intent.requestId);
        await refreshPending();
        Promise.resolve(changed(result.view)).catch(() => { if (active()) record.error = "Permission decision saved; catalogue refresh failed. Review current status."; });
        return true;
      } catch (error) {
        if (!active()) return false;
        const code = error.response?.data?.code;
        const rejected = ["permission_revision_conflict", "permission_source_conflict", "invalid_permission_scope", "invalid_permission_control", "permission_request_conflict"].includes(code);
        record.error = error.response?.data?.detail ?? error.message;
        record.needsReview = error.response?.status === 409; record.unknown = !rejected;
        record.status = record.unknown ? "unknown" : "conflict";
        if (record.unknown) await load(id, { force: true });
        return false;
      }
    }).finally(() => { record.pending--; if (queues.get(queueKey) === task) queues.delete(queueKey); });
    queues.set(queueKey, task);
    return task;
  }
  async function review(id) {
    const record = ensure(id); await load(id, { force: true });
    if (record.pending || record.inFlight || !record.readBack || !record.draft || !record.available) return !record.draft;
    if (record.draft.intent.type === "decision" && !record.view.pendingRequests.some(request => request.id === record.draft.intent.requestId)) {
      record.needsReview = true; record.error = "That request is no longer pending. Your choices are retained for review; no decision was retried."; return false;
    }
    record.needsReview = false; return true;
  }
  async function retry(id) {
    const record = ensure(id);
    if (!record.draft || !await review(id)) return false;
    return admit(id, copy(record.draft.intent), true);
  }
  function discard(id) {
    const record = ensure(id);
    if (record.pending || record.inFlight || (record.unknown && !record.readBack)) return false;
    record.draft = null; record.error = ""; record.needsReview = false; record.unknown = false; record.status = "idle";
    for (const [requestId, draft] of namespace().requestDrafts) if (draft.pluginId === id) namespace().requestDrafts.delete(requestId);
    return true;
  }
  function defer(requestId) { namespace().deferred.add(requestId); }
  function requestChoices(request) {
    const drafts = namespace().requestDrafts;
    if (!drafts.has(request.id)) drafts.set(request.id, { pluginId: request.pluginId, source: copy(request.source), allowNetwork: ensure(request.pluginId).view?.allowNetwork ?? false,
      scopes: copy(request.scopes.filter(scope => scope.type !== "all")), edited: false });
    return drafts.get(request.id);
  }
  function editRequest(request, changes) {
    const draft = requestChoices(request); Object.assign(draft, copy(changes), { edited: true });
  }
  function nextRequest() {
    return pendingRequests.value.find(request => {
      const record = ensure(request.pluginId);
      return request.state === "pending" && !namespace().deferred.has(request.id) && record.available && record.plugin &&
        (!record.view || record.view.pendingRequests.some(item => item.id === request.id && item.source.key === request.source.key && item.source.revision === request.source.revision));
    }) ?? null;
  }
  async function settle() {
    const recordList = [...namespace().records.values()];
    await Promise.all([...queues.values()]);
    return recordList.every(record => !record.pending && !record.inFlight && !record.unknown);
  }
  return { snapshot, load, reconcile, setSession, refreshPending, pendingRequests, requestChoices, editRequest,
    approve: (id, kind, scope, expectedView) => admit(id, { type: "approve", kind, scope }, false, expectedView),
    remove: (id, kind, coverage, expectedView) => admit(id, { type: "remove", kind, coverage }, false, expectedView),
    setMaster: (id, value) => admit(id, { type: "master", value }),
    decide: (id, request, decision, allowNetwork, scopes = []) => admit(id, { type: "decision", requestId: request.id, kind: request.kind, decision, allowNetwork, scopes }),
    review, retry, discard, defer, nextRequest, settle,
    hasWork: () => [...namespace().records.values()].some(record => record.draft || record.pending || record.inFlight || record.unknown) || [...namespace().requestDrafts.values()].some(draft => draft.edited),
    recoveryIds: () => [...new Set([...namespace().records.values()].filter(record => record.draft).map(record => record.id).concat([...namespace().requestDrafts.values()].filter(draft => draft.edited).map(draft => draft.pluginId)))],
    dispose() { disposed = true; epoch++; pendingGeneration++; pendingRequests.value = []; } };
}
