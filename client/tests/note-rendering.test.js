import { describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({ getPlugins: vi.fn() }));
vi.mock("../pluginSettings.js", () => ({ disabledPluginIds: vi.fn() }));

import { renderWithPlugins } from "../noteRendering.js";

function deferred() {
  let resolve;
  const promise = new Promise(ok => { resolve = ok; });
  return { promise, resolve };
}

describe("shared plugin render preparation", () => {
  it("keeps note HTML formatting but removes executable markup before either consumer sees it", async () => {
    const raw = '<p data-source-line="0" data-line="L1"><strong>safe</strong>' +
      '<a href="https://example.test/">link</a><img src="assets/a.png" onerror="evil()">' +
      '<script>evil()</script><a href="javascript:evil()">bad</a><svg onload="evil()"></svg></p>';
    const html = await renderWithPlugins(async () => raw, {
      getPlugins: async () => [], disabledPluginIds: () => [],
    });
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelector("strong").textContent).toBe("safe");
    expect(root.querySelector('a[href="https://example.test/"]')).not.toBeNull();
    expect(root.querySelector('img[src="assets/a.png"]')).not.toBeNull();
    expect(root.querySelector('[data-source-line="0"][data-line="L1"]')).not.toBeNull();
    expect(root.querySelector("script,[onerror],[onload],[href^='javascript:']")).toBeNull();
  });

  it("awaits plugins, then reads disabled switches, then renders with those ids", async () => {
    const pending = deferred();
    const plugins = [{ id: "off" }, { id: "on" }];
    const order = [];
    const disabledPluginIds = vi.fn(value => {
      expect(value).toBe(plugins);
      order.push("disabled");
      return ["off"];
    });
    const render = vi.fn(disabled => {
      order.push("render");
      expect(disabled).toEqual(["off"]);
      return "<p>output</p>";
    });
    const result = renderWithPlugins(render, {
      getPlugins: () => { order.push("plugins"); return pending.promise; },
      disabledPluginIds,
    });
    expect(order).toEqual(["plugins"]);
    pending.resolve(plugins);
    await expect(result).resolves.toBe("<p>output</p>");
    expect(order).toEqual(["plugins", "disabled", "render"]);
  });

  it("keeps the viewer lifetime checkpoint before disabled selection and render", async () => {
    const pending = deferred();
    let current = true;
    const disabledPluginIds = vi.fn();
    const render = vi.fn();
    const result = renderWithPlugins(render, {
      getPlugins: () => pending.promise, disabledPluginIds, isCurrent: () => current,
    });
    current = false;
    pending.resolve([]);
    await expect(result).resolves.toBeUndefined();
    expect(disabledPluginIds).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it.each(["plugins", "disabled", "render"])("propagates %s failures to the surface owner", async phase => {
    const error = Error(phase);
    const failAt = name => { if (phase === name) throw error; };
    await expect(renderWithPlugins(() => { failAt("render"); }, {
      getPlugins: async () => { failAt("plugins"); return []; },
      disabledPluginIds: () => { failAt("disabled"); return []; },
    })).rejects.toBe(error);
  });
});
