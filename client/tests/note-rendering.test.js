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
