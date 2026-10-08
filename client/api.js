import * as constants from "./constants.js";

import { Note, SearchResult } from "./classes.js";

import axios from "axios";
import { getStoredToken } from "./tokenStorage.js";
import { getToastOptions } from "./helpers.js";
import router from "./router.js";

const pathPrefix =
  document.querySelector('meta[name="globnotes-prefix"]')?.content || "";

const api = axios.create({ baseURL: `${pathPrefix}/_/api` });

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

/** Structured guarded-operation failures (server/plugins/errors.ts). These
 * codes must be checked BEFORE any status-only branch — a 409 from a
 * plugin guard is not a duplicate title. */
export function operationError(error) {
  const data = error?.response?.data;
  if (!data || typeof data !== "object" || typeof data.code !== "string") {
    return null;
  }
  const plugin = data.pluginId ? ` (plugin: ${data.pluginId})` : "";
  switch (data.code) {
    case "plugin_cancelled":
      return {
        code: data.code,
        title: "Blocked by plugin",
        message: `${data.detail || "A plugin cancelled this operation."}${plugin}`,
      };
    case "plugin_guard_failed":
      return {
        code: data.code,
        title: "Plugin guard failed",
        message:
          `${data.detail || "A required plugin guard failed or is unavailable."}${plugin}`,
      };
    case "operation_conflict":
      return {
        code: data.code,
        title: "Conflict",
        message: data.detail ||
          "The vault changed while this operation was pending; it was not applied.",
      };
    case "operation_partial":
      return {
        code: data.code,
        title: "Partial failure",
        message: data.detail ||
          "Some changes could not be completed. Do not retry blindly.",
      };
    default:
      return null;
  }
}

export function apiErrorHandler(error, toast) {
  if (error.response?.status === 401) {
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

export async function getAccessSettings() { return (await api.get("access")).data; }
export async function putAccessSettings(data) { return (await api.put("access", data)).data; }
export async function postAccessTotpEnrolment(username) { return (await api.post("access/totp-enrolment", { username })).data; }

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

export async function updateNote(path, newPath, newContent, fileRefs = "none") {
  try {
    const response = await api.patch(
      `notes/${encodeURIComponent(path)}`,
      {
        newPath: newPath,
        newContent: newContent,
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

export async function deleteNote(path) {
  try {
    await api.delete(`notes/${encodeURIComponent(path)}`);
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

export async function putPluginSettings(id, page, values, revision) {
  try {
    const response = await api.put(
      `plugin-host/${encodeURIComponent(id)}/settings/${encodeURIComponent(page)}`,
      { values, revision },
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
export async function openPluginHostEvents({ onEvent, onClose, signal }) {
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const response = await fetch(`${pathPrefix}/_/api/plugin-host/events`, {
    headers: getStoredToken()
      ? { authorization: `Bearer ${getStoredToken()}` }
      : {},
    signal: requestSignal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
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
          if (event) {
            onEvent({ event, data: data ? JSON.parse(data) : null });
          }
        }
      }
      if (!requestSignal.aborted) onClose?.("ended");
    } catch (e) {
      if (!requestSignal.aborted) {
        onClose?.(e instanceof Error ? e.message : "error");
      }
    }
  })();
  return () => {
    controller.abort();
    reader.cancel().catch(() => undefined);
  };
}
