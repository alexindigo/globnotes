import * as constants from "./constants.js";

import { Note, SearchResult } from "./classes.js";

import axios from "axios";
import { getStoredToken } from "./tokenStorage.js";
import { getToastOptions } from "./helpers.js";
import router from "./router.js";
import { readPathPrefix } from "./pathPrefix.js";
import { CHANGE_STREAM_STALL_MS } from "../shared/vault_changes.ts";
import { hasUnsavedWork } from "./sessionActions.js";
import { requestReauthentication } from "./reauthentication.js";
import { createOperationOwner } from "./operationOwner.js";
import { createSessionContext, retiredContext } from "./sessionContext.js";

const pathPrefix = readPathPrefix();

const api = axios.create({ baseURL: `${pathPrefix}/_/api` });

/** Prepared instance transport. Capture credentials before preparation/queueing;
 * callers own their final UI delivery separately from the original wire. */
export function createIdentityApi({ tokens, sessionKey, context = createSessionContext({ key: sessionKey, tokens }), prefix = pathPrefix,
  http = axios.create({ baseURL: `${prefix}/_/api` }), fetch: request = fetch,
  onAuthorityFailure = () => {} } = {}) {
  const get = http.get?.bind(http), post = http.post?.bind(http), send = http.request?.bind(http);
  async function exchange(kind, path, data, options = {}, recovery = false) {
    const { current, token } = context.transport(recovery);
    let result;
    const owner = createOperationOwner({ owner: Object.freeze({}),
      prepare() {
        const prepared = { ...options, headers: { ...(options.headers ?? {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
        return { value: prepared };
      },
      dispatch: prepared => kind === "read" ? get(path, prepared) : send({ ...prepared, method: kind, url: path, data }),
      channels: { failure: { deliver: error => onAuthorityFailure(error, current) } },
      completion: { prepare: response => ({ value: response.data }), deliver: value => { result = value; } },
    });
    const operation = owner.operation(kind === "read" ? "live" : "outcome", current);
    try {
      const response = await owner.dispatch(operation, path);
      if (!owner.complete(operation, response.value)) throw retiredContext();
    } catch (error) {
      if (!recovery && [401, 403].includes(error.response?.status ?? error.status)) owner.deliver(operation, "failure", error);
      throw error;
    } finally { (await owner.dispose()).throwIfFailed(); }
    if (kind === "read" && !current()) throw retiredContext();
    return result;
  }
  async function stream(open, options) {
    const { current, token } = context.transport(false);
    const owner = createOperationOwner({ owner: Object.freeze({}),
      prepare: value => ({ value: { ...value } }),
      dispatch: (value, delivery) => open({ ...value, request, readToken: () => token, basePrefix: prefix, isCurrent: current,
        onEvent: event => delivery.deliver("event", event), onClose: reason => delivery.deliver("close", reason) }),
      release: close => close?.(),
      channels: { event: { deliver: value => options.onEvent?.(value) }, close: { deliver: value => options.onClose?.(value) },
        failure: { deliver: error => onAuthorityFailure(error, current) } },
    });
    const operation = owner.operation("live", current);
    try { await owner.dispatch(operation, options); }
    catch (error) {
      if ([401, 403].includes(error.response?.status ?? error.status)) owner.deliver(operation, "failure", error);
      (await owner.dispose()).throwIfFailed(error);
    }
    return async () => { (await owner.dispose()).throwIfFailed(); };
  }
  return Object.freeze({ read: (path, options) => exchange("read", path, undefined, options),
    write: (method, path, data, options) => exchange(method, path, data, options),
    getConfig: () => exchange("read", "config", undefined, undefined, true), getStatus: () => exchange("read", "auth/check"),
    async getToken(username, password, totp) {
      const { current } = context.transport(true);
      const token = (await post("token", { username, password, ...(totp ? { totp } : {}) })).data.access_token;
      if (!current()) throw retiredContext();
      return token;
    },
    openPluginHostEvents: options => stream(openPluginHostEvents, options),
    openVaultChanges: options => stream(openVaultChanges, options),
  });
}

// The request's existing controller owns the forwarding listener too. Unlike
// AbortSignal.any this works on the configured Vite baseline browsers.
function followRequestSignal(controller, signal) {
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true, signal: controller.signal });
  return controller.signal;
}

// A refused response must not join an unrelated tee peer. Request retirement
// fences callbacks; observe cancellation without claiming that peer has ended.
function cancelResponseBody(response) {
  response.body?.cancel().catch(() => {});
}

api.interceptors.request.use(
  // If the request is not for the token endpoint, add the token to the headers.
  function (config) {
    if (config.url !== "token") {
      const token = getStoredToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  },
  function (error) {
    return Promise.reject(error);
  },
);

export { operationError } from "./operationErrors.js";

export function apiErrorHandler(error, toast) {
  if (error.response?.status === 401) {
    if (hasUnsavedWork()) {
      requestReauthentication();
      return;
    }
    // Browser plugin contributions die with the credential; reconnect
    // requires fresh authorization.
    import("./pluginRuntime.js").then((m) => m.stopPluginRuntime());
    const redirectPath = router.currentRoute.value.fullPath;
    router.push({
      name: "login",
      query: { [constants.params.redirect]: redirectPath },
    });
  } else {
    console.error(error);
    toast.add(
      getToastOptions(
        "Unknown error communicating with the server. Please try again.",
        "Unknown Error",
        "error",
      ),
    );
  }
}

export async function getConfig() {
  try {
    const response = await api.get("config");
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function postSetup(data) {
  try {
    const response = await api.post("setup", data);
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

// Prepared account transports do not use the legacy live-token interceptor.
// Controllers pass the credential captured by the original form at dispatch.
const accountApi = axios.create({ baseURL: `${pathPrefix}/_/api` });
const accountHeaders = ({ token = getStoredToken() } = {}) => ({ headers: token ? { Authorization: `Bearer ${token}` } : {} });
export const getOwnAccount = async options => (await accountApi.get("account", accountHeaders(options))).data;
export const patchOwnAccount = async (data, options) => (await accountApi.patch("account", data, accountHeaders(options))).data;
export const postAccountTotpEnrolment = async options => (await accountApi.post("account/totp-enrolment", undefined, accountHeaders(options))).data;
export const getSetupStatus = async () => (await accountApi.get("setup")).data;
export const postIdentitySetup = async data => (await accountApi.post("setup", data)).data;
export const postIdentitySetupEnrolment = async username => (await accountApi.post("setup/totp-enrolment", { username })).data;

export async function getAccessSettings() { return (await api.get("access")).data; }
export async function putAccessSettings(data) { return (await api.put("access", data)).data; }
export async function postAccessTotpEnrolment(username) { return (await api.post("access/totp-enrolment", { username })).data; }

export async function getConflicts() { return (await api.get("conflicts")).data; }
export async function getConflict(id) { return (await api.get(`conflicts/${encodeURIComponent(id)}`)).data; }
export async function resolveConflict(id, request) { return (await api.post(`conflicts/${encodeURIComponent(id)}/resolve`, request)).data; }

const driverRoute = id => `drivers/${encodeURIComponent(id)}`;
export async function getDrivers() { return (await api.get("drivers")).data; }
export async function postDriver(request) { return (await api.post("drivers", request)).data; }
export async function putDriver(id, request) { return (await api.put(driverRoute(id), request)).data; }
export async function deleteDriver(id, request) { return (await api.delete(driverRoute(id), { data: request })).data; }
export async function putDriverSecret(id, key, request) { return (await api.put(`${driverRoute(id)}/secrets/${encodeURIComponent(key)}`, request)).data; }
export async function deleteDriverSecret(id, key, request) { return (await api.delete(`${driverRoute(id)}/secrets/${encodeURIComponent(key)}`, { data: request })).data; }
export async function syncDriver(id, request) { return (await api.post(`${driverRoute(id)}/sync`, request)).data; }
export async function decideDriver(id, request) { return (await api.post(`${driverRoute(id)}/decisions`, request)).data; }

// Mint a TOTP enrolment bundle for the setup wizard (key, uri, qr,
// secret). Nothing is stored server-side until setup completes.
export async function postTotpEnrolment(username) {
  try {
    const response = await api.post("setup/totp-enrolment", { username });
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

// Re-arm first-run setup (menu: Access mode). Auth-required server-side.
export async function resetSetup() {
  try {
    const response = await api.post("setup/reset");
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function getToken(username, password, totp) {
  try {
    const response = await api.post("token", {
      username: username,
      password: totp ? password + totp : password,
    });
    return response.data.access_token;
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function authCheck() {
  try {
    const response = await api.get("auth-check");
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function getNotes(term, sort, order, limit, nested, folder) {
  try {
    const response = await api.get("search", {
      params: {
        term: term,
        sort: sort,
        order: order,
        limit: limit,
        nested: nested,
        folder: folder,
      },
    });
    return response.data.map((note) => new SearchResult(note));
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function createNote(path, content) {
  try {
    const response = await api.post("notes", {
      path: path,
      content: content,
    });
    return new Note(response.data);
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function getNote(path) {
  try {
    const response = await api.get(`notes/${encodeURIComponent(path)}`);
    return new Note(response.data);
  } catch (response) {
    return Promise.reject(response);
  }
}

// Server-rendered markdown (markdown-it + plugin pipeline). Returns raw
// HTML — axios must not try to JSON-parse it. `disabled` carries the
// client's localStorage plugin switches.
export async function getRenderedHtml(
  path,
  disabled = [],
  lineNumbers = false,
) {
  try {
    const params = {};
    if (disabled.length) params.disabled = disabled.join(",");
    if (lineNumbers) params.lineNumbers = "true";
    const response = await api.get(`render/${encodeURIComponent(path)}`, {
      params,
      transformResponse: (data) => data,
    });
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

/** Render an unsaved markdown buffer through the full pipeline (plugins
 * active, disabled switches honored) — the Preview tab's data source. */
export async function renderBuffer(markdown, disabled = []) {
  const params = {};
  if (disabled.length) params.disabled = disabled.join(",");
  const response = await api.post("render", markdown, {
    params,
    headers: { "content-type": "text/markdown" },
    transformResponse: (data) => data,
  });
  return response.data;
}

export async function getPlugins() {
  try {
    const response = await api.get("plugins");
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

/** `baseContent`: the text this update is based on (required by the server);
 * `onStale`: "copy" (default, keep both) or "refuse". */
export async function updateNote(path, newPath, newContent, fileRefs = "none", baseContent, onStale) {
  try {
    const response = await api.patch(
      `notes/${encodeURIComponent(path)}`,
      {
        newPath: newPath,
        newContent: newContent,
        ...(baseContent === undefined ? {} : { baseContent }),
        ...(onStale === undefined ? {} : { onStale }),
      },
      { params: { file_refs: fileRefs } },
    );
    return new Note(response.data);
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function previewRename(path, newPath) {
  // This endpoint previews references in the persisted note, not a queued
  // unsaved snapshot. An error is not evidence that no references exist.
  const response = await api.get("rename-preview", {
    params: { path: path, new_path: newPath },
  });
  return response.data;
}

export async function rewriteRefs(oldPath, newPath) {
  await api.post("files/rewrite-refs", null, {
    params: { old_path: oldPath, new_path: newPath },
  });
}

/** `version`: the note's version as loaded; a changed note is not deleted. */
export async function deleteNote(path, version) {
  try {
    await api.delete(`notes/${encodeURIComponent(path)}`, {
      params: { base_version: version },
    });
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function getTags() {
  try {
    const response = await api.get("tags");
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function getIndexStatus() {
  try {
    const response = await api.get("index-status");
    return response.data;
  } catch (_) {
    return { syncing: false, initial: false, done: 0, total: 0 };
  }
}

export async function getTree(path = "") {
  const response = await api.get("tree", { params: { path } });
  return response.data;
}

export async function getNoteIndex() {
  try {
    const response = await api.get("note-index");
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function uploadFile(file, directory) {
  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("directory", directory || "");
    const response = await api.post("files", formData, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
    });
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function postBrand(formData) {
  try {
    const response = await api.post("brand", formData, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
    });
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

// --- Plugin host control API (vault-owned plugin platform) ---------------
// The legacy getPlugins() listing stays for editor loaders; these wrappers
// talk to the authoritative /_/api/plugin-host namespace.

export async function getPluginHostCatalog() {
  try {
    const response = await api.get("plugin-host");
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function putPluginEnabled(id, enabled, policy) {
  try {
    const response = await api.put(
      `plugin-host/${encodeURIComponent(id)}/enabled`,
      { enabled, revision: policy.revision, signature: policy.signature },
    );
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function putPluginPolicy(autoEnable, policy) {
  try {
    const response = await api.put("plugin-host/policy", {
      autoEnable,
      revision: policy.revision,
      signature: policy.signature,
    });
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function getPluginSettings(id, page) {
  try {
    const response = await api.get(
      `plugin-host/${encodeURIComponent(id)}/settings/${encodeURIComponent(page)}`,
    );
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function putPluginSettings(id, page, values, revision, sourceKey) {
  try {
    const response = await api.put(
      `plugin-host/${encodeURIComponent(id)}/settings/${encodeURIComponent(page)}`,
      { values, revision, ...(sourceKey === undefined ? {} : { sourceKey }) },
    );
    return response.data;
  } catch (response) {
    return Promise.reject(response);
  }
}

/** One host-owned server-Worker consent projection, separate from settings/data. */
export async function getPluginPermissions(id) {
  return (await api.get(`plugin-host/${encodeURIComponent(id)}/permissions`)).data;
}
export async function putPluginPermissions(id, controls) {
  return (await api.put(`plugin-host/${encodeURIComponent(id)}/permissions`, controls)).data;
}
export async function getPluginPermissionRequests() {
  return (await api.get("plugin-host/permission-requests")).data;
}
export async function decidePluginPermissionRequest(id, requestId, controls) {
  return (await api.post(`plugin-host/${encodeURIComponent(id)}/permission-requests/${encodeURIComponent(requestId)}/decision`, controls)).data;
}

/** Invoke a registered server command; resolves with the command's actual
 * result value (not merely admission). */
export async function invokePluginCommand(id, command, payload = {}) {
  try {
    const response = await api.post(
      `plugin-host/${encodeURIComponent(id)}/commands/${encodeURIComponent(command)}`,
      payload,
    );
    return response.data.result;
  } catch (response) {
    return Promise.reject(response);
  }
}

/** Authenticated invalidation stream (SSE over fetch). onEvent receives
 * {event, data}; onClose fires on stream end (policy-change close, auth
 * failure) so the caller can reconnect with fresh authorization. Returns a
 * close function. Carries only IDs/revisions/status — never private data. */
export async function openPluginHostEvents({ onEvent, onClose, signal, request = fetch,
  readToken = getStoredToken, basePrefix = pathPrefix, isCurrent = () => true }) {
  const controller = new AbortController();
  const requestSignal = followRequestSignal(controller, signal);
  const token = readToken();
  const response = await request(`${basePrefix}/_/api/plugin-host/events`, {
    headers: token
      ? { authorization: `Bearer ${token}` }
      : {},
    signal: requestSignal,
  }).catch(error => { controller.abort(); throw error; });
  if (!isCurrent()) { controller.abort(); cancelResponseBody(response); return () => { controller.abort(); }; }
  if (!response.ok || !response.body) {
    controller.abort();
    cancelResponseBody(response);
    const error = new Error(`plugin events stream failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /event: (.+)/.exec(chunk)?.[1]?.trim();
          const data = /data: (.+)/.exec(chunk)?.[1];
          if (event && !requestSignal.aborted && isCurrent()) {
            onEvent({ event, data: data ? JSON.parse(data) : null });
          }
        }
      }
      if (!requestSignal.aborted && isCurrent()) onClose?.("ended");
    } catch (e) {
      if (!requestSignal.aborted && isCurrent()) {
        onClose?.(e instanceof Error ? e.message : "error");
      }
    } finally { controller.abort(); }
  })();
  return () => {
    controller.abort();
    reader.cancel().catch(() => undefined);
  };
}

/** Fetch-based SSE carries bearer authority on ordinary HTTP. A request that
 * receives no bytes for CHANGE_STREAM_STALL_MS (several server heartbeats)
 * has stalled, e.g. a half-open TCP connection or a buffering proxy: it is
 * aborted and reported as a failure (rejection before a response, onClose
 * after), so the owner reconnects through its backoff (vaultChanges.js). */
export async function openVaultChanges({ since = 0, poll = false, onEvent, onClose, signal, stallMs = CHANGE_STREAM_STALL_MS,
  request = fetch, readToken = getStoredToken, basePrefix = pathPrefix, isCurrent = () => true }) {
  const controller = new AbortController();
  const requestSignal = followRequestSignal(controller, signal);
  let stalled = null, watchdog, reader = null;
  const settle = () => { clearTimeout(watchdog); watchdog = undefined; };
  const stall = () => {
    if (requestSignal.aborted) return;
    stalled = Object.assign(new Error(`Vault changes stalled: no data for ${stallMs} ms`), { stalled: true });
    controller.abort(stalled);
    reader?.cancel(stalled).catch(() => {});
  };
  // Every received chunk (events and heartbeat comments alike) proves life.
  const alive = () => { settle(); if (!requestSignal.aborted) watchdog = setTimeout(stall, stallMs); };
  // Abandoned by its owner (or stalled): the watchdog has nothing left to watch.
  requestSignal.addEventListener("abort", settle, { once: true });
  alive();
  let response, packet;
  // The one way a change response body is read, stream or poll: chunk by
  // chunk, each chunk re-arming the watchdog, so a large poll on a slow link
  // that is still making progress is never mistaken for a stall.
  const read = async () => {
    const result = await reader.read();
    if (!result.done) alive();
    return result;
  };
  const readJson = async () => {
    // Without a body reader there are no chunks to observe; only then the
    // whole-body read, still bounded by the watchdog.
    if (!response.body?.getReader) return await response.json();
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    if (stalled) throw stalled;
    return JSON.parse(text + decoder.decode());
  };
  try {
    const headers = { accept: poll ? "application/json" : "text/event-stream" };
    const token = readToken();
    if (token) headers.authorization = `Bearer ${token}`;
    response = await request(`${basePrefix}/_/api/changes?since=${since}${poll ? "&poll=1" : ""}`, { headers, signal: requestSignal });
    if (!isCurrent()) { settle(); controller.abort(); cancelResponseBody(response); return () => { controller.abort(); }; }
    if (!response.ok) {
      controller.abort(); cancelResponseBody(response);
      throw Object.assign(new Error(`Vault changes failed: ${response.status}`), { status: response.status });
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) packet = await readJson();
  } catch (error) {
    settle();
    controller.abort();
    throw stalled ?? error;
  }
  if (packet) {
    settle();
    let timer;
    const deliver = value => { if (!requestSignal.aborted && isCurrent()) onEvent(value); };
    if (!requestSignal.aborted && isCurrent()) {
      if (packet.gap) deliver({ event: "reset", data: { next: packet.next } });
      else for (const entry of packet.entries) deliver({ event: "change", data: entry });
      deliver({ event: "cursor", data: { next: packet.next } });
      if (packet.conflictRevision !== undefined) deliver({ event: "conflicts", data: { revision: packet.conflictRevision } });
      if (packet.driverRevision !== undefined) deliver({ event: "drivers", data: { revision: packet.driverRevision } });
      if (!requestSignal.aborted && isCurrent()) timer = setTimeout(() => { if (!requestSignal.aborted && isCurrent()) onClose?.("poll"); controller.abort(); }, 1000);
    }
    return () => { clearTimeout(timer); controller.abort(); };
  }
  if (!response.body?.getReader) {
    settle();
    cancelResponseBody(response);
    return openVaultChanges({ since, poll: true, onEvent, onClose, signal: requestSignal, stallMs, request, readToken, basePrefix, isCurrent });
  }
  reader = response.body.getReader();
  const decoder = new TextDecoder();
  alive();
  (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (event && data && !requestSignal.aborted && isCurrent()) onEvent({ event, data: JSON.parse(data) });
        }
      }
      settle();
      if (!isCurrent()) return;
      if (stalled) onClose?.(stalled);
      else if (!requestSignal.aborted) onClose?.("ended");
    } catch (error) {
      settle();
      if (!isCurrent()) return;
      if (stalled) onClose?.(stalled);
      else if (!requestSignal.aborted) onClose?.(error);
    } finally { controller.abort(); }
  })();
  return () => { settle(); controller.abort(); reader.cancel().catch(() => {}); };
}
