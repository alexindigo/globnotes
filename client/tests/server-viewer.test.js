// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount as mountComponent } from "@vue/test-utils";

import ServerViewer from "../components/ServerViewer.vue";
import { getPlugins, getRenderedHtml } from "../api.js";
import { subscribe } from "../bus/index.js";

vi.mock("../api.js", () => ({
  getPlugins: vi.fn(),
  getRenderedHtml: vi.fn(),
}));
vi.mock("../bus/index.js", () => ({
  subscribe: vi.fn(() => vi.fn()),
  TOPICS: { PLUGIN_TOGGLE: "plugin:toggle", PLUGIN_AUTO_ENABLE: "plugin:auto-enable", THEME_CHANGE: "theme:change" },
}));
vi.mock("../pluginSettings.js", async () => {
  const { ref } = await import("vue");
  return { disabledPluginIds: () => [], viewLineNumbers: ref(false) };
});
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), run: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("katex/contrib/auto-render/auto-render.js", () => ({ default: vi.fn() }));

enableAutoUnmount(afterEach);

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

let hookErrors;
function mount(component, options) {
  return mountComponent(component, {
    ...options,
    global: { config: { errorHandler: hookErrors } },
  });
}

describe("ServerViewer render lifetime", () => {
  let errors;
  beforeEach(() => {
    vi.clearAllMocks();
    getPlugins.mockReset().mockResolvedValue([]);
    getRenderedHtml.mockReset().mockResolvedValue("<p>Current note</p>");
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    hookErrors = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it("stops a pending plugin lookup when the viewer unmounts", async () => {
    const plugins = deferred();
    getPlugins.mockReturnValue(plugins.promise);
    const wrapper = mount(ServerViewer, { props: { title: "Old" } });
    wrapper.unmount();
    plugins.resolve([]);
    await flushPromises();
    expect(getRenderedHtml).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(hookErrors).not.toHaveBeenCalled();
  });

  it("does not write a completed render into an unmounted surface", async () => {
    const render = deferred();
    getRenderedHtml.mockReturnValue(render.promise);
    const wrapper = mount(ServerViewer, { props: { title: "Old" } });
    const root = wrapper.element;
    await flushPromises();
    wrapper.unmount();
    render.resolve("<p>Stale note</p>");
    await flushPromises();
    expect(root.innerHTML).toBe("");
    expect(errors).not.toHaveBeenCalled();
    expect(hookErrors).not.toHaveBeenCalled();
  });

  it("ignores a late failure after unmount instead of writing an error to a null ref", async () => {
    const render = deferred();
    getRenderedHtml.mockReturnValue(render.promise);
    const wrapper = mount(ServerViewer, { props: { title: "Old" } });
    await flushPromises();
    wrapper.unmount();
    render.reject(new Error("Late request failure"));
    await flushPromises();
    expect(errors).not.toHaveBeenCalled();
    expect(hookErrors).not.toHaveBeenCalled();
  });

  it("keeps the latest note when an older request completes last", async () => {
    const oldRender = deferred();
    getRenderedHtml.mockImplementation((title) => title === "Old"
      ? oldRender.promise : Promise.resolve("<p>New note</p>"));
    const wrapper = mount(ServerViewer, { props: { title: "Old" } });
    await flushPromises();
    await wrapper.setProps({ title: "New" });
    await flushPromises();
    expect(wrapper.text()).toBe("New note");
    oldRender.resolve("<p>Old note</p>");
    await flushPromises();
    expect(wrapper.text()).toBe("New note");
    expect(errors).not.toHaveBeenCalled();
  });

  it("reports a real failure on the active surface", async () => {
    getRenderedHtml.mockRejectedValue(new Error("Current request failure"));
    const wrapper = mount(ServerViewer, { props: { title: "Current" } });
    await flushPromises();
    expect(wrapper.text()).toBe("Failed to render this note.");
    expect(wrapper.classes()).toContain("toastui-editor-contents");
    expect(errors).toHaveBeenCalledOnce();
  });

  it("releases the viewer's event subscriptions on unmount", () => {
    const wrapper = mount(ServerViewer, { props: { title: "Current" } });
    const unsubscribers = subscribe.mock.results.map((result) => result.value);
    expect(unsubscribers.length).toBeGreaterThan(0);
    wrapper.unmount();
    for (const unsubscribe of unsubscribers) expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
