// SPDX-License-Identifier: LGPL-3.0-only

/** Tool failures as the agent reads them: what went wrong and how to
 * recover. A tool error is a normal MCP result (`isError: true`), never a
 * protocol error, so the model always sees the message. */

import { HttpError } from "@pathfinder/pathfinder";
import {
  InvalidPathError,
  NoteExistsError,
  NoteNotFoundError,
} from "../notes/models.ts";
import { NoteChangedError } from "../notes/expectation.ts";
import { OperationError } from "../plugins/errors.ts";
import { IndexUnavailableError } from "./vault.ts";

export const READ_ONLY_MESSAGE =
  "This globnotes instance is read-only: notes can be searched and read, " +
  "but not created, changed or deleted.";

/** A failure whose message is already written for the agent. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export const notFound = (path: string) =>
  new ToolError(
    `Note '${path}' not found. Use globnotes_search_notes or ` +
      "globnotes_list_folder to find the right path (paths have no .md " +
      "extension).",
  );

/** How a tool failure reads to the agent. `internal` marks an error the
 * domain doesn't describe (a storage, SQLite or library error): its own
 * message can name absolute server paths and internals, so the agent reads
 * a fixed message and the error itself belongs in the server log, as with
 * the REST API's 500 "Internal Server Error". */
export interface ToolFailure {
  message: string;
  internal: boolean;
}

/** The agent-facing description of any error a tool raised while working
 * on `path` (the note or folder the call named). Only messages written for
 * the agent, or composed from the call's own arguments, are shown. */
export function describeToolError(error: unknown, path?: string): ToolFailure {
  const message = domainMessage(error, path);
  return message === undefined
    ? { message: internalMessage(error, path), internal: true }
    : { message, internal: false };
}

/** The message for an error the domain describes; undefined otherwise. */
function domainMessage(error: unknown, path?: string): string | undefined {
  if (error instanceof ToolError) return error.message;
  if (error instanceof NoteNotFoundError && path !== undefined) {
    return notFound(path).message;
  }
  if (error instanceof NoteExistsError) {
    return `A note already exists at '${path}'. Use globnotes_update_note ` +
      "to change it, or choose another path.";
  }
  if (error instanceof InvalidPathError) {
    return `Invalid path '${path}': ${error.message}.`;
  }
  if (error instanceof NoteChangedError) return noteChanged(error);
  if (error instanceof IndexUnavailableError) {
    return `${error.message} Try again shortly.`;
  }
  if (error instanceof OperationError) {
    const nothing = error.code === "operation_partial"
      ? "Some effects may have been applied; re-read the note."
      : "Nothing was written.";
    if (error.code === "plugin_cancelled") {
      return `The plugin '${error.pluginId}' cancelled this ${
        error.action ?? "operation"
      }: ${error.detail} ${nothing}`;
    }
    return `${error.detail} (${error.code}) ${nothing}`;
  }
  if (error instanceof HttpError) {
    switch (error.status) {
      case 401:
        return "The globnotes token expired or was revoked. Get a new token " +
          "(POST /_/api/token) and reconnect.";
      case 403:
        return READ_ONLY_MESSAGE;
      case 503:
        return "globnotes is not ready: finish first-run setup in the web " +
          "app, then retry.";
    }
    return `globnotes rejected the request (HTTP ${error.status}).`;
  }
  return undefined;
}

/** The stale-write guard's refusal: what was expected, what the note is
 * now, and how to recover. Composed only from the call's own arguments and
 * the note's public read fields. */
function noteChanged(error: NoteChangedError): string {
  const parts: string[] = [], fields: string[] = [];
  if (error.mismatched.includes("lastModifiedMs")) {
    parts.push(
      `expected last_modified ${
        new Date(error.expected.lastModifiedMs!).toISOString()
      }, now ${new Date(error.current.lastModifiedMs).toISOString()}`,
    );
    fields.push("last_modified");
  }
  if (error.mismatched.includes("hash")) {
    parts.push(
      `expected hash ${error.expected.hash}, now ${error.current.hash}`,
    );
    fields.push("hash");
  }
  return `Note '${error.path}' changed since you read it (${
    parts.join("; ")
  }). Nothing was written. Call globnotes_get_note to re-read it, then ` +
    `retry with the new ${fields.join(" and ")}.`;
}

/** A fixed message for an error the domain lets through: the error's own
 * text never reaches the agent. */
function internalMessage(error: unknown, path?: string): string {
  const named = path === undefined ? "this" : `'${path}'`;
  if (error instanceof Deno.errors.IsADirectory) {
    return `globnotes can't read ${named} as a note: a folder is in its ` +
      "place on the server's disk. Use globnotes_list_folder to look inside.";
  }
  if (error instanceof Deno.errors.PermissionDenied) {
    return `globnotes has no permission to access ${named} on the server's ` +
      "disk, so nothing was read or changed. The server's administrator can " +
      "fix the file permissions.";
  }
  return `globnotes hit an unexpected server error${
    path === undefined ? "" : ` working on '${path}'`
  }. The details are in the server log. Check the path, or try again.`;
}
