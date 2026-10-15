// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive, ref } from "vue";
import { createSearchResults } from "../searchResults.js";
import { apiErrorHandler, getNotes, rewriteRefs } from "../api.js";
import { params, searchSortOptions as sorts } from "../constants.js";
import { TOPICS } from "../bus/index.js";

vi.mock("../api.js", () => ({
  getNotes: vi.fn().mockResolvedValue([]), rewriteRefs: vi.fn(), apiErrorHandler: vi.fn(),
}));

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function setup(options = {}) {
  const input = reactive({ searchTerm: "word", folder: undefined, sortBy: undefined, ...options.input });
  const preferences = { includeNested: ref(options.nested ?? true) };
  preferences.setIncludeNested = vi.fn(value => { preferences.includeNested.value = value; });
  const adapters = {
    query: () => input, navigate: vi.fn(), toast: { add: vi.fn() }, preferences,
    loadNotes: vi.fn().mockResolvedValue([]), rewrite: vi.fn().mockResolvedValue(undefined),
    reportError: vi.fn(), publish: vi.fn(), rewriteFiles: options.files && JSON.stringify(options.files),
    ...options.adapters,
  };
  const controller = createSearchResults(adapters);
  return { controller, input, preferences, ...adapters, state: controller.snapshot };
}

const files = [
  { oldPath: "before/A", newPath: "after/A" },
  { oldPath: "before/B", newPath: "after/B" },
];

describe("search result policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds default transport and error adapters outside the view", async () => {
    const toast = { add: vi.fn() };
    const controller = createSearchResults({ query: () => ({ searchTerm: "*" }), toast });
    await controller.init();
    expect(getNotes).toHaveBeenCalledWith("*", undefined, undefined, undefined, true, undefined);
    rewriteRefs.mockResolvedValueOnce(undefined);
    await controller.fixSingleRef(files[0]);
    expect(rewriteRefs).toHaveBeenCalledWith("before/A", "after/A");
    const error = new Error("load");
    getNotes.mockRejectedValueOnce(error);
    await controller.init();
    expect(apiErrorHandler).toHaveBeenCalledWith(error, toast);
  });

  it("builds the nested result query without an auxiliary request", async () => {
    const s = setup({ input: { folder: "F" } });
    await s.controller.init();
    expect(s.loadNotes).toHaveBeenCalledExactlyOnceWith("word", undefined, undefined, undefined, true, "F");
  });

  it("builds direct and nested queries and derives sorted immediate subdirectories", async () => {
    const s = setup({ nested: false, input: { folder: "F" } });
    s.loadNotes.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { title: "F/z/deep/note" }, { title: "F/a/note" }, { title: "F/a/other" },
      { title: "F/direct" }, { title: "Other/skip" },
    ]);
    await s.controller.init();
    expect(s.loadNotes.mock.calls).toEqual([
      ["word", undefined, undefined, undefined, false, "F"],
      ["word", undefined, undefined, undefined, true, "F"],
    ]);
    expect(s.state().currentSubdirs).toEqual(["F/a", "F/z"]);
    expect(s.state().load).toEqual({ status: "loaded" });
  });

  it("derives root folders and ignores direct notes", async () => {
    const s = setup({ nested: false });
    s.loadNotes.mockResolvedValueOnce([]).mockResolvedValueOnce([{ title: "Root" }, { title: "Z/n" }, { title: "A/n" }]);
    await s.controller.init();
    expect(s.state().currentSubdirs).toEqual(["A", "Z"]);
  });

  it("keeps direct results when auxiliary directory lookup fails", async () => {
    const s = setup({ nested: false });
    s.loadNotes.mockResolvedValueOnce([{ path: "Only" }]).mockRejectedValueOnce(new Error("dirs"));
    await s.controller.init();
    expect(s.state().results.map(n => n.path)).toEqual(["Only"]);
    expect(s.state().currentSubdirs).toEqual([]);
    expect(s.state().load.status).toBe("loaded");
    expect(s.reportError).not.toHaveBeenCalled();
  });

  it("exposes loading then No Results for an empty search", async () => {
    const request = deferred();
    const s = setup(); s.loadNotes.mockReturnValueOnce(request.promise);
    const pending = s.controller.init();
    expect(s.state().load.status).toBe("loading");
    request.resolve([]); await pending;
    expect(s.state().load).toMatchObject({ status: "failed", message: "No Results" });
    expect(s.state().load.icon).toBeTruthy();
  });

  it("reports result errors and preserves previous rows", async () => {
    const s = setup(); s.loadNotes.mockResolvedValueOnce([{ path: "Previous" }]);
    await s.controller.init();
    const error = new Error("results"); s.loadNotes.mockRejectedValueOnce(error);
    await s.controller.init();
    expect(s.state().load).toEqual({ status: "failed" });
    expect(s.state().results[0].path).toBe("Previous");
    expect(s.reportError).toHaveBeenCalledExactlyOnceWith(error, s.toast);
  });

  it.each([
    ["*", undefined, sorts.path, "Path", ["A", "Z"]],
    ["term", undefined, sorts.score, "Score", ["Z", "A"]],
    ["*", sorts.lastModified, sorts.lastModified, "Last Modified", ["Z", "A"]],
    ["term", sorts.path, sorts.path, "Path", ["A", "Z"]],
    ["*", sorts.score, sorts.score, "Score", ["Z", "A"]],
  ])("sorts %s using explicit/default policy %s", async (searchTerm, sortBy, effective, name, paths) => {
    const s = setup({ input: { searchTerm, sortBy } });
    s.loadNotes.mockResolvedValueOnce([
      { path: "Z", score: 9, lastModified: 2 }, { path: "A", score: 1, lastModified: 1 },
    ]);
    await s.controller.init();
    expect(s.state().effectiveSortBy).toBe(effective);
    expect(s.state().sortByName).toBe(name);
    expect(s.state().results.map(n => n.path)).toEqual(paths);
  });

  it("resorts existing results without another transport query", async () => {
    const s = setup(); s.loadNotes.mockResolvedValueOnce([{ path: "Z", score: 9 }, { path: "A", score: 1 }]);
    await s.controller.init(); s.input.sortBy = sorts.path; s.controller.reSortResults();
    expect(s.state().results.map(n => n.path)).toEqual(["A", "Z"]);
    expect(s.loadNotes).toHaveBeenCalledTimes(1);
  });

  it("uses the latest sort policy when an in-flight result arrives", async () => {
    const request = deferred(); const s = setup(); s.loadNotes.mockReturnValueOnce(request.promise);
    const pending = s.controller.init(); s.input.sortBy = sorts.path;
    request.resolve([{ path: "Z", score: 9 }, { path: "A", score: 1 }]); await pending;
    expect(s.state().results.map(n => n.path)).toEqual(["A", "Z"]);
  });

  it.each([
    [{ path: "F/n", pathHighlights: "<span>F/n</span>", title: "Label" }, "<span>F/n</span>"],
    [{ path: "F/n", title: "Label" }, "Label"],
    [{ path: "F/sub/n" }, "sub/n"],
    [{ path: "Foreign/n" }, "Foreign/n"],
  ])("chooses display title for %j", (result, title) => {
    expect(setup({ input: { folder: "F" } }).controller.title(result)).toBe(title);
  });

  it("preserves full fallback paths for an unscoped search", () => {
    expect(setup().controller.title({ path: "F/n" })).toBe("F/n");
  });

  it.each([["F/sub", "F"], ["F", undefined], [undefined, undefined]])("builds up navigation for %s", (folder, parent) => {
    const s = setup({ input: { folder, sortBy: sorts.path } });
    const query = { [params.searchTerm]: "word", [params.sortBy]: sorts.path };
    if (parent !== undefined) query[params.folder] = parent;
    expect(s.state().upTarget).toEqual({ name: "search", query });
    expect(s.controller.folderTarget("Other").query).toEqual({ ...query, [params.folder]: "Other" });
  });

  it("sort menu preserves its original unscoped navigation", () => {
    const s = setup({ input: { folder: "F" } });
    s.controller.menuItems.forEach(item => item.command());
    expect(s.navigate.mock.calls.map(([target]) => target)).toEqual(
      [sorts.score, sorts.path, sorts.lastModified].map(sort => ({ name: "search", query: {
        [params.searchTerm]: "word", [params.sortBy]: sort,
      } })),
    );
  });

  it("persists a nested toggle before reloading the changed query", async () => {
    const s = setup(); await s.controller.toggleNested();
    expect(s.preferences.setIncludeNested).toHaveBeenCalledWith(false);
    expect(s.state().includeNested).toBe(false);
    expect(s.loadNotes.mock.calls.map(args => args[4])).toEqual([false, true]);
  });

  it("parses the initial already-decoded rewrite query exactly once", () => {
    const encodedNames = [{ oldPath: "100%/a", newPath: "%20/a" }];
    expect(setup({ files: encodedNames }).state().rewriteFiles).toEqual(encodedNames);
    expect(setup({ adapters: { rewriteFiles: "broken" } }).state().rewriteFiles).toEqual([]);
  });

  it("publishes and removes only a successfully rewritten single row", async () => {
    const s = setup({ files }); const request = deferred(); s.rewrite.mockReturnValueOnce(request.promise);
    const pending = s.controller.fixSingleRef(files[0]);
    expect(s.state().fixInProgress).toBe(true); expect(s.publish).not.toHaveBeenCalled();
    request.resolve(); await pending;
    expect(s.rewrite).toHaveBeenCalledExactlyOnceWith("before/A", "after/A");
    expect(s.publish).toHaveBeenCalledExactlyOnceWith(TOPICS.NOTE_REFS_REWRITTEN, files[0]);
    expect(s.state().rewriteFiles).toEqual([files[1]]);
    expect(s.toast.add).toHaveBeenCalledWith({ severity: "success", summary: "Fixed", detail: "before/A", life: 3000 });
    expect(s.state().fixInProgress).toBe(false);
  });

  it("keeps a failed single row and reports its transport error", async () => {
    const s = setup({ files }); const error = new Error("rewrite"); s.rewrite.mockRejectedValueOnce(error);
    await s.controller.fixSingleRef(files[0]);
    expect(s.state().rewriteFiles).toEqual(files); expect(s.publish).not.toHaveBeenCalled();
    expect(s.toast.add).not.toHaveBeenCalled();
    expect(s.reportError).toHaveBeenCalledWith(error, s.toast);
    expect(s.state().fixInProgress).toBe(false);
  });

  it("rewrites a bulk snapshot sequentially and publishes each acknowledgement", async () => {
    const s = setup({ files }); const first = deferred(); s.rewrite.mockReturnValueOnce(first.promise);
    const pending = s.controller.fixAllRefs();
    expect(s.rewrite).toHaveBeenCalledTimes(1); expect(s.state().fixInProgress).toBe(true);
    first.resolve(); await pending;
    expect(s.rewrite.mock.calls).toEqual(files.map(f => [f.oldPath, f.newPath]));
    expect(s.publish.mock.calls).toEqual(files.map(f => [TOPICS.NOTE_REFS_REWRITTEN, f]));
    expect(s.state().rewriteFiles).toEqual([]); expect(s.state().fixInProgress).toBe(false);
    expect(s.toast.add).toHaveBeenCalledWith({ severity: "success", summary: "All fixed", detail: "2 references rewritten.", life: 3000 });
  });
});

describe("search request ownership", () => {
  it.each(["term", "folder", "nested"])("only accepts the latest %s query even when old success arrives last", async change => {
    const old = deferred(), current = deferred();
    const s = setup();
    s.loadNotes.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockResolvedValue([]);
    const first = s.controller.init();
    if (change === "term") s.input.searchTerm = "new";
    if (change === "folder") s.input.folder = "New";
    const second = change === "nested" ? s.controller.toggleNested() : s.controller.init();
    current.resolve([{ path: "New/n", score: 1 }]); await second;
    old.resolve([{ path: "Old/n", score: 9 }]); await first;
    expect(s.state().results.map(n => n.path)).toEqual(["New/n"]);
    expect(s.state().load.status).toBe("loaded");
  });

  it.each(["success", "failure"])("ignores old %s while the latest query is loading", async outcome => {
    const old = deferred(), current = deferred(); const s = setup();
    s.loadNotes.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = s.controller.init(); s.input.searchTerm = "new"; const second = s.controller.init();
    if (outcome === "success") old.resolve([{ path: "Old" }]); else old.reject(new Error("retired"));
    await first;
    expect(s.state().load.status).toBe("loading");
    expect(s.state().results).toEqual([]); expect(s.reportError).not.toHaveBeenCalled();
    current.resolve([{ path: "New" }]); await second;
    expect(s.state().results[0].path).toBe("New");
  });

  it("does not let a stale failure replace current results or report an error", async () => {
    const old = deferred(); const s = setup();
    s.loadNotes.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ path: "New" }]);
    const first = s.controller.init(); s.input.searchTerm = "new"; await s.controller.init();
    old.reject(new Error("retired")); await first;
    expect(s.state().load.status).toBe("loaded"); expect(s.state().results[0].path).toBe("New");
    expect(s.reportError).not.toHaveBeenCalled();
  });

  it("does not let stale success replace a current failed query", async () => {
    const old = deferred(); const s = setup(); const error = new Error("current");
    s.loadNotes.mockReturnValueOnce(old.promise).mockRejectedValueOnce(error);
    const first = s.controller.init(); s.input.folder = "New"; await s.controller.init();
    old.resolve([{ path: "Old" }]); await first;
    expect(s.state().load).toEqual({ status: "failed" }); expect(s.state().results).toEqual([]);
    expect(s.reportError).toHaveBeenCalledExactlyOnceWith(error, s.toast);
  });

  it("does not let stale empty results replace current rows", async () => {
    const old = deferred(); const s = setup();
    s.loadNotes.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ path: "New" }]);
    const first = s.controller.init(); await s.controller.init(); old.resolve([]); await first;
    expect(s.state().load.status).toBe("loaded"); expect(s.state().results[0].path).toBe("New");
  });

  it("treats results and delayed subdirectory matches as one ticketed response", async () => {
    const oldDirs = deferred(); const s = setup({ nested: false, input: { folder: "F" } });
    s.loadNotes.mockResolvedValueOnce([{ path: "F/Old" }]).mockReturnValueOnce(oldDirs.promise)
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ title: "F/New/n" }]);
    const first = s.controller.init(); s.input.searchTerm = "new"; await s.controller.init();
    oldDirs.resolve([{ title: "F/Old/n" }]); await first;
    expect(s.state().results).toEqual([]); expect(s.state().currentSubdirs).toEqual(["F/New"]);
    expect(s.state().load.status).toBe("loaded");
  });

  it("retires a pending non-nested pair when toggled back to nested", async () => {
    const old = deferred(); const s = setup({ nested: false });
    s.loadNotes.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ title: "Old/n" }])
      .mockResolvedValueOnce([{ path: "New/n" }]);
    const first = s.controller.init(); await s.controller.toggleNested();
    old.resolve([{ path: "Old" }]); await first;
    expect(s.state().results[0].path).toBe("New/n"); expect(s.state().currentSubdirs).toEqual([]);
  });

  it("accepts the current result when its auxiliary lookup fails", async () => {
    const old = deferred(); const s = setup({ nested: false });
    s.loadNotes.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ title: "Old/n" }])
      .mockResolvedValueOnce([{ path: "New" }]).mockRejectedValueOnce(new Error("dirs"));
    const first = s.controller.init(); await s.controller.init(); old.resolve([]); await first;
    expect(s.state().results[0].path).toBe("New"); expect(s.state().currentSubdirs).toEqual([]);
    expect(s.reportError).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("retires pending %s on disposal without affecting a replacement owner", async outcome => {
    const old = deferred(); const s = setup(); s.loadNotes.mockReturnValueOnce(old.promise);
    const first = s.controller.init(); s.controller.dispose?.();
    const replacement = setup(); replacement.loadNotes.mockResolvedValue([{ path: "Replacement" }]);
    await replacement.controller.init();
    if (outcome === "success") old.resolve([{ path: "Old" }]); else old.reject(new Error("retired"));
    await first;
    expect(s.state().results).toEqual([]); expect(s.state().load.status).toBe("loading");
    expect(s.reportError).not.toHaveBeenCalled(); expect(replacement.state().results[0].path).toBe("Replacement");
  });

  it("does not start a new query after disposal", async () => {
    const s = setup(); s.controller.dispose?.(); await s.controller.init();
    await s.controller.toggleNested();
    expect(s.preferences.setIncludeNested).not.toHaveBeenCalled();
    expect(s.loadNotes).not.toHaveBeenCalled();
  });
});
