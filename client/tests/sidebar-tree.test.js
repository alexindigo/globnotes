import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

vi.mock("../api.js", () => ({ getTree: vi.fn(), getNotes: vi.fn() }));
vi.mock("../noteIndex.js", () => ({ refreshNoteIndex: vi.fn() }));

import { getTree, getNotes } from "../api.js";
import { TOPICS } from "../bus/index.js";
import { createSidebarTree } from "../sidebarTree.js";

const empty = () => ({ folders: [], notes: [] });
const folder = path => ({ name: path.split("/").at(-1), path });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture({ expanded = [], recent = false, paths = ["Indexed"], ...overrides } = {}) {
  const preferences = {
    expandedFolders: ref(new Set(expanded)), sidebarRecent: ref(recent),
    sidebarVisible: ref(false), sidebarPinned: ref(false),
  };
  preferences.setExpandedFolders = vi.fn(value => { preferences.expandedFolders.value = new Set(value); });
  preferences.setSidebarRecent = vi.fn(value => { preferences.sidebarRecent.value = value; });
  preferences.setSidebarVisible = vi.fn(value => { preferences.sidebarVisible.value = value; });
  preferences.setSidebarPinned = vi.fn(value => { preferences.sidebarPinned.value = value; });
  const titles = ref(paths), listeners = new Map();
  const subscribe = vi.fn((topic, handler) => {
    listeners.set(topic, handler);
    return vi.fn(() => listeners.delete(topic));
  });
  const loadTree = vi.fn().mockResolvedValue(empty());
  const loadNotes = vi.fn().mockResolvedValue([]);
  const refreshIndex = vi.fn();
  const controller = createSidebarTree({
    preferences, notePaths: () => titles.value, subscribe, loadTree, loadNotes, refreshIndex, ...overrides,
  });
  return { ...controller, preferences, titles, listeners, subscribe, loadTree, loadNotes, refreshIndex };
}

describe("sidebar tree controller", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts without transport and loads nothing when hidden", () => {
    const sidebar = fixture();
    sidebar.visibilityChanged(false);
    expect(sidebar.loadTree).not.toHaveBeenCalled();
    expect(sidebar.loadNotes).not.toHaveBeenCalled();
    expect(sidebar.snapshot()).toMatchObject({
      visibleRows: [], recentNotes: [], filterText: "", filterVisible: false,
      canCollapse: false, activePath: null, recentEnabled: false, showSectionTitles: false,
    });
  });

  it("hydrates root and persisted expanded levels, preserving their order", async () => {
    const sidebar = fixture({ expanded: ["A", "A/B"] });
    sidebar.visibilityChanged(true);
    expect(sidebar.loadTree.mock.calls).toEqual([[""], ["A"], ["A/B"]]);
    await flush();
    sidebar.visibilityChanged(true);
    expect(sidebar.loadTree).toHaveBeenCalledTimes(3);
    expect(sidebar.preferences.setExpandedFolders).not.toHaveBeenCalled();
  });

  it.each([null, []])("refreshes an empty index on opening (%s)", paths => {
    const sidebar = fixture({ paths });
    sidebar.visibilityChanged(true);
    expect(sidebar.refreshIndex).toHaveBeenCalledOnce();
  });

  it("does not refresh a populated index", () => {
    const sidebar = fixture();
    sidebar.visibilityChanged(true);
    expect(sidebar.refreshIndex).not.toHaveBeenCalled();
  });

  it("walks sorted folders before sorted filename-only notes with stable keys and depths", async () => {
    const levels = {
      "": { folders: [folder("Z"), folder("A")], notes: ["z-root", { path: "a-root", title: "Ignore H1" }] },
      A: { folders: [folder("A/B")], notes: ["A/z-note", "A/a-note"] },
      "A/B": { folders: [], notes: ["A/B/deep"] },
      Z: { folders: [], notes: ["Z/last"] },
    };
    const sidebar = fixture({ expanded: ["A", "A/B"], loadTree: async path => levels[path] });
    sidebar.visibilityChanged(true);
    await flush();
    expect(sidebar.snapshot().visibleRows.map(row => [row.key, row.depth, row.expanded])).toEqual([
      ["f:A", 0, true], ["f:A/B", 1, true], ["n:A/B/deep", 2, undefined],
      ["n:A/a-note", 1, undefined], ["n:A/z-note", 1, undefined], ["f:Z", 0, false],
      ["n:a-root", 0, undefined], ["n:z-root", 0, undefined],
    ]);
    expect(sidebar.snapshot().visibleRows.at(-2).note).toEqual({ path: "a-root", name: "a-root" });
    expect(levels[""].folders.map(value => value.path)).toEqual(["Z", "A"]);
  });

  it("fetches folder children on demand, then reuses the cached level after collapse", async () => {
    const sidebar = fixture();
    sidebar.loadTree.mockImplementation(async path => path ? { folders: [], notes: ["A/child"] } : { folders: [folder("A")], notes: [] });
    sidebar.visibilityChanged(true);
    await flush();
    expect(sidebar.loadTree.mock.calls).toEqual([[""]]);
    await sidebar.toggleFolder("A");
    expect(sidebar.snapshot().visibleRows.map(row => row.key)).toEqual(["f:A", "n:A/child"]);
    expect(sidebar.snapshot().canCollapse).toBe(true);
    await sidebar.toggleFolder("A");
    expect(sidebar.snapshot().visibleRows.map(row => row.key)).toEqual(["f:A"]);
    await sidebar.toggleFolder("A");
    expect(sidebar.loadTree.mock.calls).toEqual([[""], ["A"]]);
  });

  it("caches a failed level as empty until invalidation", async () => {
    const sidebar = fixture();
    sidebar.loadTree.mockRejectedValue(Error("offline"));
    sidebar.visibilityChanged(true);
    await flush();
    sidebar.visibilityChanged(true);
    expect(sidebar.loadTree).toHaveBeenCalledOnce();
    expect(sidebar.snapshot().visibleRows).toEqual([]);
    sidebar.listeners.get(TOPICS.NOTE_CREATE)({ path: "Created" });
    expect(sidebar.loadTree).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("filters the full index case-insensitively by whole path and forces ancestor expansion", () => {
    const sidebar = fixture({ paths: ["Z/skip", "A/deep/MATCH", "a-root", "A/other"] });
    sidebar.setFilterText("  match  ");
    expect(sidebar.snapshot().visibleRows.map(row => [row.key, row.depth])).toEqual([
      ["f:A", 0], ["f:A/deep", 1], ["n:A/deep/MATCH", 2],
    ]);
    sidebar.setFilterText("a/");
    expect(sidebar.snapshot().visibleRows.map(row => row.key)).toEqual([
      "f:A", "f:A/deep", "n:A/deep/MATCH", "n:A/other",
    ]);
    expect(sidebar.loadTree).not.toHaveBeenCalled();
    expect(sidebar.preferences.expandedFolders.value.size).toBe(0);
  });

  it("reacts to full-index updates while filtering", () => {
    const sidebar = fixture({ paths: ["A/match"] });
    sidebar.setFilterText("match");
    expect(sidebar.snapshot().visibleRows.map(row => row.key)).toEqual(["f:A", "n:A/match"]);
    sidebar.titles.value = ["B/match"];
    expect(sidebar.snapshot().visibleRows.map(row => row.key)).toEqual(["f:B", "n:B/match"]);
  });

  it("keeps filter-only collapse separate from persistent expansion and resets on clearing", async () => {
    const sidebar = fixture({ expanded: ["saved"], paths: ["A/match"] });
    sidebar.setFilterText("match");
    await sidebar.toggleFolder("A");
    expect(sidebar.snapshot().visibleRows.map(row => row.key)).toEqual(["f:A"]);
    await sidebar.toggleFolder("A");
    expect(sidebar.snapshot().visibleRows).toHaveLength(2);
    await sidebar.toggleFolder("A");
    sidebar.setFilterText("   ");
    sidebar.setFilterText("match");
    expect(sidebar.snapshot().visibleRows).toHaveLength(2);
    expect([...sidebar.preferences.expandedFolders.value]).toEqual(["saved"]);
    expect(sidebar.preferences.setExpandedFolders).not.toHaveBeenCalled();
  });

  it("hides the filter by clearing text and temporary collapse", async () => {
    const sidebar = fixture({ paths: ["A/match"] });
    sidebar.toggleFilter();
    expect(sidebar.snapshot().filterVisible).toBe(true);
    sidebar.setFilterText("match");
    await sidebar.toggleFolder("A");
    sidebar.toggleFilter();
    expect(sidebar.snapshot()).toMatchObject({ filterVisible: false, filterText: "" });
    sidebar.setFilterText("match");
    expect(sidebar.snapshot().visibleRows).toHaveLength(2);
  });

  it("collapse all persists empty expansion even while filtering", () => {
    const sidebar = fixture({ expanded: ["A"], paths: ["A/match"] });
    sidebar.setFilterText("match");
    sidebar.collapseAll();
    expect(sidebar.preferences.setExpandedFolders).toHaveBeenCalledWith([]);
    expect(sidebar.snapshot().canCollapse).toBe(false);
    expect(sidebar.snapshot().visibleRows[0].expanded).toBe(true);
  });

  it("loads and expands every active-note ancestor sequentially, even while hidden", async () => {
    const sidebar = fixture({ expanded: ["saved"] });
    const pending = sidebar.setActivePath("A/B/Note");
    expect(sidebar.snapshot().activePath).toBe("A/B/Note");
    expect(sidebar.loadTree.mock.calls).toEqual([["A"]]);
    await pending;
    expect(sidebar.loadTree.mock.calls).toEqual([["A"], ["A/B"]]);
    expect([...sidebar.preferences.expandedFolders.value]).toEqual(["saved", "A", "A/B"]);
    expect(sidebar.preferences.setExpandedFolders).toHaveBeenCalledOnce();
    await sidebar.setActivePath(null);
    expect(sidebar.snapshot().activePath).toBe(null);
    expect(sidebar.loadTree).toHaveBeenCalledTimes(2);
  });

  it("keeps an ancestor expanded when its level fails", async () => {
    const sidebar = fixture();
    sidebar.loadTree.mockRejectedValue(Error("offline"));
    await sidebar.setActivePath("A/Note");
    expect([...sidebar.preferences.expandedFolders.value]).toEqual(["A"]);
  });

  it("sorts Recent by last modification, limits to five and uses filenames", async () => {
    const sidebar = fixture({ recent: true });
    const notes = Array.from({ length: 7 }, (_, i) => ({ path: `folder/n${i}`, title: "Ignored title", lastModified: i }));
    sidebar.loadNotes.mockResolvedValue(notes);
    sidebar.visibilityChanged(true);
    await flush();
    expect(sidebar.loadNotes).toHaveBeenCalledExactlyOnceWith("*", undefined, undefined, undefined);
    expect(sidebar.snapshot().recentNotes).toEqual([6, 5, 4, 3, 2].map(i => ({ path: `folder/n${i}`, name: `n${i}` })));
    expect(sidebar.snapshot().showSectionTitles).toBe(true);
    expect(notes[0].path).toBe("folder/n0");
  });

  it("enables Recent through its preference owner before loading; disabling retains cached rows", async () => {
    const sidebar = fixture();
    sidebar.loadNotes.mockImplementation(async () => {
      expect(sidebar.preferences.sidebarRecent.value).toBe(true);
      return [{ path: "A/Recent", lastModified: 1 }];
    });
    sidebar.toggleRecent();
    await flush();
    sidebar.toggleRecent();
    expect(sidebar.preferences.setSidebarRecent.mock.calls).toEqual([[true], [false]]);
    expect(sidebar.loadNotes).toHaveBeenCalledOnce();
    expect(sidebar.snapshot()).toMatchObject({ recentEnabled: false, showSectionTitles: false, recentNotes: [{ path: "A/Recent", name: "Recent" }] });
  });

  it("clears Recent after a failed read", async () => {
    const sidebar = fixture({ recent: true });
    sidebar.loadNotes.mockResolvedValueOnce([{ path: "Old", lastModified: 1 }]).mockRejectedValueOnce(Error("offline"));
    sidebar.visibilityChanged(true);
    await flush();
    expect(sidebar.snapshot().recentNotes).toHaveLength(1);
    sidebar.visibilityChanged(true);
    await flush();
    expect(sidebar.snapshot().recentNotes).toEqual([]);
  });

  it.each([TOPICS.NOTE_CREATE, TOPICS.NOTE_RENAME, TOPICS.NOTE_DELETE])(
    "invalidates root and all expanded levels on %s, retaining expansion and refreshing Recent", async topic => {
      const sidebar = fixture({ expanded: ["A"], recent: true });
      sidebar.loadTree.mockResolvedValue({ folders: [], notes: ["Old"] });
      sidebar.visibilityChanged(true);
      await flush();
      sidebar.loadTree.mockResolvedValue({ folders: [], notes: ["New"] });
      sidebar.listeners.get(topic)({ path: "changed" });
      expect(sidebar.snapshot().visibleRows).toEqual([]);
      expect(sidebar.loadTree.mock.calls).toEqual([[""], ["A"], [""], ["A"]]);
      await flush();
      expect(sidebar.snapshot().visibleRows.map(row => row.key)).toEqual(["n:New"]);
      expect([...sidebar.preferences.expandedFolders.value]).toEqual(["A"]);
      expect(sidebar.loadNotes).toHaveBeenCalledTimes(2);
    },
  );

  it("invalidates even when hidden without requesting disabled Recent", async () => {
    const sidebar = fixture();
    sidebar.listeners.get(TOPICS.NOTE_DELETE)({ path: "Deleted" });
    await flush();
    expect(sidebar.loadTree).toHaveBeenCalledExactlyOnceWith("");
    expect(sidebar.loadNotes).not.toHaveBeenCalled();
    expect(sidebar.subscribe.mock.calls.map(([topic]) => topic)).toEqual([TOPICS.NOTE_CREATE, TOPICS.NOTE_RENAME, TOPICS.NOTE_DELETE]);
  });

  it("delegates open/close and pinning to the same preference setters", () => {
    const sidebar = fixture();
    sidebar.openSidebar();
    expect(sidebar.snapshot().sidebarVisible).toBe(true);
    sidebar.closeSidebar();
    expect(sidebar.snapshot().sidebarVisible).toBe(false);
    sidebar.togglePin();
    expect(sidebar.snapshot().sidebarPinned).toBe(true);
    sidebar.togglePin();
    expect(sidebar.snapshot().sidebarPinned).toBe(false);
    expect(sidebar.preferences.setSidebarVisible.mock.calls).toEqual([[true], [false]]);
    expect(sidebar.preferences.setSidebarPinned.mock.calls).toEqual([[true], [false]]);
  });

  it("binds default transport adapters without a view importing transport", async () => {
    getTree.mockResolvedValue({ folders: [], notes: ["Default"] });
    getNotes.mockResolvedValue([{ path: "Default", lastModified: 1 }]);
    const sidebar = fixture({ recent: true, loadTree: undefined, loadNotes: undefined });
    sidebar.visibilityChanged(true);
    await flush();
    expect(getTree).toHaveBeenCalledWith("");
    expect(getNotes).toHaveBeenCalledWith("*", undefined, undefined, undefined);
    expect(sidebar.snapshot().visibleRows[0].note.name).toBe("Default");
    expect(sidebar.snapshot().recentNotes).toEqual([{ path: "Default", name: "Default" }]);
  });

  describe("level request ownership", () => {
    for (const path of ["", "A"]) {
      for (const order of ["old-first", "new-first"]) {
        it.each(["success", "failure"])(
          `fences obsolete %s for ${path || "root"} after invalidation (${order})`, async outcome => {
            const old = deferred(), fresh = deferred();
            let calls = 0;
            const sidebar = fixture({ expanded: ["A"], loadTree: requested => requested === path
              ? (++calls === 1 ? old.promise : fresh.promise)
              : Promise.resolve({ folders: [folder("A")], notes: [] }) });
            sidebar.visibilityChanged(true);
            sidebar.listeners.get(TOPICS.NOTE_RENAME)({ oldPath: "Old", newPath: "New" });
            const obsolete = () => outcome === "success"
              ? old.resolve({ folders: [], notes: ["Old"] }) : old.reject(Error("obsolete"));
            const rows = () => sidebar.snapshot().visibleRows.filter(row => row.type === "note").map(row => row.note.path);
            if (order === "old-first") {
              obsolete(); await flush();
              expect(rows()).toEqual([]);
            }
            fresh.resolve({ folders: [], notes: ["New"] });
            await flush();
            expect(rows()).toEqual(["New"]);
            if (order === "new-first") { obsolete(); await flush(); }
            expect(rows()).toEqual(["New"]);
          },
        );
      }
    }

    it.each(["open", "folder", "ancestor"])("accepts only the latest same-path request from %s", async origin => {
      const old = deferred(), fresh = deferred();
      const path = origin === "open" ? "" : "A";
      let calls = 0;
      const sidebar = fixture({ loadTree: requested => requested === path
        ? (++calls === 1 ? old.promise : fresh.promise)
        : Promise.resolve({ folders: [folder("A")], notes: [] }) });
      const request = () => origin === "open" ? sidebar.visibilityChanged(true)
        : origin === "folder" ? sidebar.toggleFolder("A") : sidebar.setActivePath("A/Note");
      if (origin !== "open") { sidebar.visibilityChanged(true); await flush(); }
      const first = request(), second = request();
      fresh.resolve({ folders: [], notes: ["New"] }); await second; await flush();
      old.resolve({ folders: [], notes: ["Old"] }); await first; await flush();
      expect(sidebar.snapshot().visibleRows.filter(row => row.type === "note").map(row => row.note.path)).toEqual(["New"]);
    });

    it("keeps simultaneous levels independent instead of using a global latest-request ticket", async () => {
      const root = deferred(), child = deferred();
      const sidebar = fixture({ expanded: ["A"], loadTree: path => path ? child.promise : root.promise });
      sidebar.visibilityChanged(true);
      child.resolve({ folders: [], notes: ["A/Child"] }); await flush();
      root.resolve({ folders: [folder("A")], notes: ["Root"] }); await flush();
      expect(sidebar.snapshot().visibleRows.map(row => row.key)).toEqual(["f:A", "n:A/Child", "n:Root"]);
    });
  });

  describe("controller lifetime", () => {
    it("releases every bus subscription exactly once and ignores queued retired delivery", async () => {
      const sidebar = fixture({ recent: true });
      const queued = [...sidebar.listeners.values()];
      sidebar.dispose?.();
      sidebar.dispose?.();
      expect(sidebar.listeners.size).toBe(0);
      for (const result of sidebar.subscribe.mock.results) expect(result.value).toHaveBeenCalledOnce();
      for (const handler of queued) handler({ path: "Changed" });
      await flush();
      expect(sidebar.loadTree).not.toHaveBeenCalled();
      expect(sidebar.loadNotes).not.toHaveBeenCalled();
    });

    for (const origin of ["open", "folder", "ancestor"]) {
      it.each(["success", "failure"])(`retires pending ${origin} levels on dispose (%s)`, async outcome => {
        const pending = deferred();
        const path = origin === "open" ? "" : "A";
        const sidebar = fixture({ loadTree: requested => requested === path
          ? pending.promise : Promise.resolve({ folders: [folder("A")], notes: [] }) });
        if (origin !== "open") { sidebar.visibilityChanged(true); await flush(); }
        const task = origin === "open" ? sidebar.visibilityChanged(true)
          : origin === "folder" ? sidebar.toggleFolder("A") : sidebar.setActivePath("A/B/Note");
        const before = sidebar.snapshot();
        sidebar.dispose?.();
        if (outcome === "success") pending.resolve({ folders: [], notes: ["Retired"] });
        else pending.reject(Error("retired"));
        await task; await flush();
        expect(sidebar.snapshot()).toEqual(before);
        expect(sidebar.preferences.setExpandedFolders).not.toHaveBeenCalled();
        expect([...sidebar.preferences.expandedFolders.value]).toEqual([]);
      });
    }

    it.each(["success", "failure"])("retains its last Recent snapshot after disposal (%s)", async outcome => {
      const pending = deferred();
      const sidebar = fixture({ recent: true });
      sidebar.loadNotes.mockResolvedValueOnce([{ path: "Existing", lastModified: 1 }]).mockReturnValueOnce(pending.promise);
      sidebar.visibilityChanged(true); await flush();
      sidebar.visibilityChanged(true);
      sidebar.dispose?.();
      if (outcome === "success") pending.resolve([{ path: "Retired", lastModified: 2 }]);
      else pending.reject(Error("retired"));
      await flush();
      expect(sidebar.snapshot().recentNotes).toEqual([{ path: "Existing", name: "Existing" }]);
    });

    it("rejects further intents after disposal without writing shared preferences", async () => {
      const sidebar = fixture({ expanded: ["A"], recent: true, paths: [] });
      const before = sidebar.snapshot();
      sidebar.dispose?.();
      sidebar.openSidebar(); sidebar.closeSidebar(); sidebar.togglePin();
      sidebar.toggleRecent(); sidebar.toggleFilter(); sidebar.setFilterText("retired");
      sidebar.collapseAll(); sidebar.visibilityChanged(true);
      await sidebar.setActivePath("A/Retired"); await sidebar.toggleFolder("B");
      expect(sidebar.snapshot()).toEqual(before);
      expect(sidebar.loadTree).not.toHaveBeenCalled();
      expect(sidebar.loadNotes).not.toHaveBeenCalled();
      expect(sidebar.refreshIndex).not.toHaveBeenCalled();
      for (const key of ["setExpandedFolders", "setSidebarRecent", "setSidebarVisible", "setSidebarPinned"]) {
        expect(sidebar.preferences[key]).not.toHaveBeenCalled();
      }
    });

    it("cannot retire a replacement controller's subscriptions or cache", async () => {
      const handlers = new Set();
      const subscribe = (_topic, handler) => { handlers.add(handler); return () => handlers.delete(handler); };
      const old = fixture({ subscribe }), current = fixture({ subscribe });
      old.dispose?.();
      current.loadTree.mockResolvedValue({ folders: [], notes: ["Current"] });
      for (const handler of handlers) handler({ path: "Created" });
      await flush();
      expect(old.loadTree).not.toHaveBeenCalled();
      expect(current.snapshot().visibleRows.map(row => row.key)).toEqual(["n:Current"]);
      old.dispose?.();
      expect(handlers.size).toBe(1);
      current.dispose?.();
      expect(handlers.size).toBe(0);
    });
  });
});
