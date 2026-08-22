// SPDX-License-Identifier: LGPL-3.0-only

/**
 * File serving, ported from the Python server's files/file_serving.py.
 *
 * Serves and accepts files from anywhere in the notes tree (no special
 * attachments directory). Serving policy mirrors the Python server:
 * TEXT_EXTENSIONS → text/plain, SVG → media type + CSP, everything else
 * that is not browser-renderable → forced download, so script-capable
 * files (e.g. .html) can never execute within the application's origin.
 */

import * as path from "@std/path";
import { isValidNotePath, resolveInRoot } from "../helpers.ts";
import { logger } from "../logger.ts";
import { guessType } from "./mimetypes.ts";

const MARKDOWN_EXT = ".md";

// Extensions served inline (browser-renderable). Everything else is served
// as a forced download, so script-capable files (e.g. .html) can never
// execute within the application's origin.
const INLINE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".css",
  ".flac",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".json",
  ".m4a",
  ".mov",
  ".mp3",
  ".mp4",
  ".oga",
  ".ogg",
  ".pdf",
  ".png",
  ".svg",
  ".webm",
  ".webp",
  ".xml",
]);

// Extensions served as plain text (including markdown, so raw notes can be
// fetched directly - useful for agents).
const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".log",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
]);

const SVG_EXT = ".svg";

/** A served file: body plus response metadata. */
export interface ServedFile {
  body: Uint8Array;
  mediaType: string;
  /** Set when the response is a forced download. */
  downloadName: string | null;
  headers: Record<string, string>;
}

export interface FileCreateResponse {
  filename: string;
  url: string;
}

export class NotADirectoryError extends Error {}
export class FileNotFoundError extends Error {}
export class ValueError extends Error {}

/** Python `urllib.parse.quote(value)` (safe="/"): percent-encode every
 * byte outside the RFC 3986 unreserved set. */
function pyQuote(value: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(value)) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9_.~-]/.test(c)
      ? c
      : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export class FileServing {
  readonly storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    try {
      if (!Deno.statSync(this.storagePath).isDirectory) {
        throw new Error("not a directory");
      }
    } catch {
      throw new NotADirectoryError(
        `'${this.storagePath}' is not a valid directory.`,
      );
    }
  }

  get(relPath: string): ServedFile {
    // Hidden files and directories are none of the app's business.
    if (relPath.split("/").some((s) => s.startsWith("."))) {
      throw new FileNotFoundError(`'${relPath}' not found.`);
    }
    let filepath: string;
    try {
      filepath = resolveInRoot(this.storagePath, relPath);
    } catch {
      throw new ValueError(`'${relPath}' resolves outside the root directory`);
    }
    try {
      if (!Deno.statSync(filepath).isFile) {
        throw new Error("not a file");
      }
    } catch {
      throw new FileNotFoundError(`'${relPath}' not found.`);
    }
    const ext = path.extname(filepath).toLowerCase();
    const headers: Record<string, string> = {};
    let downloadName: string | null = null;
    let mediaType: string;
    if (TEXT_EXTENSIONS.has(ext)) {
      mediaType = "text/plain; charset=utf-8";
    } else if (ext === SVG_EXT) {
      // SVG can carry script; neutralise it even when the file is
      // opened as a top-level document.
      mediaType = "image/svg+xml";
      headers["Content-Security-Policy"] = "script-src 'none'";
    } else {
      mediaType = guessType(filepath) ?? "application/octet-stream";
      // Starlette appends charset to text/* types.
      if (mediaType.startsWith("text/")) mediaType += "; charset=utf-8";
    }
    if (!INLINE_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) {
      // Forced download.
      downloadName = path.basename(filepath);
    }
    return {
      body: Deno.readFileSync(filepath),
      mediaType,
      downloadName,
      headers,
    };
  }

  create(
    directory: string,
    rawFilename: string,
    body: Uint8Array,
  ): FileCreateResponse {
    let targetDir: string;
    try {
      targetDir = directory
        ? resolveInRoot(this.storagePath, directory)
        : Deno.realPathSync(this.storagePath);
    } catch {
      throw new ValueError(`Invalid directory '${directory}'.`);
    }
    const filename = FileServing.validatedFilename(rawFilename);
    Deno.mkdirSync(targetDir, { recursive: true });
    let filepath = path.join(targetDir, filename);
    try {
      if (Deno.statSync(filepath).isFile) {
        filepath = path.join(
          targetDir,
          FileServing.datetimeSuffixFilename(filename),
        );
      }
    } catch {
      // Path doesn't exist yet — fine.
    }
    logger.info(`Uploading to '${filepath}'`);
    Deno.writeFileSync(filepath, body, { createNew: true });
    const base = path.basename(filepath);
    return { filename: base, url: pyQuote(base) };
  }

  static validatedFilename(filename: string): string {
    const base = path.basename(filename ?? "");
    if (!base || base.startsWith(".")) {
      throw new ValueError(`Invalid filename '${base}'.`);
    }
    const ext = path.extname(base).toLowerCase();
    if (ext === MARKDOWN_EXT) {
      // Uploaded markdown becomes a note, so its stem must be a valid
      // note title - otherwise the note could never be opened.
      try {
        isValidNotePath(base.slice(0, -MARKDOWN_EXT.length));
      } catch (e) {
        throw new ValueError((e as Error).message);
      }
    }
    return base;
  }

  /** Python: `datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")`. */
  static datetimeSuffixFilename(filename: string): string {
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const ext = path.extname(filename);
    const name = filename.slice(0, filename.length - ext.length);
    return `${name}_${stamp}Z${ext}`;
  }
}
