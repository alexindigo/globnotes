import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreSettingsAdapters } from "../coreSettingsAdapters.js";

let adapter;
let current;
let writeBrand;
let readBrand;
beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  current = { name: "old name", accent: "#53c729", files: [] };
  writeBrand = vi.fn();
  readBrand = vi.fn();
  adapter = createCoreSettingsAdapters({
    getBrand: () => current, applyBrand: fresh => { current = fresh; },
    writable: () => true, writeBrand, readBrand,
  });
  adapter.loadBrand();
});
afterEach(() => { adapter.dispose(); vi.useRealTimers(); });

describe("Branding unknown-outcome recovery consumers", () => {
  it("recognizes a lost-response name already persisted without replaying its write", async () => {
    adapter.editBrand("name", "persisted A");
    writeBrand.mockRejectedValue(new Error("response lost"));
    expect(await adapter.saveBrand()).toBe(false);
    readBrand.mockResolvedValue({ name: "persisted A", accent: "#53c729", files: [] });
    expect(await adapter.retryBrand(), adapter.brandSnapshot().error).toBe(true);
    expect(current.name).toBe("persisted A");
    expect(adapter.brandSnapshot().name).toBe("persisted A");
    expect(adapter.hasWork()).toBe(false);
    expect(writeBrand).toHaveBeenCalledTimes(1);
  });

  it("applies authoritative read-back while retaining newer edits for explicit retry", async () => {
    adapter.editBrand("name", "submitted A");
    writeBrand.mockRejectedValueOnce(new Error("response lost"));
    expect(await adapter.saveBrand()).toBe(false);
    adapter.editBrand("name", "newer D");
    readBrand.mockResolvedValue({ name: "submitted A", accent: "#eeaabb", files: [] });
    expect(await adapter.reviewBrand(), adapter.brandSnapshot().error).toBe(true);
    expect(current).toEqual({ name: "submitted A", accent: "#eeaabb", files: [] });
    expect(adapter.brandSnapshot().name).toBe("newer D");
    expect(adapter.brandSnapshot().accent).toBe("#eeaabb");
    expect(writeBrand).toHaveBeenCalledTimes(1);
    writeBrand.mockResolvedValue({ name: "newer D", accent: "#eeaabb", files: [] });
    expect(await adapter.retryBrand()).toBe(true);
    expect(writeBrand.mock.calls[1][0].get("name")).toBe("newer D");
    expect(writeBrand.mock.calls[1][0].has("accent")).toBe(false);
    expect(current.name).toBe("newer D");
  });

  it("retains an unresolved admitted write and acknowledges only its submitted version", async () => {
    vi.useFakeTimers();
    let resolve;
    writeBrand.mockReturnValue(new Promise(done => { resolve = done; }));
    adapter.editBrand("name", "submitted A");
    const saving = adapter.saveBrand();
    await vi.advanceTimersByTimeAsync(5001);
    expect(await saving).toBe(false);
    expect(adapter.brandSnapshot().busy).toBe(true);
    expect(await adapter.retryBrand()).toBe(false);
    expect(adapter.discardBrand()).toBe(false);
    expect(writeBrand).toHaveBeenCalledTimes(1);
    adapter.editBrand("name", "newer D");
    resolve({ name: "submitted A", accent: "#53c729", files: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(current.name).toBe("submitted A");
    expect(adapter.brandSnapshot().name).toBe("newer D");
    expect(adapter.brandSnapshot().busy).toBe(false);
  });

  it("treats a server failure as potentially partial and requires actual read-back", async () => {
    adapter.editBrand("name", "submitted A");
    writeBrand.mockRejectedValue({ response: { status: 500, data: { detail: "partial persistence" } } });
    expect(await adapter.saveBrand()).toBe(false);
    expect(adapter.brandSnapshot().unknown).toBe(true);
    expect(await adapter.settle()).toBe(false);
    expect(adapter.discardBrand()).toBe(false);
    readBrand.mockResolvedValue({ name: "submitted A", accent: "#53c729", files: [] });
    expect(await adapter.reviewBrand(), adapter.brandSnapshot().error).toBe(true);
    expect(current.name).toBe("submitted A");
    expect(writeBrand).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled recovery read and retains choices without another write", async () => {
    vi.useFakeTimers();
    adapter.editBrand("name", "submitted A");
    writeBrand.mockRejectedValue(new Error("response lost"));
    expect(await adapter.saveBrand()).toBe(false);
    readBrand.mockReturnValue(new Promise(() => {}));
    let settled = false;
    const review = adapter.reviewBrand().then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(5001);
    expect(settled).toBe(true);
    expect(await review).toBe(false);
    expect(adapter.brandSnapshot().name).toBe("submitted A");
    expect(adapter.brandSnapshot().unknown).toBe(true);
    expect(writeBrand).toHaveBeenCalledTimes(1);
  });
});
