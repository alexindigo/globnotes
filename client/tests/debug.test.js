import { beforeEach, describe, expect, it, vi } from "vitest";

import { debugEnabled, initDebugNotifications, toggleDebug } from "../debug.js";
import { publish, TOPICS } from "../bus/index.js";

describe("debug mode", () => {
  beforeEach(() => {
    localStorage.clear();
    debugEnabled.value = false;
  });

  it("toggles on and persists", () => {
    toggleDebug();
    expect(debugEnabled.value).toBe(true);
    expect(localStorage.getItem("debug")).toBe("true");
  });

  it("toggles off and persists", () => {
    debugEnabled.value = true;
    toggleDebug();
    expect(debugEnabled.value).toBe(false);
    expect(localStorage.getItem("debug")).toBe("false");
  });

  it("surfaces bus events as toasts only while enabled", () => {
    const toast = { add: vi.fn() };
    initDebugNotifications(toast);

    // Disabled by default: no subscription.
    publish(TOPICS.NOTE_OPEN, { title: "x" });
    expect(toast.add).not.toHaveBeenCalled();

    // Enabling subscribes to every topic.
    toggleDebug();
    publish(TOPICS.NOTE_OPEN, { title: "x" });
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ summary: TOPICS.NOTE_OPEN }),
    );

    // Disabling tears the subscriptions down.
    toast.add.mockClear();
    toggleDebug();
    publish(TOPICS.THEME_CHANGE, { id: "dracula", resolvedId: "dracula", mode: "dark" });
    expect(toast.add).not.toHaveBeenCalled();
  });
});
