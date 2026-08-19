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

export function apiErrorHandler(error, toast) {
  if (error.response?.status === 401) {
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

export async function createNote(title, content) {
  try {
    const response = await api.post("notes", {
      title: title,
      content: content,
    });
    return new Note(response.data);
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function getNote(title) {
  try {
    const response = await api.get(`notes/${encodeURIComponent(title)}`);
    return new Note(response.data);
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function updateNote(
  title,
  newTitle,
  newContent,
  fileRefs = "none",
) {
  try {
    const response = await api.patch(
      `notes/${encodeURIComponent(title)}`,
      {
        newTitle: newTitle,
        newContent: newContent,
      },
      { params: { file_refs: fileRefs } },
    );
    return new Note(response.data);
  } catch (response) {
    return Promise.reject(response);
  }
}

export async function previewRename(title, newTitle) {
  try {
    const response = await api.get("rename-preview", {
      params: { title: title, new_title: newTitle },
    });
    return response.data;
  } catch (_) {
    return [];
  }
}

export async function rewriteRefs(oldPath, newPath) {
  await api.post("files/rewrite-refs", null, {
    params: { old_path: oldPath, new_path: newPath },
  });
}

export async function deleteNote(title) {
  try {
    await api.delete(`notes/${encodeURIComponent(title)}`);
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
