import { afterEach, expect, it, vi } from "vitest";
import { bootServer } from "./harness-helpers.mjs";
import { ReadinessError } from "../../../tests/helpers/wait.ts";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("../../../tests/helpers/boot.ts", () => ({ bootServer: launch }));
vi.mock("./http-origin.mjs", () => ({ bindAddress: () => "192.0.2.1", httpOrigin: port => `http://globnotes.test:${port}` }));
afterEach(() => { launch.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

for (const crash of [false, true]) {
  it(`preserves ${crash ? "child-exit" : "plugin-failure"} readiness diagnostics when cleanup rejects`, async () => {
    const output = { stdout: "owned server output", stderr: "owned crash detail" };
    let status = null;
    const cleanup = new Error("server exited on its own before close()");
    const close = vi.fn().mockRejectedValue(cleanup);
    launch.mockResolvedValue({ baseUrl: "http://globnotes.test:4321", pid: 23, output,
      status: () => status, logs: () => output, close });
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (crash) status = { code: 17, signal: null };
      return new Response(JSON.stringify({ plugins: [{ id: "broken", enabled: true, runtime: { server: "service.js" }, status: "failed" }] }));
    }));
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await bootServer("/fixture/vault", "/fixture/state").catch(error => error);
    expect(error).toBeInstanceOf(ReadinessError);
    expect(error).not.toBe(cleanup);
    expect(error.label).toBe("e2e server plugins ready");
    expect(error.reason).toContain(crash ? "child exited (pid 23, exit code 17)" : "plugin 'broken' failed");
    if (crash) expect(error.state.stderr).toBe(output.stderr);
    else expect(error.state[0].id).toBe("broken");
    expect(close).toHaveBeenCalledExactlyOnceWith();
    expect(diagnostic).toHaveBeenCalledOnce();
  });
}
