import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsPageState, validateSettingsInput } from "../settingsPageState.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let controller;
afterEach(() => { controller?.dispose(); controller = null; vi.useRealTimers(); });
function fixture() {
  const descriptor = { fields: [{ key: "message", label: "Message", type: "text", default: "seed" }, { key: "limit", label: "Limit", type: "number", default: 5, min: 1, max: 10, step: 1 }] };
  const pages = new Map(["a", "b"].map(id => [id, { id: `plugin:${id}:p`, owner: id, pageId: "p", label: id.toUpperCase(), available: true, descriptor }]));
  const registry = { find: id => [...pages.values()].find(page => page.id === id), read: vi.fn(async page => ({ revision: 0, values: { message: `${page.owner}-seed`, limit: 5 } })),
    commit: vi.fn(async (page, values, revision) => ({ values, revision: revision + 1 })) };
  const confirm = vi.fn(async () => "cancel");
  controller = createSettingsPageState({ registry, confirm });
  return { registry, confirm, pages };
}

describe("retained page-owned settings consumers", () => {
  it("review repairs: R18 loaded-schema refresh keeps an explicit departure Save available", async () => {
    const { registry } = fixture(), reading = deferred(); await controller.load("plugin:a:p");
    registry.read.mockReturnValue(reading.promise); const refreshing = controller.load("plugin:a:p");
    try {
      controller.edit("plugin:a:p", "message", "explicit departure save");
      expect(controller.snapshot("plugin:a:p").canSave).toBe(true);
      expect(await controller.resolveDeparture(["plugin:a:p"], "close", "save")).toBe(true);
      expect(registry.commit).toHaveBeenCalledTimes(1);
      reading.resolve({ revision: 0, values: { message: "old", limit: 5 } }); await refreshing;
      expect(controller.snapshot("plugin:a:p").committed.message).toBe("explicit departure save");
    } finally { reading.resolve({ revision: 0, values: { message: "old", limit: 5 } }); await refreshing; }
  });
  it("review repairs: R18 loaded-schema refresh cannot drop an explicit commit or overwrite its acknowledgement", async () => {
    const { registry } = fixture(), reading = deferred(); await controller.load("plugin:a:p");
    registry.read.mockReturnValue(reading.promise);
    const refreshing = controller.load("plugin:a:p");
    try {
      controller.edit("plugin:a:p", "message", "explicit during refresh");
      expect(await controller.commit("plugin:a:p", "message")).toBe(true);
      expect(registry.commit).toHaveBeenCalledTimes(1);
      expect(registry.commit.mock.calls[0][2]).toBe(0);
      reading.resolve({ revision: 0, values: { message: "late older GET", limit: 5 } }); await refreshing;
      expect(controller.snapshot("plugin:a:p").committed.message).toBe("explicit during refresh");
      expect(controller.snapshot("plugin:a:p").revision).toBe(1);
    } finally { reading.resolve({ revision: 0, values: { message: "late", limit: 5 } }); await refreshing; }
  });
  it("keeps A/B reads and acknowledgements bound to their admitted owner", async () => {
    const { registry } = fixture(), a = deferred();
    registry.read.mockImplementation(page => page.owner === "a" ? a.promise : Promise.resolve({ revision: 3, values: { message: "B actual", limit: 6 } }));
    const readingA = controller.load("plugin:a:p"); await controller.load("plugin:b:p");
    a.resolve({ revision: 2, values: { message: "A actual", limit: 7 } }); await readingA;
    expect(controller.snapshot("plugin:a:p").values.message).toBe("A actual");
    expect(controller.snapshot("plugin:b:p").values.message).toBe("B actual");
  });
  it("deduplicates Enter/blur and acknowledges only the submitted edit version", async () => {
    const { registry } = fixture(), wire = deferred(); await controller.load("plugin:a:p");
    registry.commit.mockReturnValue(wire.promise);
    controller.edit("plugin:a:p", "message", "A submitted");
    const first = controller.commit("plugin:a:p", "message"), blur = controller.commit("plugin:a:p", "message");
    wire.resolve({ revision: 1, values: { message: "A submitted", limit: 5 } }); await first; await blur;
    expect(registry.commit).toHaveBeenCalledTimes(1);
    controller.edit("plugin:a:p", "message", "B submitted"); const next = deferred(); registry.commit.mockReturnValue(next.promise);
    const saving = controller.commit("plugin:a:p", "message"); controller.edit("plugin:a:p", "message", "newer D");
    next.resolve({ revision: 2, values: { message: "B submitted", limit: 5 } }); await saving;
    expect(controller.snapshot("plugin:a:p").committed.message).toBe("B submitted");
    expect(controller.snapshot("plugin:a:p").drafts.message).toBe("newer D");
  });
  it("retains an invalid number while committing a complete valid envelope for another field", async () => {
    const { registry } = fixture(); await controller.load("plugin:a:p");
    controller.edit("plugin:a:p", "limit", ""); controller.edit("plugin:a:p", "message", "valid message");
    await controller.commit("plugin:a:p", "message");
    expect(registry.commit.mock.calls[0][1]).toEqual({ message: "valid message", limit: 5 });
    expect(controller.snapshot("plugin:a:p").drafts.limit).toBe("");
    expect(controller.snapshot("plugin:a:p").errors.limit).toBe("Enter a number.");
    expect(controller.snapshot("plugin:a:p").canSave).toBe(false);
  });
  it("preserves conflict choices and removed/changed-descriptor recovery until explicit discard", async () => {
    const { registry, pages } = fixture(); await controller.load("plugin:a:p");
    controller.edit("plugin:a:p", "message", "retained");
    registry.commit.mockRejectedValue({ response: { status: 409, data: { detail: "changed elsewhere" } } }); await controller.commit("plugin:a:p", "message");
    expect(await controller.retry("plugin:a:p")).toBe(false);
    expect(controller.snapshot("plugin:a:p").drafts.message).toBe("retained");
    const old = pages.get("a"); pages.delete("a"); controller.reconcile();
    expect(controller.recoveryPages().map(page => page.id)).toEqual(["plugin:a:p"]);
    expect(controller.snapshot("plugin:a:p").canSave).toBe(false);
    pages.set("a", { ...old, descriptor: { fields: [{ key: "new", type: "text", default: "new" }] } }); controller.reconcile();
    expect(controller.snapshot("plugin:a:p").changedDescriptor).not.toBeNull();
    expect(await controller.resolveDeparture(["plugin:a:p"], "page change", "cancel")).toBe(false);
    expect(controller.snapshot("plugin:a:p").drafts.message).toBe("retained");
    expect(await controller.resolveDeparture(["plugin:a:p"], "page change", "discard")).toBe(true);
    expect(controller.snapshot("plugin:a:p").page.descriptor.fields[0].key).toBe("new");
  });
  it("observation timeout retains the unresolved wire and blocks discard and duplicate retry", async () => {
    vi.useFakeTimers(); const { registry, confirm } = fixture(), wire = deferred(); await controller.load("plugin:a:p");
    registry.commit.mockReturnValue(wire.promise); confirm.mockResolvedValue("discard");
    controller.edit("plugin:a:p", "message", "captured A");
    const saving = controller.commit("plugin:a:p", "message"); await vi.advanceTimersByTimeAsync(5001); await saving;
    try {
      expect(controller.snapshot("plugin:a:p").pending).toBe(true);
      const departure = controller.resolveDeparture(["plugin:a:p"], "logout"); await vi.advanceTimersByTimeAsync(5001);
      expect(await departure).toBe(false); expect(confirm).not.toHaveBeenCalled();
      expect(await controller.retry("plugin:a:p")).toBe(false); expect(registry.commit).toHaveBeenCalledTimes(1);
      controller.edit("plugin:a:p", "message", "newer D");
      wire.resolve({ revision: 1, values: { message: "captured A", limit: 5 } }); await Promise.resolve(); await Promise.resolve();
      expect(controller.snapshot("plugin:a:p").committed.message).toBe("captured A");
      expect(controller.snapshot("plugin:a:p").drafts.message).toBe("newer D");
    } finally { wire.resolve({ revision: 1, values: { message: "captured A", limit: 5 } }); }
  });
  it("validates empty/nonfinite/step/select values without default coercion", () => {
    expect(validateSettingsInput({ type: "number", min: 1 }, "").error).toBe("Enter a number.");
    expect(validateSettingsInput({ type: "number" }, "Infinity").error).toBe("Enter a finite number.");
    expect(validateSettingsInput({ type: "slider", min: 0, step: 2 }, "3").error).toBe("Use steps of 2.");
    expect(validateSettingsInput({ type: "select", options: [{ value: false }] }, false)).toEqual({ value: false });
    expect(validateSettingsInput({ type: "select", options: [{ value: false }] }, "false").error).toBeTruthy();
  });
  it("review repairs: R02 persisted-source failure retains the draft until read-back and never replays automatically", async () => {
    const { registry } = fixture(); await controller.load("plugin:a:p");
    controller.edit("plugin:a:p", "message", "persisted proposal");
    registry.commit.mockRejectedValue({ response: { status: 503, data: { code: "plugin_settings_source_commit_failed", detail: "Settings revision 1 persisted; read back before retry." } } });
    expect(await controller.commit("plugin:a:p")).toBe(false);
    expect(controller.snapshot("plugin:a:p").uncertain).not.toBeNull();
    expect(controller.snapshot("plugin:a:p").drafts.message).toBe("persisted proposal");
    expect(await controller.settle()).toBe(false);
    expect(await controller.commit("plugin:a:p")).toBe(false);
    expect(registry.commit).toHaveBeenCalledTimes(1);
    controller.edit("plugin:a:p", "message", "newer retained draft");
    registry.read.mockResolvedValue({ revision: 1, values: { message: "persisted proposal", limit: 5 } });
    registry.commit.mockResolvedValue({ revision: 2, values: { message: "newer retained draft", limit: 5 } });
    // This is the first explicit recovery gesture, not the failed wire's replay.
    expect(await controller.retry("plugin:a:p")).toBe(true);
    expect(registry.read).toHaveBeenCalledTimes(2);
    expect(registry.commit.mock.calls[1][2]).toBe(1);
    expect(controller.snapshot("plugin:a:p").committed.message).toBe("newer retained draft");
  });
});

describe("review repairs: R18 descriptor adoption after owned work", () => {
  const drain = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  function replace(pages, key) {
    pages.set("a", { ...pages.get("a"), descriptor: { fields: [{ key, type: "text", default: `${key}-default` }] } });
    controller.reconcile();
  }
  it("review repairs: R18 clean D1 ACK adopts latest D3 and loads its schema before admitting commits", async () => {
    const { registry, pages } = fixture(), wire = deferred(), reading = deferred(); await controller.load("plugin:a:p");
    registry.commit.mockReturnValue(wire.promise); controller.edit("plugin:a:p", "message", "D1 proposal");
    const saving = controller.commit("plugin:a:p");
    replace(pages, "d2"); replace(pages, "d3"); registry.read.mockReturnValue(reading.promise);
    wire.resolve({ revision: 1, values: { message: "D1 proposal", limit: 5 } }); await saving; await drain();
    const adopting = controller.snapshot("plugin:a:p");
    expect(adopting.page.descriptor.fields[0].key).toBe("d3"); expect(adopting.changedDescriptor).toBeNull();
    expect(adopting.loaded).toBe(false); expect(adopting.canSave).toBe(false);
    expect(registry.read).toHaveBeenCalledTimes(2); expect(registry.read.mock.calls[1][0].descriptor.fields[0].key).toBe("d3");
    reading.resolve({ revision: 9, values: { d3: "D3 authoritative" } }); await drain();
    expect(controller.snapshot("plugin:a:p").committed).toEqual({ d3: "D3 authoritative" });
    expect(controller.snapshot("plugin:a:p").canSave).toBe(true);
    controller.edit("plugin:a:p", "d3", "D3 explicit proposal"); registry.commit.mockResolvedValue({ revision: 10, values: { d3: "D3 explicit proposal" } });
    expect(await controller.commit("plugin:a:p")).toBe(true); expect(registry.commit.mock.calls[1][2]).toBe(9);
  });
  it("review repairs: R18 unknown original wire fences D2/D3 until its own clean late ACK settles", async () => {
    vi.useFakeTimers(); const { registry, pages } = fixture(), wire = deferred(); await controller.load("plugin:a:p");
    registry.commit.mockReturnValue(wire.promise); controller.edit("plugin:a:p", "message", "D1 proposal");
    const saving = controller.commit("plugin:a:p"); await vi.advanceTimersByTimeAsync(5001); expect(await saving).toBe(false);
    replace(pages, "d2"); replace(pages, "d3");
    expect(controller.snapshot("plugin:a:p").page.descriptor.fields[0].key).toBe("message"); expect(registry.read).toHaveBeenCalledTimes(1);
    registry.read.mockResolvedValue({ revision: 8, values: { d3: "fresh D3" } });
    wire.resolve({ revision: 1, values: { message: "D1 proposal", limit: 5 } }); await drain();
    expect(controller.snapshot("plugin:a:p").page.descriptor.fields[0].key).toBe("d3");
    expect(controller.snapshot("plugin:a:p").committed).toEqual({ d3: "fresh D3" });
    expect(controller.snapshot("plugin:a:p").pending).toBe(false); expect(controller.snapshot("plugin:a:p").changedDescriptor).toBeNull();
  });
  it("review repairs: R18 newer invalid draft and page removal retain D1 until explicit resolution", async () => {
    const { registry, pages } = fixture(), wire = deferred(); await controller.load("plugin:a:p");
    registry.commit.mockReturnValue(wire.promise); controller.edit("plugin:a:p", "message", "submitted");
    const saving = controller.commit("plugin:a:p"); controller.edit("plugin:a:p", "limit", ""); replace(pages, "d2");
    const latest = pages.get("a"); pages.delete("a"); controller.reconcile();
    wire.resolve({ revision: 1, values: { message: "submitted", limit: 5 } }); await saving; await drain();
    const retained = controller.snapshot("plugin:a:p"); expect(retained.page.descriptor.fields[0].key).toBe("message");
    expect(retained.drafts.limit).toBe(""); expect(retained.errors.limit).toBe("Enter a number."); expect(retained.available).toBe(false);
    expect(registry.read).toHaveBeenCalledTimes(1);
    pages.set("a", { ...latest, descriptor: { fields: [{ key: "d3", type: "text", default: "new" }] } }); controller.reconcile();
    registry.read.mockResolvedValue({ revision: 7, values: { d3: "resolved" } });
    expect(await controller.resolveDeparture(["plugin:a:p"], "page", "discard")).toBe(true); await drain();
    expect(controller.snapshot("plugin:a:p").page.descriptor.fields[0].key).toBe("d3");
    expect(controller.snapshot("plugin:a:p").committed).toEqual({ d3: "resolved" });
  });
  it("review repairs: R18 a settled unknown write can read current D3 without replay and retain D1 until explicit discard", async () => {
    const { registry, pages } = fixture(); await controller.load("plugin:a:p");
    registry.commit.mockRejectedValue(Error("original response lost"));
    controller.edit("plugin:a:p", "message", "original retained intent"); expect(await controller.commit("plugin:a:p")).toBe(false); await drain();
    replace(pages, "d2"); replace(pages, "d3"); registry.read.mockResolvedValue({ revision: 1, values: { d3: "current authoritative" } });
    expect(await controller.resolveDeparture(["plugin:a:p"], "close", "discard")).toBe(false);
    expect(controller.snapshot("plugin:a:p").drafts.message).toBe("original retained intent");
    expect(await controller.retry("plugin:a:p")).toBe(false); await drain();
    expect(registry.read).toHaveBeenCalledTimes(2); expect(registry.commit).toHaveBeenCalledTimes(1);
    expect(controller.snapshot("plugin:a:p").status).toBe("conflict"); expect(controller.snapshot("plugin:a:p").uncertain).toBeNull();
    expect(controller.snapshot("plugin:a:p").drafts.message).toBe("original retained intent");
    expect(controller.snapshot("plugin:a:p").page.descriptor.fields[0].key).toBe("message");
    expect(await controller.resolveDeparture(["plugin:a:p"], "close", "discard")).toBe(true); await drain();
    expect(controller.snapshot("plugin:a:p").page.descriptor.fields[0].key).toBe("d3");
    expect(controller.snapshot("plugin:a:p").committed).toEqual({ d3: "current authoritative" });
    expect(registry.commit).toHaveBeenCalledTimes(1);
  });
  it("review repairs: R18 accepted persisted-write read-back adopts the latest compatible definition and waits for its new load", async () => {
    const { registry, pages } = fixture(), reload = deferred(); await controller.load("plugin:a:p");
    controller.edit("plugin:a:p", "message", "persisted original");
    registry.commit.mockRejectedValue({ response: { status: 503, data: { code: "plugin_settings_source_commit_failed", detail: "revision 1 persisted" } } });
    expect(await controller.commit("plugin:a:p")).toBe(false); await drain();
    const old = pages.get("a");
    for (const label of ["D2", "D3"]) { pages.set("a", { ...old, descriptor: { ...old.descriptor, label } }); controller.reconcile(); }
    registry.read.mockResolvedValueOnce({ revision: 1, values: { message: "persisted original", limit: 5 } }).mockReturnValueOnce(reload.promise);
    expect(await controller.retry("plugin:a:p")).toBe(true); await drain();
    expect(controller.snapshot("plugin:a:p").page.descriptor.label).toBe("D3");
    expect(controller.snapshot("plugin:a:p").loaded).toBe(false); expect(controller.snapshot("plugin:a:p").canSave).toBe(false);
    expect(registry.commit).toHaveBeenCalledTimes(1);
    reload.resolve({ revision: 1, values: { message: "fresh D3 load", limit: 5 } }); await drain();
    expect(controller.snapshot("plugin:a:p").committed.message).toBe("fresh D3 load");
    expect(controller.snapshot("plugin:a:p").canSave).toBe(true);
  });
});
