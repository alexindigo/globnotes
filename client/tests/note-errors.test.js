import { describe, expect, it } from "vitest";
import { noteAttachmentError, noteOperationError, noteSaveError } from "../noteErrors.js";
import { operationError } from "../operationErrors.js";

const response = (status, data) => ({ response: { status, data } });
const tooLarge = entity => ({ title: "Failure", message: `This ${entity} is too large. Please try again with a smaller ${entity} or adjust your server configuration.` });

describe("note operation errors", () => {
  it.each([
    ["plugin_cancelled", "Blocked by plugin", "A plugin cancelled this operation. (plugin: guard)"],
    ["plugin_guard_failed", "Plugin guard failed", "A required plugin guard failed or is unavailable. (plugin: guard)"],
    ["operation_conflict", "Conflict", "The vault changed while this operation was pending; it was not applied."],
    ["operation_partial", "Partial failure", "Some changes could not be completed. Do not retry blindly."],
  ])("maps %s identically for delete, save and upload before status branches", (code, title, message) => {
    const error = response(409, { code, pluginId: "guard" });
    const expected = { title, message };
    expect(operationError(error)).toEqual({ code, ...expected });
    expect(noteOperationError(error)).toEqual(expected);
    expect(noteSaveError(error)).toEqual(expected);
    expect(noteAttachmentError(error)).toEqual(expected);
  });

  it.each(["plugin_cancelled", "plugin_guard_failed", "operation_conflict", "operation_partial"])("retains supplied %s detail", code => {
    const error = response(413, { code, detail: "Specific reason" });
    expect(noteOperationError(error).message).toBe("Specific reason");
    expect(noteSaveError(error)).toEqual(noteOperationError(error));
    expect(noteAttachmentError(error)).toEqual(noteOperationError(error));
  });

  it.each([undefined, new Error("offline"), response(500), response(409, "text"), response(409, { code: 42 }), response(409, { code: "note_exists" })])("ignores unstructured or unknown guarded error %#", error => {
    expect(operationError(error)).toBeNull();
    expect(noteOperationError(error)).toBeNull();
  });
});

describe("save error policy", () => {
  it.each([
    ["unknown", "The write outcome is unknown. Current edits and queued saves are retained; no retry or handoff was performed."],
    ["known-committed", "The write committed, but its UI update failed. Retained work is paused; do not resend this submission."],
  ])("prioritizes %s queue certainty over response codes and status", (certainty, message) => {
    expect(noteSaveError(response(409, { code: "plugin_cancelled" }), { certainty })).toEqual({ title: "Save paused", message });
  });

  it("keeps known rejections eligible for guarded classification", () => {
    const error = response(409, { code: "operation_conflict" });
    expect(noteSaveError(error, { certainty: "known-not-committed" })).toEqual(noteOperationError(error));
  });

  it.each([undefined, "", "Bad path"])("retains 400 detail/fallback for %j", detail => {
    expect(noteSaveError(response(400, { detail }))).toEqual({ title: "Invalid", message: detail || "Invalid note title." });
  });

  it("maps ordinary duplicates and too-large notes", () => {
    expect(noteSaveError(response(409, { code: "note_exists" }))).toEqual({ title: "Duplicate", message: "A note with this title already exists. Please try again with a new title." });
    expect(noteSaveError(response(413))).toEqual(tooLarge("note"));
  });

  it.each([new Error("offline"), response(401), response(500), response("413")])("leaves unhandled save errors to the caller %#", error => {
    expect(noteSaveError(error)).toBeNull();
  });
});

describe("attachment error policy", () => {
  it("maps ordinary duplicates and retains numeric/string too-large status behavior", () => {
    expect(noteAttachmentError(response(409))).toEqual({ title: "Duplicate", message: "An attachment with this filename already exists." });
    expect(noteAttachmentError(response(413))).toEqual(tooLarge("attachment"));
    expect(noteAttachmentError(response("413"))).toEqual(tooLarge("attachment"));
  });

  it.each([new Error("offline"), response(400), response(401), response(500)])("leaves unhandled upload errors to the caller %#", error => {
    expect(noteAttachmentError(error)).toBeNull();
  });
});
