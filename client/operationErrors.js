// SPDX-License-Identifier: LGPL-3.0-only

/** Structured guarded-operation failures (server/plugins/errors.ts). These
 * codes must precede status-only branches: a guard's 409 is not a duplicate. */
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
    case "base_stale":
      return {
        code: data.code,
        title: "Changed elsewhere",
        message: "This note changed since you opened it; nothing was changed. It now shows the current version.",
      };
    case "base_required":
      return {
        code: data.code,
        title: "Not applied",
        message: data.detail || "This change did not say which version it was based on; nothing was changed.",
      };
    default:
      return null;
  }
}
