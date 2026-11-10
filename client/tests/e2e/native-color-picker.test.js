import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseNativeColor, focusedPickerSlider } from "./native-color-picker.mjs";

const owner = { nodeId: "color", backendDOMNodeId: 7, childIds: ["popup"] };
const popup = { nodeId: "popup", childIds: ["slider"] };
const slider = { nodeId: "slider", role: { value: "slider" }, properties: [{ name: "focused", value: { value: true } }] };
afterEach(() => vi.unstubAllGlobals());

describe("native color picker admission", () => {
  it("requires a focused slider inside the exact input's popup, not parent focus or another field", () => {
    expect(focusedPickerSlider([owner], 7)).toBeNull();
    expect(focusedPickerSlider([owner, slider], 7)).toBeNull();
    expect(focusedPickerSlider([owner, popup, { ...slider, properties: [] }], 7)).toBeNull();
    expect(focusedPickerSlider([owner, popup, slider], 8)).toBeNull();
    expect(focusedPickerSlider([owner, popup, slider], 7)).toBe(slider);
  });

  it("attaches AX before opening and admits each native key once after popup readiness", async () => {
    vi.stubGlobal("Deno", { env: { get: () => undefined } });
    const calls = [];
    let observations = 0;
    const session = {
      async send(method) {
        calls.push(method);
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") return { nodeId: 2 };
        if (method === "DOM.describeNode") return { node: { backendNodeId: 7 } };
        if (method === "Accessibility.getFullAXTree") return { nodes: ++observations < 3 ? [owner] : [owner, popup, slider] };
        return {};
      },
      async click() { calls.push("click"); },
      async poll(expression) { calls.push(expression); },
      async key(key) { expect(observations).toBe(3); calls.push(key); },
    };
    await chooseNativeColor(session, "#color", "#aabbcc");
    expect(calls.indexOf("Accessibility.getFullAXTree")).toBeLessThan(calls.indexOf("click"));
    expect(calls.filter(call => call === "ArrowRight")).toHaveLength(1);
    expect(calls.filter(call => call === "Enter")).toHaveLength(1);
    expect(calls.at(-1)).toBe("Accessibility.disable");
  });

  it("does not send or replay input when popup inspection fails, and releases AX", async () => {
    vi.stubGlobal("Deno", { env: { get: () => undefined } });
    const key = vi.fn();
    const send = vi.fn(async method => {
      if (method === "DOM.getDocument") throw Error("closed target");
      return {};
    });
    await expect(chooseNativeColor({ send, key }, "#color", "#aabbcc")).rejects.toThrow("closed target");
    expect(key).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith("Accessibility.disable");
  });
});
