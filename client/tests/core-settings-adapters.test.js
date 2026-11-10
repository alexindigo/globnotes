import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreSettingsAdapters } from "../coreSettingsAdapters.js";

let adapter;
let current;
let writeBrand;
let readBrand;
const originalCreateUrl = URL.createObjectURL;
const originalRevokeUrl = URL.revokeObjectURL;
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
afterEach(() => { adapter.dispose(); URL.createObjectURL = originalCreateUrl; URL.revokeObjectURL = originalRevokeUrl; vi.useRealTimers(); });

describe("Branding unknown-outcome recovery consumers", () => {
  function resetFixture(namePinned = true, accentPinned = false) {
    URL.createObjectURL = vi.fn(file => `blob:${file.name}`);
    URL.revokeObjectURL = vi.fn();
    current = {
      name: "Deployment", accent: "#53c729", files: ["logo.svg", "icon.svg"],
      fields: {
        name: { source: "environment", readonly: namePinned },
        accent: { source: "environment", readonly: accentPinned },
      },
    };
    adapter.discardBrand();
    const fresh = { ...current, name: namePinned ? current.name : null, accent: accentPinned ? current.accent : null, files: [] };
    adapter.chooseFile("logo", new File(["old logo"], "before-reset-logo.svg"));
    adapter.chooseFile("icon", new File(["old icon"], "before-reset-icon.svg"));
    writeBrand.mockRejectedValueOnce(Error("reset committed; response lost"));
    return fresh;
  }

  for (const [namePinned, accentPinned] of [[true, false], [false, true], [true, true], [false, false]]) {
    it(`recognizes a lost reset from its submitted fields with name pin ${namePinned} and accent pin ${accentPinned}`, async () => {
      const fresh = resetFixture(namePinned, accentPinned);
      expect(await adapter.saveBrand(true)).toBe(false);
      const reset = writeBrand.mock.calls[0][0];
      expect(reset.has("name")).toBe(!namePinned);
      expect(reset.has("accent")).toBe(!accentPinned);
      expect(reset.get("removeLogo")).toBe("true");
      expect(reset.get("removeIcon")).toBe("true");
      readBrand.mockResolvedValue(fresh);
      expect(await adapter.reviewBrand()).toBe(true);
      const snapshot = adapter.brandSnapshot();
      expect(snapshot.name).toBe(fresh.name ?? "");
      expect(snapshot.accent).toBe(fresh.accent ?? "#38bdf8");
      expect(snapshot.files.logo.picked).toBe(false);
      expect(snapshot.files.icon.picked).toBe(false);
      expect(adapter.hasWork()).toBe(false);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:before-reset-logo.svg");
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:before-reset-icon.svg");
      expect(writeBrand).toHaveBeenCalledTimes(1);
      adapter.chooseFile("icon", new File(["later icon"], "after-reset-icon.svg"));
      writeBrand.mockResolvedValue({ ...fresh, files: ["icon.svg"] });
      expect(await adapter.saveBrand()).toBe(true);
      const later = writeBrand.mock.calls[1][0];
      expect(later.has("logo")).toBe(false);
      expect(later.get("icon").name).toBe("after-reset-icon.svg");
      expect(later.has("name")).toBe(false);
      expect(later.has("accent")).toBe(false);
    });
  }

  for (const namePinned of [true, false]) {
    it(`keeps drafts edited after reset submission with name pin ${namePinned}`, async () => {
      const fresh = resetFixture(namePinned);
      expect(await adapter.saveBrand(true)).toBe(false);
      if (!namePinned) adapter.editBrand("name", "Newer name");
      adapter.editBrand("accent", "#112233");
      adapter.chooseFile("logo", new File(["newer logo"], "newer-logo.svg"));
      readBrand.mockResolvedValue(fresh);
      expect(await adapter.reviewBrand()).toBe(true);
      const snapshot = adapter.brandSnapshot();
      expect(snapshot.name).toBe(namePinned ? "Deployment" : "Newer name");
      expect(snapshot.accent).toBe("#112233");
      expect(snapshot.files.logo.picked).toBe(true);
      expect(snapshot.files.icon.picked).toBe(false);
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:newer-logo.svg");
      expect(adapter.hasWork()).toBe(true);
      writeBrand.mockResolvedValue({ ...fresh, accent: "#112233", files: ["logo.svg"] });
      expect(await adapter.saveBrand()).toBe(true);
      const later = writeBrand.mock.calls[1][0];
      expect(later.get("logo").name).toBe("newer-logo.svg");
      expect(later.has("icon")).toBe(false);
      expect(later.get("accent")).toBe("#112233");
      expect(later.get("name")).toBe(namePinned ? null : "Newer name");
    });
  }

  for (const incomplete of ["accent", "files"]) {
    it(`does not discard file drafts when reset read-back still has ${incomplete}`, async () => {
      const fresh = resetFixture();
      expect(await adapter.saveBrand(true)).toBe(false);
      readBrand.mockResolvedValue(incomplete === "accent" ? { ...fresh, accent: "#53c729" } : { ...fresh, files: ["logo.svg"] });
      expect(await adapter.reviewBrand()).toBe(true);
      expect(adapter.brandSnapshot().files.logo.picked).toBe(true);
      expect(adapter.brandSnapshot().files.icon.picked).toBe(true);
      expect(adapter.hasWork()).toBe(true);
      expect(writeBrand).toHaveBeenCalledTimes(1);
    });
  }

  it('r2 A24 only enables Cancel changes for a dirty settled branding owner', async () => {
    expect(adapter.brandSnapshot().canCancel).toBe(false);
    adapter.editBrand('name','edited'); expect(adapter.brandSnapshot().canCancel).toBe(true);
    adapter.discardBrand(); expect(adapter.brandSnapshot().canCancel).toBe(false);
    adapter.editBrand('name','unknown'); writeBrand.mockRejectedValue(Error('lost'));
    await adapter.saveBrand(); expect(adapter.brandSnapshot().canCancel).toBe(false);
  });
  it("recognizes a lost-response name already persisted without replaying its write", async () => {
    adapter.editBrand("name", "persisted A");
    writeBrand.mockRejectedValue(new Error("response lost"));
    expect(await adapter.saveBrand()).toBe(false);
    readBrand.mockResolvedValue({ name: "persisted A", accent: "#53c729", files: [] });
    expect(await adapter.reviewBrand(), adapter.brandSnapshot().error).toBe(true);
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
    expect(await adapter.reviewBrand()).toBe(true); expect(await adapter.saveBrand()).toBe(true);
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
    expect(await adapter.reviewBrand()).toBe(false);
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
