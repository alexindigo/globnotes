import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({ getPlugins: vi.fn(), getRenderedHtml: vi.fn() }));
vi.mock("../pluginSettings.js", () => ({ disabledPluginIds: vi.fn(), viewLineNumbers: { value: false } }));
vi.mock("../bus/index.js", () => ({
  subscribe: vi.fn(() => vi.fn()),
  TOPICS: { PLUGIN_TOGGLE: "plugin:toggle", PLUGIN_AUTO_ENABLE: "plugin:auto-enable", THEME_CHANGE: "theme:change" },
}));

import { getPlugins, getRenderedHtml } from "../api.js";
import { subscribe } from "../bus/index.js";
import { disabledPluginIds, viewLineNumbers } from "../pluginSettings.js";
import { createServerViewer } from "../serverViewer.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function surface(overrides = {}) {
  const context = { title: "Current", root: {} };
  const setHtml = vi.fn(), rendered = vi.fn(), failed = vi.fn(), reportError = vi.fn();
  const viewer = createServerViewer({ getContext: () => context, setHtml, rendered, failed, reportError, ...overrides });
  return { context, setHtml, rendered, failed, reportError, ...viewer };
}

describe("saved-note render owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlugins.mockReset().mockResolvedValue([{ id: "off" }]);
    disabledPluginIds.mockReset().mockReturnValue(["off"]);
    getRenderedHtml.mockReset().mockResolvedValue("<p>Current</p>");
    viewLineNumbers.value = false;
  });

  it("awaits plugin discovery before reading live preferences and delivering HTML", async () => {
    const plugins = deferred();
    getPlugins.mockReturnValue(plugins.promise);
    const viewer = surface();
    const pending = viewer.renderNote();
    expect(disabledPluginIds).not.toHaveBeenCalled();
    expect(getRenderedHtml).not.toHaveBeenCalled();
    expect(viewer.rendered).not.toHaveBeenCalled();
    viewLineNumbers.value = true;
    disabledPluginIds.mockReturnValue(["off", "newly-disabled"]);
    plugins.resolve([{ id: "off" }, { id: "newly-disabled" }]);
    await pending;
    expect(disabledPluginIds).toHaveBeenCalledExactlyOnceWith([{ id: "off" }, { id: "newly-disabled" }]);
    expect(getRenderedHtml).toHaveBeenCalledExactlyOnceWith("Current", ["off", "newly-disabled"], true);
    expect(viewer.setHtml).toHaveBeenCalledExactlyOnceWith("<p>Current</p>");
    expect(viewer.rendered).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    expect(viewer.failed).not.toHaveBeenCalled();
  });

  it.each(["title", "root"])("does not request a render without a %s", async key => {
    const viewer = surface();
    viewer.context[key] = null;
    await viewer.renderNote();
    expect(getPlugins).not.toHaveBeenCalled();
    expect(getRenderedHtml).not.toHaveBeenCalled();
    expect(viewer.rendered).not.toHaveBeenCalled();
  });

  it("accepts a render adapter without calling transport", async () => {
    const render = vi.fn().mockResolvedValue("injected");
    const viewer = surface({ render });
    await viewer.renderNote();
    expect(render).toHaveBeenCalledExactlyOnceWith("Current", expect.any(Function));
    expect(viewer.setHtml).toHaveBeenCalledExactlyOnceWith("injected");
    expect(viewer.rendered).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    expect(getPlugins).not.toHaveBeenCalled();
    expect(getRenderedHtml).not.toHaveBeenCalled();
  });

  it("supersedes a pending plugin lookup even for the same title and surface", async () => {
    const oldPlugins = deferred();
    getPlugins.mockReturnValueOnce(oldPlugins.promise);
    const viewer = surface();
    const old = viewer.renderNote();
    await viewer.renderNote();
    oldPlugins.resolve([{ id: "retired" }]);
    await old;
    expect(getRenderedHtml).toHaveBeenCalledOnce();
    expect(disabledPluginIds).toHaveBeenCalledExactlyOnceWith([{ id: "off" }]);
    expect(viewer.rendered).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"])("ignores an older response's %s after a newer render", async outcome => {
    const oldRender = deferred();
    getRenderedHtml.mockReturnValueOnce(oldRender.promise);
    const viewer = surface();
    const old = viewer.renderNote();
    await Promise.resolve();
    viewer.context.title = "New";
    getRenderedHtml.mockResolvedValue("<p>New</p>");
    await viewer.renderNote();
    if (outcome === "success") oldRender.resolve("<p>Old</p>");
    else oldRender.reject(Error("retired"));
    await old;
    expect(viewer.setHtml).toHaveBeenCalledExactlyOnceWith("<p>New</p>");
    expect(viewer.rendered).toHaveBeenCalledOnce();
    expect(viewer.failed).not.toHaveBeenCalled();
    expect(viewer.reportError).not.toHaveBeenCalled();
  });

  it.each(["title", "root"])("fences a response when its %s changes without a new request", async key => {
    const render = deferred();
    getRenderedHtml.mockReturnValue(render.promise);
    const viewer = surface();
    const pending = viewer.renderNote();
    await Promise.resolve();
    viewer.context[key] = key === "title" ? "Other" : {};
    render.resolve("retired");
    await pending;
    expect(viewer.setHtml).not.toHaveBeenCalled();
    expect(viewer.rendered).not.toHaveBeenCalled();
    expect(viewer.failed).not.toHaveBeenCalled();
  });

  it("disposal prevents a pending plugin lookup from issuing a render request", async () => {
    const plugins = deferred();
    getPlugins.mockReturnValue(plugins.promise);
    const viewer = surface();
    const pending = viewer.renderNote();
    viewer.dispose();
    plugins.resolve([]);
    await pending;
    expect(disabledPluginIds).not.toHaveBeenCalled();
    expect(getRenderedHtml).not.toHaveBeenCalled();
    expect(viewer.rendered).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("disposal fences an in-flight render's %s", async outcome => {
    const render = deferred();
    getRenderedHtml.mockReturnValue(render.promise);
    const viewer = surface();
    const pending = viewer.renderNote();
    await Promise.resolve();
    viewer.dispose();
    if (outcome === "success") render.resolve("retired"); else render.reject(Error("retired"));
    await pending;
    expect(viewer.setHtml).not.toHaveBeenCalled();
    expect(viewer.rendered).not.toHaveBeenCalled();
    expect(viewer.failed).not.toHaveBeenCalled();
    expect(viewer.reportError).not.toHaveBeenCalled();
  });

  it.each(["plugins", "disabled", "render"])("reports active %s failures to the presentation callback", async phase => {
    const error = Error(phase);
    if (phase === "plugins") getPlugins.mockRejectedValue(error);
    if (phase === "disabled") disabledPluginIds.mockImplementation(() => { throw error; });
    if (phase === "render") getRenderedHtml.mockRejectedValue(error);
    const viewer = surface();
    await viewer.renderNote();
    expect(viewer.reportError).toHaveBeenCalledExactlyOnceWith("Note render failed", error);
    expect(viewer.failed).toHaveBeenCalledExactlyOnceWith(error);
    expect(viewer.rendered).not.toHaveBeenCalled();
  });

  it("leaves DOM presentation failures outside the request error path", async () => {
    const viewer = surface();
    const error = Error("DOM postprocessing");
    viewer.rendered.mockImplementation(() => { throw error; });
    await expect(viewer.renderNote()).rejects.toBe(error);
    expect(viewer.failed).not.toHaveBeenCalled();
    expect(viewer.reportError).not.toHaveBeenCalled();
  });

  it("keeps an HTML insertion failure in the original render error path", async () => {
    const viewer = surface();
    const error = Error("HTML insertion");
    viewer.setHtml.mockImplementation(() => { throw error; });
    await viewer.renderNote();
    expect(viewer.failed).toHaveBeenCalledExactlyOnceWith(error);
    expect(viewer.reportError).toHaveBeenCalledExactlyOnceWith("Note render failed", error);
    expect(viewer.rendered).not.toHaveBeenCalled();
  });

  it("provides a lifetime predicate for asynchronous DOM postprocessing", async () => {
    const viewer = surface();
    await viewer.renderNote();
    const isCurrent = viewer.rendered.mock.calls[0][0];
    expect(isCurrent()).toBe(true);
    await viewer.renderNote();
    expect(isCurrent()).toBe(false);
    const latest = viewer.rendered.mock.calls[1][0];
    expect(latest()).toBe(true);
    viewer.dispose();
    expect(latest()).toBe(false);
  });

  it("rerenders for each plugin/theme fact and releases the subscriptions on dispose", async () => {
    const viewer = surface();
    expect(subscribe.mock.calls.map(([topic]) => topic)).toEqual([
      "plugin:toggle", "plugin:auto-enable", "theme:change",
    ]);
    for (const [, handler] of subscribe.mock.calls) await handler();
    expect(viewer.rendered).toHaveBeenCalledTimes(3);
    viewer.dispose();
    for (const { value: unsubscribe } of subscribe.mock.results) expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
