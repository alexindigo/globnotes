import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../clipboard.js";

const originalExecCommand = document.execCommand;
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = "";
  if (originalExecCommand) document.execCommand = originalExecCommand;
  else delete document.execCommand;
});

describe("clipboard capability contract", () => {
  it("uses the native asynchronous clipboard when available and preserves rejection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyText("literal\ntext");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("literal\ntext");
    writeText.mockRejectedValue(Error("Permission denied"));
    await expect(copyText("protected")).rejects.toThrow("Permission denied");
  });

  it("copies exact HTTP text through the native copy event without moving focus or selection", async () => {
    vi.stubGlobal("navigator", {});
    document.body.innerHTML = '<button>Copy</button><p>Retained selection</p>';
    const button = document.querySelector("button"), paragraph = document.querySelector("p");
    button.focus();
    const range = document.createRange(); range.selectNodeContents(paragraph);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const setData = vi.fn();
    vi.stubGlobal("document", document);
    document.execCommand = vi.fn(() => {
      const event = new Event("copy", { cancelable: true, bubbles: true });
      Object.defineProperty(event, "clipboardData", { value: { setData } });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      return true;
    });
    const text = "  exact\nUnicode: 日本語\n";
    await copyText(text);
    expect(setData).toHaveBeenCalledExactlyOnceWith("text/plain", text);
    expect(document.activeElement).toBe(button);
    expect(selection.toString()).toBe("Retained selection");
    const event = new Event("copy", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });
    document.dispatchEvent(event);
    expect(setData).toHaveBeenCalledTimes(1);
  });

  it("reports failure and releases the listener when native copying is refused", async () => {
    vi.stubGlobal("navigator", {});
    document.execCommand = vi.fn(() => false);
    await expect(copyText("not copied")).rejects.toThrow("Clipboard copy is unavailable");
    const setData = vi.fn(), event = new Event("copy", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });
    document.dispatchEvent(event);
    expect(setData).not.toHaveBeenCalled();
  });
});
