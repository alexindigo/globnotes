// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount as mountComponent } from "@vue/test-utils";

import ServerViewer from "../components/ServerViewer.vue";
import { getPlugins, getRenderedHtml } from "../api.js";
import { subscribe } from "../bus/index.js";
import { viewLineNumbers } from "../pluginSettings.js";
import { copyText } from "../clipboard.js";
import mermaid from "mermaid";
import renderMathInElement from "katex/contrib/auto-render/auto-render.js";

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
vi.mock("../clipboard.js", () => ({ copyText: vi.fn().mockResolvedValue(true) }));

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
    viewLineNumbers.value = false;
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    hookErrors = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it("publishes rendered-content classes only after an owned output reaches the surface", async () => {
    const render = deferred();
    getRenderedHtml.mockReturnValue(render.promise);
    const wrapper = mount(ServerViewer, { props: { title: "Held" } });
    try {
      await flushPromises();
      expect(wrapper.element.innerHTML).toBe("");
      expect(wrapper.classes()).not.toContain("rendered-markdown");
      expect(wrapper.classes()).not.toContain("toastui-editor-contents");
      render.resolve("<pre><code>owned code</code></pre>");
      await flushPromises();
      expect(wrapper.find("pre code").text()).toBe("owned code");
      expect(wrapper.classes()).toContain("rendered-markdown");
      expect(wrapper.classes()).toContain("toastui-editor-contents");
    } finally {
      render.resolve("<pre><code>owned code</code></pre>");
      await flushPromises();
    }
  });

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

  it("wires rendered HTML to Mermaid, math, copy buttons and line highlighting", async () => {
    getRenderedHtml.mockResolvedValue('<p data-source-line="0">first</p><p data-source-line="1">second</p><pre><code>code</code></pre><pre class="mermaid">graph TD</pre>');
    const wrapper = mount(ServerViewer, { props: { title: "Current", line: { from: 2, to: 2 } } });
    await flushPromises();
    expect(wrapper.find('[data-source-line="0"]').classes()).not.toContain("line-highlight");
    expect(wrapper.find('[data-source-line="1"]').classes()).toContain("line-highlight");
    expect(wrapper.findAll(".code-copy-btn")).toHaveLength(1);
    expect(wrapper.find(".mermaid .code-copy-btn").exists()).toBe(false);
    expect(mermaid.initialize).toHaveBeenCalledWith({ startOnLoad: false, theme: "base", themeVariables: expect.objectContaining({ background: "transparent" }) });
    expect([...mermaid.run.mock.calls[0][0].nodes]).toEqual([wrapper.find(".mermaid").element]);
    expect(renderMathInElement).toHaveBeenCalledWith(wrapper.element, {
      delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }],
      throwOnError: false,
    });
    await wrapper.setProps({ line: { from: 1, to: 1 } });
    expect(wrapper.find('[data-source-line="0"]').classes()).toContain("line-highlight");
    expect(wrapper.find('[data-source-line="1"]').classes()).not.toContain("line-highlight");
    expect(getRenderedHtml).toHaveBeenCalledOnce();
  });

  it("rerenders the mounted surface when the view line-number preference changes", async () => {
    const wrapper = mount(ServerViewer, { props: { title: "Current" } });
    await flushPromises();
    getRenderedHtml.mockResolvedValue('<p data-source-line="0">Numbered</p>');
    viewLineNumbers.value = true;
    await flushPromises();
    expect(getRenderedHtml).toHaveBeenLastCalledWith("Current", [], true);
    expect(wrapper.text()).toBe("Numbered");
  });

  it("copies code through the clipboard owner and resets visual feedback", async () => {
    vi.useFakeTimers();
    try {
      getRenderedHtml.mockResolvedValue("<pre><code>copy this</code></pre>");
      const wrapper = mount(ServerViewer, { props: { title: "Current" } });
      await flushPromises();
      const button = wrapper.find(".code-copy-btn");
      await button.trigger("click");
      await flushPromises();
      expect(copyText).toHaveBeenCalledExactlyOnceWith("copy this");
      expect(button.classes()).toContain("copied");
      await vi.advanceTimersByTimeAsync(1500);
      expect(button.classes()).not.toContain("copied");
    } finally {
      vi.useRealTimers();
    }
  });
});
