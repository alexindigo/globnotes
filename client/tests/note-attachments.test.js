import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "../api.js";
import { subscribe, TOPICS } from "../bus/index.js";
import { createNoteAttachments } from "../noteAttachments.js";

vi.mock("../api.js", () => ({ uploadFile: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const file = { name: "image.png" };
const uploaded = { url: "/folder/image-1.png", filename: "image-1.png" };
function fixture(overrides = {}) {
  const adapters = {
    getState: () => ({ requestedPath: "folder/Note", path: "old/Note" }),
    notify: vi.fn(), failed: vi.fn(), publish: vi.fn(), upload: vi.fn(async () => uploaded), ...overrides,
  };
  return { ...adapters, ...createNoteAttachments(adapters) };
}

describe("note attachments", () => {
  it.each([
    [{ requestedPath: "new/folder/Note", path: "old/Note" }, "new/folder"],
    [{ requestedPath: "", path: "viewed/Note" }, "viewed"],
    [{ requestedPath: "Root", path: "viewed/Note" }, ""],
    [{}, ""],
  ])("selects the upload directory from current intent/view fallback %#", async (state, directory) => {
    const f = fixture({ getState: () => state });
    expect(await f.postAttachment(file)).toBe(uploaded);
    expect(f.upload).toHaveBeenCalledExactlyOnceWith(file, directory);
  });

  it("reads live paths on every invocation and captures each destination before its upload", async () => {
    let state = { requestedPath: "one/Note" };
    const f = fixture({ getState: () => state });
    const first = f.postAttachment(file); state = { requestedPath: "two/Note" }; const second = f.postAttachment(file);
    await Promise.all([first, second]);
    expect(f.upload.mock.calls).toEqual([[file, "one"], [file, "two"]]);
  });

  it("notifies upload, then publishes the original name once before success and returns canonical metadata", async () => {
    const effects = [];
    const f = fixture({ notify: value => effects.push(value), upload: async () => { effects.push("upload"); return uploaded; }, publish: (...args) => effects.push(args) });
    expect(await f.postAttachment(file)).toBe(uploaded);
    expect(effects).toEqual([
      { message: "Uploading attachment..." }, "upload", [TOPICS.FILE_UPLOAD, { name: "image.png" }],
      { title: "Success", message: "Attachment uploaded successfully ✓", severity: "success" },
    ]);
  });

  it("rejects invalid names before transport, facts or upload notifications and retains undefined return", () => {
    const f = fixture();
    expect(f.postAttachment({ name: "bad?.png" })).toBeUndefined();
    expect(f.notify).toHaveBeenCalledExactlyOnceWith({ title: "Invalid Title", message: 'Due to filename restrictions, the following characters are not allowed: <>:"\\|?*', severity: "error" });
    expect(f.upload).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  });

  it.each([
    [409, { code: "plugin_cancelled", detail: "No upload", pluginId: "guard" }, "Blocked by plugin", "No upload (plugin: guard)"],
    [503, { code: "plugin_guard_failed" }, "Plugin guard failed", "A required plugin guard failed or is unavailable."],
    [409, { code: "operation_conflict" }, "Conflict", "The vault changed while this operation was pending; it was not applied."],
    [500, { code: "operation_partial" }, "Partial failure", "Some changes could not be completed. Do not retry blindly."],
    [409, {}, "Duplicate", "An attachment with this filename already exists."],
    [413, {}, "Failure", "This attachment is too large. Please try again with a smaller attachment or adjust your server configuration."],
  ])("reports upload error %s/%j without publishing or yielding data", async (status, data, title, message) => {
    const f = fixture({ upload: vi.fn().mockRejectedValue({ response: { status, data } }) });
    expect(await f.postAttachment(file)).toBeUndefined();
    expect(f.notify.mock.calls).toEqual([[{ message: "Uploading attachment..." }], [{ title, message, severity: "error" }]]);
    expect(f.publish).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it("forwards unknown errors to the existing fallback and settles without an image", async () => {
    const error = new Error("offline"), callback = vi.fn();
    const f = fixture({ upload: vi.fn().mockRejectedValue(error) });
    f.addImageBlobHook(file, callback); await vi.waitFor(() => expect(f.failed).toHaveBeenCalledExactlyOnceWith(error));
    expect(callback).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  });

  it("inserts the server-returned URL and collision filename through the image hook", async () => {
    const f = fixture(), callback = vi.fn();
    expect(f.addImageBlobHook(file, callback)).toBeUndefined();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(uploaded.url, uploaded.filename));
  });

  it("preserves the image hook's synchronous invalid-name boundary", () => {
    const f = fixture(), callback = vi.fn();
    expect(() => f.addImageBlobHook({ name: "bad?.png" }, callback)).toThrow(TypeError);
    expect(callback).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled();
  });

  it("binds the real API default and delivers the fact to the bus consumer", async () => {
    uploadFile.mockResolvedValue(uploaded);
    const consumer = vi.fn(), unsubscribe = subscribe(TOPICS.FILE_UPLOAD, consumer);
    try {
      const controller = createNoteAttachments({ getState: () => ({ path: "viewed/Note" }), notify: vi.fn(), failed: vi.fn() });
      expect(await controller.postAttachment(file)).toBe(uploaded);
      expect(uploadFile).toHaveBeenCalledExactlyOnceWith(file, "viewed");
      expect(consumer).toHaveBeenCalledExactlyOnceWith({ name: file.name });
    } finally { unsubscribe(); }
  });
});
