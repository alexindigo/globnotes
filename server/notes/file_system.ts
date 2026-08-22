// SPDX-License-Identifier: LGPL-3.0-only

/**
 * File-system notes storage, ported line-for-line from the Python
 * FileSystemNotes (server/notes/file_system/file_system.py).
 * Index hooks (reindex / delete-from-index / sync) are forwarded
 * through the optional `state.indexer` — a no-op until commit 5.
 */

import type { FileRef, Note, NoteCreate, NoteUpdate } from "./models.ts";
import {
  InvalidTitleError,
  NoteExistsError,
  NoteNotFoundError,
} from "./models.ts";
import { isValidNotePath, resolveInRoot } from "@server/helpers.ts";
import { state } from "@server/state.ts";
import { logger } from "@server/logger.ts";
import { walk } from "@std/fs/walk";
import * as path from "@std/path";

const MARKDOWN_EXT = ".md";

// Regex patterns ported from file_system.py.
const LOCAL_REF_MD = /(!?\[[^\]]*\])\(\s*([^)\s]+)\s*\)/g;
const LOCAL_REF_HTML = /src="([^"]+)"/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class FileSystemNotes {
  readonly storagePath: string;
  #scanCache: { ts: number; names: string[] } | null = null;
  #scanCacheTtl: number;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.#scanCacheTtl = Number(
      Deno.env.get("GLOBNOTES_SCAN_CACHE_TTL") ?? "15",
    );
  }

  // region public API

  create(data: NoteCreate): Note {
    const title = (data.title ?? "").trim();
    if (!title) throw new InvalidTitleError("title cannot be empty");
    this.#validateNotePath(title);
    const filepath = this.#pathFromTitle(title);
    try {
      Deno.mkdirSync(path.dirname(filepath), { recursive: true });
      this.#writeFile(filepath, data.content ?? "", false);
    } catch (e) {
      if (
        e instanceof Deno.errors.AlreadyExists ||
        e instanceof Deno.errors.NotADirectory ||
        e instanceof Deno.errors.IsADirectory
      ) {
        throw new NoteExistsError(
          `Failed to create '${title}': ${(e as Error).message}`,
        );
      }
      throw e;
    }
    state.indexer?.reindexNote(title);
    this.#invalidateScanCache();
    return this.#noteFromFile(title, filepath);
  }

  get(title: string): Note {
    this.#validateNotePath(title);
    const filepath = this.#pathFromTitle(title);
    try {
      return this.#noteFromFile(title, filepath);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new NoteNotFoundError(
          "The specified note cannot be found.",
        );
      }
      throw e;
    }
  }

  update(title: string, data: NoteUpdate, fileRefs = "none"): Note {
    this.#validateNotePath(title);
    const oldTitle = title;
    let filepath = this.#pathFromTitle(title);
    const oldDir = path.dirname(filepath);
    const movedFiles: Record<string, string> = {};
    let contentWritten: string | null = null;

    if (
      data.newTitle !== undefined &&
      data.newTitle !== null &&
      data.newTitle !== title
    ) {
      const newTitle = data.newTitle.trim();
      if (!newTitle) throw new InvalidTitleError("title cannot be empty");
      this.#validateNotePath(newTitle);
      const newFilepath = this.#pathFromTitle(newTitle);
      const newDir = path.dirname(newFilepath);

      if (filepath !== newFilepath) {
        try {
          Deno.statSync(newFilepath);
          throw new NoteExistsError(
            `Failed to rename. '${newTitle}' already exists.`,
          );
        } catch (e) {
          if (e instanceof NoteExistsError) throw e;
          // NotFound → available
        }
      }

      const actionRefs = fileRefs === "move" || fileRefs === "relink";
      if (actionRefs) {
        let currentContent: string;
        if (data.newContent !== undefined && data.newContent !== null) {
          currentContent = data.newContent;
        } else {
          currentContent = this.#readFile(filepath);
        }
        contentWritten = currentContent;
        const refs = this.#scanLocalRefs(currentContent, oldDir);

        if (refs.length > 0) {
          const root = this.storagePath;
          let oldRelDir = path.relative(root, oldDir).replace(/\\/g, "/");
          let newRelDir = path.relative(root, newDir).replace(/\\/g, "/");
          if (oldRelDir === ".") oldRelDir = "";
          if (newRelDir === ".") newRelDir = "";

          if (fileRefs === "move") {
            for (const r of refs) {
              if (
                r.kind !== "same-folder" &&
                (r.kind !== "absolute" ||
                  !r.path.startsWith(oldRelDir ? oldRelDir + "/" : ""))
              ) {
                continue;
              }
              const sub = oldRelDir
                ? r.path.slice(oldRelDir.length).replace(/^\//, "")
                : r.path;
              const newRel = newRelDir ? newRelDir + "/" + sub : sub;
              const oldFile = path.join(root, r.path);
              const newFile = path.join(root, newRel);
              try {
                Deno.mkdirSync(path.dirname(newFile), { recursive: true });
                Deno.renameSync(oldFile, newFile);
                movedFiles[r.path] = newRel;
              } catch {
                // OSError in Python → silently continue
              }
            }
          }

          for (const r of refs) {
            const newUrl = FileSystemNotes.#rebaseUrl(
              r.url,
              oldRelDir,
              newRelDir,
              movedFiles,
            );
            if (newUrl !== r.url) {
              contentWritten = contentWritten!
                .replace(
                  new RegExp(
                    `(!?\\[[^\\]]*\\])\\(\\s*${escapeRegex(r.url)}\\s*\\)`,
                    "g",
                  ),
                  `$1(${newUrl})`,
                )
                .replace(
                  new RegExp(`src="${escapeRegex(r.url)}"`, "g"),
                  `src="${newUrl}"`,
                );
            }
          }

          if (data.newContent !== undefined && data.newContent !== null) {
            data.newContent = contentWritten!;
          } else {
            currentContent = contentWritten!;
          }
        }
      }

      try {
        Deno.mkdirSync(newDir, { recursive: true });
        Deno.renameSync(filepath, newFilepath);
      } catch (e) {
        if (
          e instanceof Deno.errors.AlreadyExists ||
          e instanceof Deno.errors.NotADirectory ||
          e instanceof Deno.errors.IsADirectory
        ) {
          throw new NoteExistsError(
            `Failed to rename to '${newTitle}': ${(e as Error).message}`,
          );
        }
        throw e;
      }
      this.#pruneEmptyParents(oldDir);
      if (actionRefs && contentWritten !== null) {
        this.#writeFile(newFilepath, contentWritten, true);
      }
      title = newTitle;
      filepath = newFilepath;
    }

    let content: string;
    if (data.newContent !== undefined && data.newContent !== null) {
      this.#writeFile(filepath, data.newContent, true);
      content = data.newContent;
    } else {
      content = this.#readFile(filepath);
    }

    const moved = Object.entries(movedFiles).map(([o, n]) => ({
      oldPath: o,
      newPath: n,
    }));
    if (oldTitle !== title) state.indexer?.deleteFromIndex(oldTitle);
    state.indexer?.reindexNote(title);
    this.#invalidateScanCache();
    return {
      ...this.#noteFromFile(title, filepath),
      content,
      movedFiles: moved,
    };
  }

  previewRename(title: string, newTitle: string): FileRef[] {
    this.#validateNotePath(title);
    this.#validateNotePath(newTitle);
    const filepath = this.#pathFromTitle(title);
    let content: string;
    try {
      content = this.#readFile(filepath);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new NoteNotFoundError(
          "The specified note cannot be found.",
        );
      }
      throw e;
    }
    return this.#scanLocalRefs(content, path.dirname(filepath));
  }

  async rewriteRefs(oldPath: string, newPath: string): Promise<void> {
    const root = this.storagePath;
    const fname = oldPath.split("/").pop()!;
    for await (
      const entry of walk(root, { includeDirs: false, exts: [".md"] })
    ) {
      let content = this.#readFile(entry.path);
      if (!content.includes(fname)) continue;
      const noteDir = path.dirname(entry.path);
      const refs = this.#scanLocalRefs(content, noteDir, false);
      let changed = false;
      const noteRel = path.relative(root, noteDir).replace(/\\/g, "/");
      for (const r of refs) {
        if (r.path !== oldPath) continue;
        const newUrl = FileSystemNotes.#rebaseUrl(
          r.url,
          noteRel,
          noteRel,
          { [oldPath]: newPath },
        );
        if (newUrl === r.url) continue;
        content = content
          .replace(
            new RegExp(
              `(!?\\[[^\\]]*\\])\\(\\s*${escapeRegex(r.url)}\\s*\\)`,
              "g",
            ),
            `$1(${newUrl})`,
          )
          .replace(
            new RegExp(`src="${escapeRegex(r.url)}"`, "g"),
            `src="${newUrl}"`,
          );
        changed = true;
      }
      if (changed) this.#writeFile(entry.path, content, true);
    }
  }

  delete(title: string): void {
    this.#validateNotePath(title);
    const filepath = this.#pathFromTitle(title);
    try {
      Deno.removeSync(filepath);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new NoteNotFoundError(
          "The specified note cannot be found.",
        );
      }
      throw e;
    }
    this.#pruneEmptyParents(path.dirname(filepath));
    state.indexer?.deleteFromIndex(title);
    this.#invalidateScanCache();
  }

  listLevel(dirPath = ""): {
    folders: { name: string; path: string }[];
    notes: string[];
  } {
    if (dirPath) this.#validateNotePath(dirPath);
    const resolved = dirPath
      ? resolveInRoot(this.storagePath, dirPath)
      : this.storagePath;
    try {
      Deno.statSync(resolved);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new NoteNotFoundError(
          "The specified note cannot be found.",
        );
      }
      throw e;
    }
    const folders: { name: string; path: string }[] = [];
    const notes: string[] = [];
    for (const entry of Deno.readDirSync(resolved)) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory) {
        const childPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
        folders.push({ name: entry.name, path: childPath });
      } else if (entry.name.endsWith(MARKDOWN_EXT)) {
        const title = entry.name.slice(0, -MARKDOWN_EXT.length);
        notes.push(dirPath ? `${dirPath}/${title}` : title);
      }
    }
    return {
      folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
      notes: notes.sort(),
    };
  }

  getTitles(): string[] {
    return this.#listAllNoteFilenames().map((f) => this.#stripExt(f));
  }

  // endregion

  // region private helpers

  #pathFromTitle(title: string): string {
    try {
      return resolveInRoot(this.storagePath, title + MARKDOWN_EXT);
    } catch (e) {
      throw new InvalidTitleError((e as Error).message);
    }
  }

  /** isValidNotePath at the storage boundary: helpers throw plain Error,
   * endpoints map InvalidTitleError → 400 (Python: ValueError). */
  #validateNotePath(value: string): string {
    try {
      return isValidNotePath(value);
    } catch (e) {
      throw new InvalidTitleError((e as Error).message);
    }
  }

  #noteFromFile(title: string, filepath: string): Note {
    return {
      title,
      content: this.#readFile(filepath),
      lastModified: (Deno.statSync(filepath).mtime?.getTime() ?? 0) / 1000,
      movedFiles: [],
    };
  }

  #pruneEmptyParents(dirPath: string): void {
    const root = Deno.realPathSync(this.storagePath);
    let d = Deno.realPathSync(dirPath);
    while (d !== root && path.common([root, d]) === root) {
      try {
        Deno.removeSync(d);
      } catch {
        break;
      }
      d = path.dirname(d);
    }
  }

  #readFile(filePath: string): string {
    logger.debug(`Reading from '${filePath}'`);
    return Deno.readTextFileSync(filePath);
  }

  #writeFile(filePath: string, content: string, overwrite: boolean): void {
    logger.debug(`Writing to '${filePath}'`);
    if (overwrite) {
      Deno.writeTextFileSync(filePath, content);
    } else {
      const f = Deno.openSync(filePath, { write: true, createNew: true });
      try {
        f.writeSync(new TextEncoder().encode(content));
      } finally {
        f.close();
      }
    }
  }

  #listAllNoteFilenames(): string[] {
    const ttl = this.#scanCacheTtl;
    const now = performance.now() / 1000;
    if (this.#scanCache !== null && now - this.#scanCache.ts < ttl) {
      return this.#scanCache.names;
    }
    const names: string[] = [];
    const root = this.storagePath;
    const prefix = root.endsWith(path.SEPARATOR) ? root : root + path.SEPARATOR;

    function walkDir(dir: string): void {
      for (const entry of Deno.readDirSync(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory) {
          walkDir(full);
        } else if (entry.name.endsWith(MARKDOWN_EXT)) {
          names.push(full.slice(prefix.length));
        }
      }
    }
    walkDir(root);
    this.#scanCache = { ts: now, names };
    return names;
  }

  #invalidateScanCache(): void {
    this.#scanCache = null;
  }

  #scanLocalRefs(
    content: string,
    oldDir: string,
    checkExistence = true,
  ): FileRef[] {
    const refs: FileRef[] = [];
    const allMd = content.matchAll(new RegExp(LOCAL_REF_MD.source, "g"));
    for (const m of allMd) {
      FileSystemNotes.#classifyRef(
        m[2],
        oldDir,
        refs,
        this.storagePath,
        checkExistence,
      );
    }
    const allHtml = content.matchAll(
      new RegExp(LOCAL_REF_HTML.source, "g"),
    );
    for (const m of allHtml) {
      FileSystemNotes.#classifyRef(
        m[1],
        oldDir,
        refs,
        this.storagePath,
        checkExistence,
      );
    }
    return refs;
  }

  static #classifyRef(
    url: string,
    oldDir: string,
    out: FileRef[],
    root: string,
    checkExistence: boolean,
  ): void {
    if (
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("//") ||
      url.startsWith("#")
    ) return;

    let rel: string;
    let kind: FileRef["kind"];
    if (url.startsWith("/")) {
      rel = url.slice(1);
      kind = "absolute";
    } else if (url.startsWith("../") || url.startsWith("./")) {
      const oldRel = path.relative(root, oldDir).replace(/\\/g, "/");
      rel = (oldRel !== "." && oldRel !== "" ? oldRel + "/" : "") + url;
      rel = path.normalize(rel).replace(/\\/g, "/");
      kind = "relative";
    } else {
      const oldRel = path.relative(root, oldDir).replace(/\\/g, "/");
      rel = oldRel !== "." && oldRel !== "" ? oldRel + "/" + url : url;
      kind = "same-folder";
    }

    if (checkExistence) {
      try {
        resolveInRoot(root, rel);
      } catch {
        return;
      }
      try {
        Deno.statSync(path.join(root, rel));
      } catch {
        return;
      }
    }
    out.push({ url, path: rel, kind });
  }

  static #rebaseUrl(
    url: string,
    oldDir: string,
    newDir: string,
    movedFiles: Record<string, string>,
  ): string {
    if (
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("//") ||
      url.startsWith("#")
    ) return url;

    let target: string;
    if (url.startsWith("/")) {
      target = url.slice(1);
    } else if (url.startsWith("../") || url.startsWith("./")) {
      target = path
        .normalize(path.join(oldDir || ".", url))
        .replace(/\\/g, "/");
    } else {
      target = oldDir ? oldDir + "/" + url : url;
    }

    target = movedFiles[target] ?? target;

    if (!newDir) return target ? "/" + target : url;

    const newParts = newDir.split("/");
    const targetParts = target.split("/");
    let i = 0;
    while (
      i < Math.min(targetParts.length, newParts.length) &&
      targetParts[i] === newParts[i]
    ) i++;
    const up = newParts.length - i;
    const rest = targetParts.slice(i).join("/");
    if (up === 0) {
      return rest && !rest.includes("/") ? "./" + rest : rest;
    }
    return "../".repeat(up) + rest;
  }

  #stripExt(filename: string): string {
    const idx = filename.lastIndexOf(MARKDOWN_EXT);
    return idx > 0 ? filename.slice(0, idx) : filename;
  }

  // endregion
}
