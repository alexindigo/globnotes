import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({ getPlugins: vi.fn(), renderBuffer: vi.fn() }));
vi.mock("../pluginSettings.js", () => ({ disabledPluginIds: vi.fn() }));

import { getPlugins, renderBuffer } from "../api.js";
import { disabledPluginIds } from "../pluginSettings.js";
import { createNotePreview } from "../notePreview.js";

function deferred() {
  let resolve;
  const promise = new Promise(ok => { resolve = ok; });
  return { promise, resolve };
}

describe("unsaved note preview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    getPlugins.mockResolvedValue([{ id: "off" }]);
    disabledPluginIds.mockReturnValue(["off"]);
    renderBuffer.mockResolvedValue("<p>rendered</p>");
  });
  afterEach(() => vi.useRealTimers());

  it("debounces repeated schedules by 400ms and publishes a read-only snapshot", async () => {
    const render = vi.fn(async getBuffer => `<p>${getBuffer()}</p>`);
    const changed = vi.fn();
    const preview = createNotePreview({ render, changed });
    const intent = { isActive: () => true, getBuffer: () => "unsaved" };
    expect(preview.state()).toEqual({ html: "" });
    preview.schedule(intent);
    await vi.advanceTimersByTimeAsync(300);
    preview.schedule(intent);
    await vi.advanceTimersByTimeAsync(399);
    expect(render).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(render).toHaveBeenCalledOnce();
    expect(preview.state()).toEqual({ html: "<p>unsaved</p>" });
    expect(changed).toHaveBeenCalledExactlyOnceWith(preview.state());
    expect(Object.isFrozen(preview.state())).toBe(true);
  });

  it("accepts an injected render and delay without transport calls", async () => {
    const preview = createNotePreview({ render: async () => "custom", delay: 12 });
    preview.schedule({ isActive: () => true, getBuffer: () => "buffer" });
    await vi.advanceTimersByTimeAsync(11);
    expect(preview.state().html).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(preview.state().html).toBe("custom");
    expect(getPlugins).not.toHaveBeenCalled();
    expect(renderBuffer).not.toHaveBeenCalled();
  });

  it("does not schedule outside preview or render after leaving before the debounce", async () => {
    let active = false;
    const render = vi.fn();
    const preview = createNotePreview({ render });
    const intent = { isActive: () => active, getBuffer: () => "buffer" };
    preview.schedule(intent);
    expect(vi.getTimerCount()).toBe(0);
    active = true;
    preview.schedule(intent);
    active = false;
    await vi.advanceTimersByTimeAsync(400);
    expect(render).not.toHaveBeenCalled();
    expect(preview.state().html).toBe("");
  });

  it("uses the retained unsaved buffer after plugin discovery and current disabled ids", async () => {
    const pending = deferred();
    getPlugins.mockReturnValue(pending.promise);
    let buffer = "switch-time buffer";
    const changed = vi.fn();
    const preview = createNotePreview({ changed });
    preview.schedule({ isActive: () => true, getBuffer: () => buffer });
    await vi.advanceTimersByTimeAsync(400);
    expect(renderBuffer).not.toHaveBeenCalled();
    buffer = "latest retained buffer";
    pending.resolve([{ id: "off" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(disabledPluginIds).toHaveBeenCalledWith([{ id: "off" }]);
    expect(renderBuffer).toHaveBeenCalledExactlyOnceWith("latest retained buffer", ["off"]);
    expect(changed).toHaveBeenCalledExactlyOnceWith({ html: "<p>rendered</p>" });
  });

  it.each(["plugins", "render"])("keeps the existing preview error HTML on %s failure", async phase => {
    if (phase === "plugins") getPlugins.mockRejectedValue(Error("discovery failed"));
    else renderBuffer.mockRejectedValue(Error("render failed"));
    const changed = vi.fn();
    const preview = createNotePreview({ changed });
    preview.schedule({ isActive: () => true, getBuffer: () => "unsaved" });
    await vi.advanceTimersByTimeAsync(400);
    expect(preview.state().html).toBe('<p class="render-error">Preview render failed.</p>');
    expect(changed).toHaveBeenCalledExactlyOnceWith(preview.state());
  });
});
