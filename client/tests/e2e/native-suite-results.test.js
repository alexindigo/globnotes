import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { caseName, CASE_DURATION_MS, concurrencyValue, FILE_CASES, nativeChildArguments, NATIVE_HELPERS, parseShardArguments, partitionCases, runChildren, SELECTION, selectCases, selectShard, SERIAL_CASES, validateNativeInventory } from "./legacy-native-suite.mjs";

describe("native suite child result ownership", () => {
  it("registers layered configuration with the existing shared controls", () => {
    expect(selectCases("layered-config-native")).toEqual([
      ["native-ownership-control"], ["native-actions-control"], ["layered-config-native"],
    ]);
    expect(FILE_CASES["client/tests/e2e/layered-config-native.mjs"]).toEqual(["layered-config-native"]);
  });
  const directory = process.cwd() + "/client/tests/e2e";
  const inventory = readdirSync(directory);
  it("partitions the complete measured inventory exactly once, including variants and shared controls", () => {
    const shards = partitionCases();
    expect(shards).toEqual(partitionCases());
    const names = shards.flat().map(caseName);
    expect(names.toSorted()).toEqual(SELECTION.map(caseName).toSorted());
    expect(new Set(names).size).toBe(SELECTION.length);
    expect(Object.keys(CASE_DURATION_MS).toSorted()).toEqual(SELECTION.map(caseName).toSorted());
    const loads = shards.map(items => items.reduce((sum, item) => sum + CASE_DURATION_MS[caseName(item)] * (SERIAL_CASES[caseName(item)] ? 2 : 1), 0));
    // Greedy longest-first balances indivisible measured cases, not a fixed
    // sub-second gap tied to the previous inventory's duration snapshot.
    const largestCost = Math.max(...SELECTION.map(item => CASE_DURATION_MS[caseName(item)] * (SERIAL_CASES[caseName(item)] ? 2 : 1)));
    expect(Math.abs(loads[0] - loads[1])).toBeLessThanOrEqual(largestCost);
    expect(partitionCases([["settings-design"], ["generic-plugin-system"], ["backup-plugin"], ["native-consumer-controls"]])).toEqual([
      [["settings-design"], ["native-consumer-controls"]],
      [["generic-plugin-system"], ["backup-plugin"]],
    ]);
    expect(selectShard(selectCases(), "1/2")).toEqual(shards[0]);
    expect(selectShard(selectCases(), "2/2")).toEqual(shards[1]);
    expect(selectShard(selectCases())).toBe(SELECTION);
    expect(selectShard(selectCases("plugin-prefix-auth"), "1/2").concat(selectShard(selectCases("plugin-prefix-auth"), "2/2")).map(caseName).toSorted())
      .toEqual(selectCases("plugin-prefix-auth").map(caseName).toSorted());
    expect(() => partitionCases([["unmeasured"]])).toThrow("Missing measured");
  });
  it("rejects invalid shard arguments instead of silently running a partial suite", () => {
    expect(parseShardArguments([])).toBeUndefined();
    expect(parseShardArguments(["--shard", "1/2"])).toBe("1/2");
    expect(parseShardArguments(["--shard", "2/2"])).toBe("2/2");
    for (const args of [["--shard"], ["--shard", "0/2"], ["--shard", "1/3"], ["--shard", "3/2"], ["--unknown", "1/2"], ["--shard", "1/2", "extra"]]) {
      expect(() => parseShardArguments(args)).toThrow("Usage");
    }
  });
  it("selects every actual native entrypoint and explicitly classifies only helpers/fixtures", () => {
    expect(() => validateNativeInventory(inventory)).not.toThrow();
    for (const file of Object.keys(NATIVE_HELPERS)) {
      const source = readFileSync(directory + "/" + file, "utf8");
      expect(source, file).toMatch(/\bexport\b/);
      if (file !== "legacy-native-suite.mjs") expect(source, file).not.toMatch(/Deno\.args|import\.meta\.main/);
    }
  });
  it("rejects any omitted existing case, new unclassified case, missing file or duplicate selection", () => {
    for (const [name] of SELECTION) {
      expect(() => validateNativeInventory(inventory, SELECTION.filter(([driver]) => driver !== name))).toThrow("outside CI selection");
    }
    for (const file of ["new-native-case.mjs", "new-native-case.js", "new-native-case.ts"]) {
      expect(() => validateNativeInventory([...inventory, file])).toThrow(file);
    }
    expect(() => validateNativeInventory(inventory.filter(file => file !== "settings-inline-native.mjs"))).toThrow("absent files");
    expect(() => validateNativeInventory(inventory, [...SELECTION, SELECTION[0]])).toThrow("Duplicate");
    expect(() => validateNativeInventory(inventory, [...SELECTION, ["settings-inline-native"]])).toThrow("helpers selected");
  });
  it("gives CLI drivers fresh nested evidence directories without changing case identity or arguments", () => {
    expect(nativeChildArguments("backup-plugin", ["--controls"], "/owned/backup")).toEqual(["--controls", "--artifacts", "/owned/backup/consumers"]);
    expect(nativeChildArguments("settings-design", [], "/owned/design")).toEqual(["--artifacts", "/owned/design/consumers"]);
    expect(nativeChildArguments("theme", [], "/owned/theme")).toEqual([]);
    expect(FILE_CASES["client/tests/e2e/backup-plugin.mjs"]).toEqual([
      "backup-plugin", "backup-plugin---case-order", "backup-plugin---case-preimage", "backup-plugin---controls",
    ]);
    expect(FILE_CASES["client/tests/e2e/conflict-inbox-native.mjs"]).toEqual(["conflict-inbox-native", "conflict-inbox-native-narrow-status"]);
    expect(FILE_CASES["client/tests/e2e/rename-options.mjs"]).toEqual(["rename-options-move", "rename-options-relink", "rename-options-none"]);
    expect(FILE_CASES["client/tests/e2e/remotely-save-native.mjs"]).toEqual([
      "remotely-save-native-s3-none", "remotely-save-native-s3-openssl-base64", "remotely-save-native-s3-rclone-base64",
      "remotely-save-native-webdav-none", "remotely-save-native-webdav-openssl-base64", "remotely-save-native-webdav-rclone-base64",
    ]);
  });
  it("keeps the full prefix/auth consumer matrix in CI and filtered native runs", () => {
    expect(selectCases()).toContainEqual(["plugin-prefix-auth"]);
    expect(selectCases("plugin-prefix-auth")).toEqual([
      ["native-ownership-control"], ["native-actions-control"], ["plugin-prefix-auth"],
    ]);
    expect(FILE_CASES["client/tests/e2e/plugin-prefix-auth.mjs"]).toEqual(["plugin-prefix-auth"]);
    expect(FILE_CASES["client/tests/e2e/prefix-auth-fixture.mjs"]).toEqual(["plugin-prefix-auth"]);
  });
  it("includes sync status in CI, filtered runs and source-owned case selection", () => {
    expect(selectCases()).toContainEqual(["sync-status-native"]);
    expect(selectCases("sync-status-native")).toEqual([
      ["native-ownership-control"], ["native-actions-control"], ["sync-status-native"],
    ]);
    expect(FILE_CASES["client/tests/e2e/sync-status-native.mjs"]).toEqual(["sync-status-native"]);
  });
  it("rejects a nonzero child even when output contains the old pass marker and never starts later cases", async () => {
    const execute = vi.fn(async () => ({ success: false, code: 1, stdout: "distinct body backgrounds: 2; COPY BUTTON OK" }));
    await expect(runChildren([["broken"], ["later"]], execute, { concurrency: 1 })).rejects.toThrow("exit 1");
    expect(execute.mock.calls).toEqual([["broken", [], { timeout: 120000 }]]);
  });
  it("does not require magic output from a genuinely successful child", async () => {
    await expect(runChildren([["a", "move"], ["b"]], async () => ({ success: true, code: 0, stdout: "" }))).resolves.toEqual([
      { name: "a", args: ["move"], code: 0 }, { name: "b", args: [], code: 0 },
    ]);
  });
  it("budgets the real-time and whole-matrix children while retaining the leaf-case default", async () => {
    const execute = vi.fn(async () => ({ success: true, code: 0 }));
    await runChildren(SELECTION, execute);
    const budgets = { "autosave-timer": 300000, "access-settings": 600000,
      "settings-foundations": 600000, "settings-ui": 600000, "native-consumer-controls": 600000,
      "backup-plugin": 900000, "generic-plugin-system": 900000, "settings-design": 900000 };
    expect(execute.mock.calls).toEqual(SELECTION.map(([name, ...args]) => [
      name, args, { timeout: budgets[name] ?? 120000 },
    ]));
  });
  it("rejects a timed-out child even if it exits zero and never starts later cases", async () => {
    const execute = vi.fn(async () => ({ success: true, code: 0, timedOut: true }));
    await expect(runChildren([["autosave-timer"], ["later"]], execute, { concurrency: 1 })).rejects.toThrow("autosave-timer: child timed out");
    expect(execute.mock.calls).toEqual([["autosave-timer", [], { timeout: 300000 }]]);
  });
  it("defaults to three active children, preserves order and drains before exclusive cases", async () => {
    const running = new Map(), starts = [];
    let active = 0, peak = 0;
    const execute = vi.fn(name => {
      starts.push(name); active++; peak = Math.max(peak, active);
      if (SERIAL_CASES[name]) expect(active).toBe(1);
      return new Promise(resolve => running.set(name, () => {
        active--; resolve({ success: true, code: 0 });
      }));
    });
    const selection = [["a"], ["b"], ["c"], ["d"], ["copy-button"], ["e"]];
    const result = runChildren(selection, execute);
    expect(starts).toEqual(["a", "b", "c"]);
    running.get("b")(); await vi.waitFor(() => expect(starts).toContain("d"));
    running.get("d")(); running.get("c")();
    await Promise.resolve(); expect(starts).not.toContain("copy-button");
    running.get("a")(); await vi.waitFor(() => expect(starts).toContain("copy-button"));
    expect(starts).not.toContain("e");
    running.get("copy-button")(); await vi.waitFor(() => expect(starts).toContain("e"));
    running.get("e")();
    expect((await result).map(row => row.name)).toEqual(selection.map(([name]) => name));
    expect(peak).toBe(3);
  });
  it("stops admission on failure but waits for admitted children", async () => {
    let finish;
    const execute = vi.fn(name => name === "bad" ? Promise.resolve({ success: false, code: 7 }) : new Promise(resolve => { finish = resolve; }));
    const result = runChildren([["bad"], ["in-flight"], ["later"]], execute, { concurrency: 2 });
    const rejected = expect(result).rejects.toThrow("exit 7");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    finish({ success: true, code: 0 }); await rejected;
    expect(execute.mock.calls.map(([name]) => name)).toEqual(["bad", "in-flight"]);
  });
  it("validates configuration before starting any child", async () => {
    expect(concurrencyValue()).toBe(3);
    expect(concurrencyValue("1")).toBe(1);
    for (const value of ["0", "-1", "1.5", "no", "", Infinity]) {
      const execute = vi.fn();
      await expect(runChildren([["a"]], execute, { concurrency: value })).rejects.toThrow("positive integer");
      expect(execute).not.toHaveBeenCalled();
    }
  });
});
