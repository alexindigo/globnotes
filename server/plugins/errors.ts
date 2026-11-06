// SPDX-License-Identifier: LGPL-3.0-only

/** Structured operation failures. Pathfinder's HttpError serializes {detail}
 * only, so guarded outcomes cross as a real JSON Response instead. */

export type OperationErrorCode =
  | "plugin_cancelled"
  | "plugin_guard_failed"
  | "operation_conflict"
  | "operation_partial"
  | "plugin_generation_revoked"
  | "plugin_permission_denied"
  | "base_required"
  | "base_stale";
// Host-only requester failures precede all filesystem effects.

export class OperationError extends Error {
  readonly status: number;
  readonly code: OperationErrorCode;
  readonly detail: string;
  readonly pluginId?: string;
  readonly action?: string;
  readonly operationId?: string;
  /** Safe partial-effect metadata for operation_partial outcomes. */
  readonly partial?: {
    completedPaths: string[];
    failedPath?: string;
  };
  /** base_stale: the version on disk now (null when the file is gone). */
  readonly currentVersion?: string | null;

  constructor(
    status: number,
    code: OperationErrorCode,
    detail: string,
    correlation: {
      pluginId?: string;
      action?: string;
      operationId?: string;
      partial?: { completedPaths: string[]; failedPath?: string };
      currentVersion?: string | null;
    } = {},
  ) {
    super(detail);
    this.name = "OperationError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.pluginId = correlation.pluginId;
    this.action = correlation.action;
    this.operationId = correlation.operationId;
    this.partial = correlation.partial;
    this.currentVersion = correlation.currentVersion;
  }
}

/** Real Response carrying detail + code + safe correlation fields. Endpoints
 * return this before their legacy error mappings; the rewrite-refs catch-all
 * must not convert a guard outcome into a bare 500. */
/** A write that replaces, deletes or moves bytes stated no base. */
export function baseRequired(operationId?: string): OperationError {
  return new OperationError(
    428,
    "base_required",
    "This write must state its base: the version (or, for a note, the text) it read. Nothing was written.",
    { operationId },
  );
}
/** The writer's base no longer matches the file; nothing was written. */
export function baseStale(
  path: string,
  currentVersion: string | null,
  operationId?: string,
): OperationError {
  return new OperationError(
    409,
    "base_stale",
    `'${path}' changed since it was read; nothing was written. Read it again and retry from its current version.`,
    { operationId, currentVersion },
  );
}

export function toOperationResponse(error: OperationError): Response {
  const body: Record<string, unknown> = {
    detail: error.detail,
    code: error.code,
  };
  if (error.pluginId !== undefined) body.pluginId = error.pluginId;
  if (error.action !== undefined) body.action = error.action;
  if (error.operationId !== undefined) body.operationId = error.operationId;
  if (error.partial !== undefined) body.partial = error.partial;
  if (error.currentVersion !== undefined) {
    body.currentVersion = error.currentVersion;
  }
  return Response.json(body, { status: error.status });
}
