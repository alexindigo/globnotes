// SPDX-License-Identifier: LGPL-3.0-only

import { operationError } from "./operationErrors.js";

export function noteOperationError(error) {
  const result = operationError(error);
  return result ? { title: result.title, message: result.message } : null;
}

function entityTooLargeError(entity) {
  return {
    title: "Failure",
    message: `This ${entity} is too large. Please try again with a smaller ${entity} or adjust your server configuration.`,
  };
}

export function noteSaveError(error, failure) {
  if (error?.code === "rename_rebase_conflict") return { title: "Review renamed text", message: error.message };
  if (failure?.certainty === "unknown" || failure?.certainty === "known-committed") {
    return {
      title: "Save paused",
      message: failure.certainty === "unknown"
        ? "The write outcome is unknown. Current edits and queued saves are retained; no retry or handoff was performed."
        : "The write committed, but its UI update failed. Retained work is paused; do not resend this submission.",
    };
  }
  const guarded = noteOperationError(error);
  if (guarded) return guarded;
  if (error.response?.status === 400) {
    return { title: "Invalid", message: error.response.data?.detail || "Invalid note title." };
  }
  if (error.response?.status === 409) {
    return { title: "Duplicate", message: "A note with this title already exists. Please try again with a new title." };
  }
  if (error.response?.status === 413) return entityTooLargeError("note");
  return null;
}

export function noteAttachmentError(error) {
  const guarded = noteOperationError(error);
  if (guarded) return guarded;
  if (error.response?.status === 409) {
    return { title: "Duplicate", message: "An attachment with this filename already exists." };
  }
  // Retain the upload path's existing status coercion.
  if (error.response?.status == 413) return entityTooLargeError("attachment");
  return null;
}
