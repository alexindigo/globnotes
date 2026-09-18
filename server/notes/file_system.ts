// SPDX-License-Identifier: LGPL-3.0-only

/**
 * File-system notes storage, ported line-for-line from the Python
 * FileSystemNotes (server/notes/file_system/file_system.py).
 * Index hooks (reindex / delete-from-index / sync) are forwarded
 * through the optional injected indexer.
 */

import type { FileRef, Note, NoteCreate, NoteUpdate } from "./models.ts";
import {
  InvalidPathError,
  NoteExistsError,
  NoteNotFoundError,
} from "./models.ts";
import {
  isReadableNotePath,
  isValidNotePath,
  resolveInRoot,
  resolveReadableInRoot,
} from "@server/helpers.ts";
import {
  resolveTitleInfo,
  rewriteFirstH1,
  sanitizeBasename,
} from "@server/search/titles.ts";
import type { Indexer } from "@server/state.ts";
import { logger } from "@server/logger.ts";
import { walk } from "@std/fs/walk";
import * as nodePath from "@std/path";

const MARKDOWN_EXT = ".md";

// Regex patterns ported from file_system.py.
const LOCAL_REF_MD = /(!?\[[^\]]*\])\(\s*([^)\s]+)\s*\)/g;
const LOCAL_REF_HTML = /src="([^"]+)"/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class FileSystemNotes {
  readonly storagePath: string;
  #indexer: Indexer | null;
  #excludePrefixes: string[];
  #scanCache: { ts: number; names: string[] } | null = null;
  #scanCacheTtl: number;

  constructor(
    storagePath: string,
    indexer: Indexer | null = null,
    excludePrefixes: string[] = [],
  ) {
    this.storagePath = storagePath;
    this.#indexer = indexer;
    this.#excludePrefixes = excludePrefixes;
    this.#scanCacheTtl = Number(
      Deno.env.get("GLOBNOTES_SCAN_CACHE_TTL") ?? "15",
    );
  }

  setIndexer(indexer: Indexer | null): void {
    this.#indexer = indexer;
  }

  #isExcluded(rel: string): boolean {
    const n = rel.replaceAll("\\", "/");
    return this.#excludePrefixes.some((p) => n === p || n.startsWith(p + "/"));
  }

  // region public API

  create(data: NoteCreate): Note {
    const path = (data.path ?? "").trim();
    if (!path) throw new InvalidPathError("path cannot be empty");
    this.#validateNotePath(path);
    const filepath = this.#pathFromPath(path);
    try {
      Deno.mkdirSync(nodePath.dirname(filepath), { recursive: true });
      this.#writeFile(filepath, data.content ?? "", false);
    } catch (e) {
      if (
        e instanceof Deno.errors.AlreadyExists ||
        e instanceof Deno.errors.NotADirectory ||
        e instanceof Deno.errors.IsADirectory
      ) {
        throw new NoteExistsError(
          `Failed to create '${path}': ${(e as Error).message}`,
        );
      }
      throw e;
    }
    this.#indexer?.reindexNote(path);
    this.#invalidateScanCache();
    return this.#noteFromFile(path, filepath);
  }

  get(path: string): Note {
    this.#validateReadablePath(path);
    const filepath = this.#readablePath(path);
    try {
      return this.#noteFromFile(path, filepath);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new NoteNotFoundError(
          "The specified note cannot be found.",
        );
      }
      throw e;
    }
  }

  update(path: string, data: NoteUpdate, fileRefs = "none"): Note {
    this.#validateReadablePath(path);
    const oldPath = path;
    let filepath = this.#readablePath(path);
    const oldDir = nodePath.dirname(filepath);
    const movedFiles: Record<string, string> = {};
    let contentWritten: string | null = null;

    // H1 → basename sync: a content-only edit whose first H1 changed
    // renames the file's basename (folder untouched, front-matter title
    // opts out). Default-on, Obsidian Filename-Heading-Sync style.
    if (
      (data.newPath === undefined || data.newPath === null) &&
      data.newContent !== undefined && data.newContent !== null
    ) {
      const oldBase = nodePath.basename(path);
      const oldH1 = resolveTitleInfo(oldBase, this.#readFile(filepath)).h1;
      const info = resolveTitleInfo(oldBase, data.newContent);
      if (!info.fmTitle && info.h1 && info.h1 !== oldH1) {
        const newBase = sanitizeBasename(info.h1);
        if (newBase && newBase !== oldBase) {
          const folder = nodePath.dirname(path);
          data.newPath = folder === "." ? newBase : `${folder}/${newBase}`;
        }
      }
    }

    if (
      data.newPath !== undefined &&
      data.newPath !== null &&
      data.newPath !== path
    ) {
      const newPath = data.newPath.trim();
      if (!newPath) throw new InvalidPathError("path cannot be empty");
      this.#validateNotePath(newPath);
      const newFilepath = this.#pathFromPath(newPath);
      const newDir = nodePath.dirname(newFilepath);

      if (filepath !== newFilepath) {
        try {
          Deno.statSync(newFilepath);
          throw new NoteExistsError(
            `Failed to rename. '${newPath}' already exists.`,
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
          let oldRelDir = nodePath.relative(root, oldDir).replace(/\\/g, "/");
          let newRelDir = nodePath.relative(root, newDir).replace(/\\/g, "/");
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
              const oldFile = nodePath.join(root, r.path);
              const newFile = nodePath.join(root, newRel);
              try {
                Deno.mkdirSync(nodePath.dirname(newFile), { recursive: true });
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
            `Failed to rename to '${newPath}': ${(e as Error).message}`,
          );
        }
        throw e;
      }
      this.#pruneEmptyParents(oldDir);
      if (actionRefs && contentWritten !== null) {
        this.#writeFile(newFilepath, contentWritten, true);
      }
      path = newPath;
      filepath = newFilepath;
    }

    let content: string;
    if (data.newContent !== undefined && data.newContent !== null) {
      this.#writeFile(filepath, data.newContent, true);
      content = data.newContent;
    } else {
      content = this.#readFile(filepath);
    }

    // Rename → H1 sync: after a rename, keep the first H1 in step with
    // the new basename (front-matter title opts out).
    if (oldPath !== path) {
      const newBase = nodePath.basename(path);
      const info = resolveTitleInfo(nodePath.basename(oldPath), content);
      if (!info.fmTitle && info.h1 && info.h1 !== newBase) {
        content = rewriteFirstH1(content, newBase);
        this.#writeFile(filepath, content, true);
      }
    }

    const moved = Object.entries(movedFiles).map(([o, n]) => ({
      oldPath: o,
      newPath: n,
    }));
    if (oldPath !== path) this.#indexer?.deleteFromIndex(oldPath);
    this.#indexer?.reindexNote(path);
    this.#invalidateScanCache();
    return {
      ...this.#noteFromFile(path, filepath),
      content,
      movedFiles: moved,
    };
  }

  previewRename(path: string, newPath: string): FileRef[] {
    this.#validateReadablePath(path);
    this.#validateNotePath(newPath);
    const filepath = this.#readablePath(path);
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
    return this.#scanLocalRefs(content, nodePath.dirname(filepath));
  }

  async rewriteRefs(oldPath: string, newPath: string): Promise<void> {
    const root = this.storagePath;
    const fname = oldPath.split("/").pop()!;
    for await (
      const entry of walk(root, { includeDirs: false, exts: [".md"] })
    ) {
      let content = this.#readFile(entry.path);
      if (!content.includes(fname)) continue;
      const noteDir = nodePath.dirname(entry.path);
      const refs = this.#scanLocalRefs(content, noteDir, false);
      let changed = false;
      const noteRel = nodePath.relative(root, noteDir).replace(/\\/g, "/");
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

  delete(path: string): void {
    this.#validateReadablePath(path);
    const filepath = this.#readablePath(path);
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
    this.#pruneEmptyParents(nodePath.dirname(filepath));
    this.#indexer?.deleteFromIndex(path);
    this.#invalidateScanCache();
  }

  listLevel(dirPath = ""): {
    folders: { name: string; path: string }[];
    notes: string[];
  } {
    if (dirPath) this.#validateReadablePath(dirPath);
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
        if (this.#isExcluded(childPath)) continue;
        folders.push({ name: entry.name, path: childPath });
      } else if (entry.name.endsWith(MARKDOWN_EXT)) {
        const path = entry.name.slice(0, -MARKDOWN_EXT.length);
        notes.push(dirPath ? `${dirPath}/${path}` : path);
      }
    }
    return {
      folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
      notes: notes.sort(),
    };
  }

  getPaths(): string[] {
    return this.listAllNoteFilenames().map((f) => this.#stripExt(f));
  }

  // endregion

  // region private helpers

  #pathFromPath(path: string): string {
    try {
      return resolveInRoot(this.storagePath, path + MARKDOWN_EXT);
    } catch (e) {
      throw new InvalidPathError((e as Error).message);
    }
  }

  /** isValidNotePath at the storage boundary: helpers throw plain Error,
   * endpoints map InvalidPathError → 400 (Python: ValueError). */
  #validateNotePath(value: string): string {
    try {
      return isValidNotePath(value);
    } catch (e) {
      throw new InvalidPathError((e as Error).message);
    }
  }

  /** Read-path: isReadableNotePath — the disk is the source of truth. */
  #validateReadablePath(value: string): string {
    try {
      return isReadableNotePath(value);
    } catch (e) {
      throw new InvalidPathError((e as Error).message);
    }
  }

  #readablePath(path: string): string {
    try {
      return resolveReadableInRoot(this.storagePath, path + MARKDOWN_EXT);
    } catch (e) {
      throw new InvalidPathError((e as Error).message);
    }
  }

  #noteFromFile(path: string, filepath: string): Note {
    const content = this.#readFile(filepath);
    return {
      path,
      content,
      title: resolveTitleInfo(
        nodePath.basename(path),
        content ?? "",
      ).title,
      lastModified: (Deno.statSync(filepath).mtime?.getTime() ?? 0) / 1000,
      movedFiles: [],
    };
  }

  #pruneEmptyParents(dirPath: string): void {
    const root = Deno.realPathSync(this.storagePath);
    let d = Deno.realPathSync(dirPath);
    while (d !== root && nodePath.common([root, d]) === root) {
      try {
        Deno.removeSync(d);
      } catch {
        break;
      }
      d = nodePath.dirname(d);
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

  /** All note filenames relative to the storage root, including hidden
   * dirs (Python `_list_all_note_filenames`; public so the indexer can
   * use it). TTL-cached; invalidated on writes. */
  listAllNoteFilenames(): string[] {
    const ttl = this.#scanCacheTtl;
    const now = performance.now() / 1000;
    if (this.#scanCache !== null && now - this.#scanCache.ts < ttl) {
      return this.#scanCache.names;
    }
    const names: string[] = [];
    const root = this.storagePath;
    const prefix = root.endsWith(nodePath.SEPARATOR) ? root : root + nodePath.SEPARATOR;

    const isExcluded = (rel: string) => this.#isExcluded(rel);
    const walkDir = (dir: string): void => {
      for (const entry of Deno.readDirSync(dir)) {
        const full = nodePath.join(dir, entry.name);
        const rel = full.slice(prefix.length).replaceAll("\\", "/");
        if (entry.isDirectory) {
          if (isExcluded(rel)) continue;
          walkDir(full);
        } else if (entry.name.endsWith(MARKDOWN_EXT)) {
          if (isExcluded(rel)) continue;
          names.push(full.slice(prefix.length));
        }
      }
    };
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
      const oldRel = nodePath.relative(root, oldDir).replace(/\\/g, "/");
      rel = (oldRel !== "." && oldRel !== "" ? oldRel + "/" : "") + url;
      rel = nodePath.normalize(rel).replace(/\\/g, "/");
      kind = "relative";
    } else {
      const oldRel = nodePath.relative(root, oldDir).replace(/\\/g, "/");
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
        Deno.statSync(nodePath.join(root, rel));
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
      target = nodePath
        .normalize(nodePath.join(oldDir || ".", url))
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
