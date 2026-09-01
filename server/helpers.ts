// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Shared helpers: env parsing, note-path validation, path containment,
 * and PBKDF2 password hashing (WebCrypto — bit-compatible with the
 * Python server's `pbkdf2_sha256$iters$salt_hex$digest_hex` hashes).
 */

import * as path from "@std/path";
import { logger } from "./logger.ts";

export function camelCase(snakeCaseStr: string): string {
  /** Return the given snake_case string in camelCase. */
  const parts = snakeCaseStr.split("_").filter((p) => p !== "");
  return parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
}

const FILENAME_INVALID_CHARS = '<>:"/\\|?*';

export function isValidFilename(value: string): string {
  /** Throw if the string contains any of: <>:"/\|?*  */
  for (const c of FILENAME_INVALID_CHARS) {
    if (value.includes(c)) {
      throw new Error(
        `path cannot include any of the following characters: ${FILENAME_INVALID_CHARS}`,
      );
    }
  }
  return value;
}

const NOTE_PATH_INVALID_CHARS = '<>:"\\|?*';
const NOTE_PATH_MAX_SEGMENT_BYTES = 255;

export function isValidNotePath(value: string): string {
  /** Throw unless value is a valid note path: POSIX-style relative path,
   * non-empty segments, no '.'/'..' segments, no leading-dot segments, none of
   * <>:"\|?* and no segment over 255 bytes. */
  if (!value) throw new Error("path cannot be empty");
  if (value.split("/")[0] === "_") {
    throw new Error("path cannot start with '_/' (reserved for app URLs)");
  }
  for (const segment of value.split("/")) {
    if (!segment) throw new Error("path cannot contain empty path segments");
    if (segment === "." || segment === "..") {
      throw new Error("path cannot contain '.' or '..' path segments");
    }
    if (segment.startsWith(".")) {
      throw new Error("path path segments cannot start with '.'");
    }
    for (const c of NOTE_PATH_INVALID_CHARS) {
      if (segment.includes(c)) {
        throw new Error(
          `path cannot include any of the following characters: ${NOTE_PATH_INVALID_CHARS}`,
        );
      }
    }
    if (
      new TextEncoder().encode(segment).length > NOTE_PATH_MAX_SEGMENT_BYTES
    ) {
      throw new Error("path path segments cannot exceed 255 bytes");
    }
  }
  return value;
}

/** Read-path validation: the filesystem is the source of truth. Real
 * vaults contain filenames the create-time validator rejects (`?`, `:`,
 * `*` …) — Obsidian opens them fine, and reads by filename must too.
 * Only structural safety is enforced here: no empty/`. `/`..` segments,
 * no leading-dot segments, no `_`-root (app URL space). */
export function isReadableNotePath(value: string): string {
  if (!value) throw new Error("path cannot be empty");
  if (value.split("/")[0] === "_") {
    throw new Error("path cannot start with '_/' (reserved for app URLs)");
  }
  for (const segment of value.split("/")) {
    if (!segment) throw new Error("path cannot contain empty path segments");
    if (segment === "." || segment === "..") {
      throw new Error("path cannot contain '.' or '..' path segments");
    }
    if (segment.startsWith(".")) {
      throw new Error("path path segments cannot start with '.'");
    }
  }
  return value;
}

/** resolveInRoot for reads: isReadableNotePath instead of the stricter
 * create-time isValidNotePath; containment check identical. */
export function resolveReadableInRoot(root: string, relPath: string): string {
  isReadableNotePath(relPath);
  const rootReal = realpathSync(root);
  const resolved = realpathSync(path.join(rootReal, relPath));
  if (!isSubpath(rootReal, resolved)) {
    throw new Error(`'${relPath}' resolves outside the root directory`);
  }
  return resolved;
}

export function resolveInRoot(root: string, relPath: string): string {
  /** Resolve relPath inside root and verify containment.
   * Returns the absolute, symlink-resolved path. Throws if relPath is not a
   * valid note path or if the resolved path escapes root ('..' or symlinks). */
  isValidNotePath(relPath);
  const rootReal = realpathSync(root);
  const resolved = realpathSync(path.join(rootReal, relPath));
  if (!isSubpath(rootReal, resolved)) {
    throw new Error(`'${relPath}' resolves outside the root directory`);
  }
  return resolved;
}

/** realpath that tolerates the final path not existing yet (new files):
 * resolves the deepest existing ancestor and appends the remainder. */
function realpathSync(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p; // filesystem root, give up
    return path.join(realpathSync(parent), path.basename(p));
  }
}

function isSubpath(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// region Password hashing

const PBKDF2_ITERATIONS = 100_000;
const HEX = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
const FROM_HEX = (hex: string) =>
  new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));

async function pbkdf2Sha256(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations,
    },
    key,
    256,
  );
}

/** Hash a password for stored (file-backed) credentials. */
export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await pbkdf2Sha256(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${HEX(salt)}$${HEX(digest)}`;
}

/** Timing-safe string equality for equal-length strings (compare_digest
 * equivalent). Length inequality leaks via early false — same trade-off
 * as Python's hmac.compare_digest. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a password against a hash produced by hashPassword (or by the
 * Python server's helpers.hash_password — same format, same algorithm). */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const [scheme, iterationsStr, saltHex, digestHex] = stored.split("$");
    if (scheme !== "pbkdf2_sha256") return false;
    const iterations = parseInt(iterationsStr, 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;
    if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(digestHex)) {
      return false;
    }
    const digest = await pbkdf2Sha256(password, FROM_HEX(saltHex), iterations);
    return timingSafeEqual(HEX(digest), digestHex);
  } catch {
    return false;
  }
}

// endregion

/** Publish the path prefix to the client (meta tag) and point the built
 * asset references at it when one is configured. With a brand name set,
 * the <title> is swapped too so first paint is already branded (the
 * client re-titles per-route afterwards). Ported from the Python
 * server's rewrite_index_html. */
export function rewriteIndexHtml(
  htmlFile: string,
  pathPrefix: string,
  brandName?: string | null,
): void {
  let html = Deno.readTextFileSync(htmlFile);
  if (pathPrefix) {
    html = html.replaceAll('"/_/', `"${pathPrefix}/_/`);
  }
  if (brandName) {
    const escaped = brandName.replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${escaped}</title>`);
  }
  if (html.includes('name="globnotes-prefix"')) {
    html = html.replace(
      /(<meta name="globnotes-prefix" content=")[^"]*/,
      `$1${pathPrefix}`,
    );
  } else {
    const meta = `<meta name="globnotes-prefix" content="${pathPrefix}">`;
    html = html.replace("<head>", "<head>\n    " + meta);
  }
  Deno.writeTextFileSync(htmlFile, html);
}

export interface GetEnvOptions {
  mandatory?: boolean;
  default?: string | number | boolean;
  castInt?: boolean;
  castBool?: boolean;
}

/** Get an environment variable. Exits the process when mandatory and unset,
 * matching the Python server's get_env contract. */
export function getEnv(key: string, opts: GetEnvOptions = {}): string {
  const raw = Deno.env.get(key);
  if (raw === undefined || raw === "") {
    if (opts.mandatory) {
      logger.error(`Environment variable ${key} must be set.`);
      Deno.exit(1);
    }
    if (opts.default !== undefined) return String(opts.default);
    return "";
  }
  if (opts.castInt) {
    const value = parseInt(raw, 10);
    if (!Number.isFinite(value)) {
      logger.error(`Invalid value '${raw}' for ${key}.`);
      Deno.exit(1);
    }
    return String(value);
  }
  if (opts.castBool) {
    const lowered = raw.toLowerCase();
    if (lowered === "true") return "true";
    if (lowered === "false") return "false";
    logger.error(`Invalid value '${raw}' for ${key}.`);
    Deno.exit(1);
  }
  return raw;
}
