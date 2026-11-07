// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { createHash } from "node:crypto";
import { guessType } from "../files/mimetypes.ts";
import { readableVaultPath } from "./browser_changes.ts";
import type { VaultHub } from "./hub.ts";
import type { Conflict } from "./types.ts";

export interface ConflictContext {
  hub: VaultHub;
  stateRoot: string;
}
export interface ConflictVersion {
  path: string;
  version: string;
  size: number;
  mediaType: string;
  content?: string;
  preview: "text" | "binary" | "too_large" | "invalid_utf8";
}
export type ConflictDetail =
  | {
    id: string;
    revision: number;
    state: "resolved";
    resolvedAt: string | null;
  }
  | {
    id: string;
    revision: number;
    state: "open";
    original: ConflictVersion;
    copy: ConflictVersion;
  };

export function readableConflict(
  context: ConflictContext,
  record: Conflict,
): boolean {
  return !!readableVaultPath(
    context.hub.root,
    context.stateRoot,
    record.path,
  ) &&
    !!readableVaultPath(context.hub.root, context.stateRoot, record.copyPath);
}
export function listConflicts(context: ConflictContext) {
  const conflicts = context.hub.conflicts().filter((record) =>
    record.state === "open" && readableConflict(context, record)
  )
    .map(({ id, revision, path, copyPath, peer, reason, createdAt }) => ({
      id,
      revision,
      path: path!,
      copyPath: copyPath!,
      peer,
      reason,
      createdAt,
    }));
  return {
    revision: context.hub.conflictRevision(),
    total: conflicts.length,
    conflicts,
  };
}
export function findConflict(context: ConflictContext, id: string): Conflict {
  const record = context.hub.conflict(id);
  if (
    !record || (record.state === "open" && !readableConflict(context, record))
  ) {
    throw new HttpError(404, "Conflict not found.");
  }
  return record;
}

const INLINE_BYTES = 16 * 1024 * 1024;
/** One file handle supplies both the raw-byte hash and optional complete text.
 * Stream large/binary members without retaining their content. Preserve BOM. */
function readVersion(context: ConflictContext, name: string): ConflictVersion {
  const filename = readableVaultPath(context.hub.root, context.stateRoot, name);
  if (!filename) throw new HttpError(404, "Conflict not found.");
  const handle = Deno.openSync(filename, { read: true });
  try {
    const info = handle.statSync();
    if (!info.isFile) throw new HttpError(404, "Conflict not found.");
    const markdown = name.endsWith(".md");
    const bytes = markdown && info.size <= INLINE_BYTES
      ? new Uint8Array(info.size)
      : null;
    const hash = createHash("sha256"), buffer = new Uint8Array(64 * 1024);
    let size = 0, length;
    while ((length = handle.readSync(buffer)) !== null) {
      hash.update(buffer.subarray(0, length));
      if (bytes && size + length <= bytes.length) {
        bytes.set(buffer.subarray(0, length), size);
      }
      size += length;
    }
    const after = handle.statSync();
    if (
      size !== info.size || info.size !== after.size ||
      info.mtime?.getTime() !== after.mtime?.getTime()
    ) {
      throw new Error("File changed during conflict comparison");
    }
    const result: ConflictVersion = {
      path: name,
      version: hash.digest("hex"),
      size,
      mediaType: markdown
        ? "text/markdown"
        : guessType(name) ?? "application/octet-stream",
      preview: !markdown ? "binary" : !bytes ? "too_large" : "text",
    };
    if (bytes) {
      try {
        result.content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        result.preview = "invalid_utf8";
      }
    }
    return result;
  } finally {
    handle.close();
  }
}
export function readConflict(
  context: ConflictContext,
  id: string,
): ConflictDetail {
  let record = findConflict(context, id);
  if (record.state === "open") {
    try {
      const original = readVersion(context, record.path!),
        copy = readVersion(context, record.copyPath!);
      return { id, revision: record.revision, state: "open", original, copy };
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      // Only a confirmed missing member is reconciled; I/O is never absence.
      context.hub.scanNow([record.path!, record.copyPath!]);
      record = findConflict(context, id);
      if (record.state === "open") throw error;
    }
  }
  return {
    id,
    revision: record.revision,
    state: "resolved",
    resolvedAt: record.resolvedAt,
  };
}
