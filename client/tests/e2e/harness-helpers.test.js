import { afterEach, describe, expect, it, vi } from "vitest";
import { connectSocket, createOwnedTarget } from "./native-cdp-session.mjs";
import { parseArguments } from "./harness-helpers.mjs";

class FakeSocket extends EventTarget {
  static instance;
  constructor() { super(); FakeSocket.instance = this; }
  send(text) { this.sent = JSON.parse(text); }
  close() { this.dispatchEvent(new Event("close")); }
}
afterEach(() => vi.useRealTimers());

describe("native CDP deadlines and ownership", () => {
  it("bounds connection establishment", async () => {
    vi.useFakeTimers();
    const result = connectSocket("ws://fixture", { Socket: FakeSocket, timeout: 20 });
    const assertion = expect(result).rejects.toThrow("connection deadline");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it("rejects pending calls on disconnect and releases their timers", async () => {
    vi.useFakeTimers();
    const connection = connectSocket("ws://fixture", { Socket: FakeSocket });
    FakeSocket.instance.dispatchEvent(new Event("open"));
    const client = await connection;
    const pending = client.send("Runtime.evaluate");
    const assertion = expect(pending).rejects.toThrow("disconnected");
    FakeSocket.instance.close();
    await assertion;
    expect(client.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds admitted CDP requests", async () => {
    vi.useFakeTimers();
    const connection = connectSocket("ws://fixture", { Socket: FakeSocket, timeout: 20 });
    FakeSocket.instance.dispatchEvent(new Event("open"));
    const client = await connection;
    const assertion = expect(client.send("Page.navigate")).rejects.toThrow("request deadline");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(client.pendingCount).toBe(0);
  });

  it("startup failure cleans only the context/target created by this caller", async () => {
    const send = vi.fn(async method => method === "Target.createBrowserContext" ? { browserContextId: "owned-context" } : method === "Target.createTarget" ? { targetId: "owned-target" } : {});
    await expect(createOwnedTarget({ send }, async () => { throw new Error("connect failed"); })).rejects.toThrow("connect failed");
    expect(send.mock.calls).toEqual([
      ["Target.createBrowserContext"],
      ["Target.createTarget", { url: "about:blank", browserContextId: "owned-context" }],
      ["Target.closeTarget", { targetId: "owned-target" }],
      ["Target.disposeBrowserContext", { browserContextId: "owned-context" }],
    ]);
  });
});

describe("acceptance argument admission", () => {
  it.each([["--unknown"], ["--include-dev"], ["--artifacts"], ["--artifacts", "--help"], ["--help", "--help"], ["--artifacts", "/one", "--artifacts", "/two"]])("rejects malformed or unsupported arguments %j", (...args) => {
    expect(() => parseArguments(args)).toThrow();
  });
  it("accepts production artifact and help arguments", () => {
    expect(parseArguments(["--artifacts", "/fixture", "--help"])).toEqual({ artifacts: "/fixture", help: true });
  });
});
