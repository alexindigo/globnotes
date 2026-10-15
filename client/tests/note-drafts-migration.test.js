import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoteDraftStore } from "../noteDrafts.js";
import { getStoredToken, isCurrentTokenStored, storeToken } from "../tokenStorage.js";

const appKeys = [
  "token", "defaultEditorMode", "expandedFolders", "sidebarRecent",
  "sidebarVisible", "sidebarPinned", "includeNested", "autoEnablePlugins",
  "pluginSwitches", "viewLineNumbers", "debug", "globnotes-theme",
  "globnotes-keybindings", "globnotes-keybindings-custom",
];
const key = path => `globnotes:draft:${path}`;

describe("draft namespace and legacy migration", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it.each([false, true])("editing a note named token preserves authentication (remembered=%s)", persist => {
    storeToken("auth-token", persist);
    const drafts = createNoteDraftStore();
    expect(drafts.load("token", 0)).toBeNull();
    drafts.save("token", "user work", 1);
    expect(getStoredToken()).toBe("auth-token");
    expect(isCurrentTokenStored()).toBe(persist);
    expect((persist ? localStorage : sessionStorage).getItem(key("token"))).toBe("user work");
    expect(drafts.load("token", 1)).toBe("user work");
    drafts.clear();
    expect(getStoredToken()).toBe("auth-token");
    expect(localStorage.getItem("token")).toBe(persist ? "auth-token" : null);
  });

  it.each(appKeys)("never reads, migrates, overwrites or clears the app-owned key %s", path => {
    localStorage.setItem(path, "local app bytes");
    sessionStorage.setItem(path, "session app bytes");
    const drafts = createNoteDraftStore({ isTokenStored: () => true });
    expect(drafts.load(path, 0)).toBeNull();
    drafts.save(path, "local draft", 1);
    drafts.clearAcknowledged(1);
    createNoteDraftStore({ isTokenStored: () => false }).save(path, "session draft", 2);
    expect(drafts.load(path, 2)).toBe("session draft");
    drafts.clear();
    expect(localStorage.getItem(path)).toBe("local app bytes");
    expect(sessionStorage.getItem(path)).toBe("session app bytes");
  });

  it.each(["local", "session"])("moves a legacy %s draft exactly once, retaining its literal bytes", backend => {
    const storage = backend === "local" ? localStorage : sessionStorage;
    const path = "folder/Café 100% #note";
    const content = "\n# Literal\r\n\nunsaved %2F work\n";
    storage.setItem(path, content);
    const drafts = createNoteDraftStore();
    expect(drafts.load(path, 3)).toBe(content);
    expect(storage.getItem(key(path))).toBe(content);
    expect(storage.getItem(path)).toBeNull();
    const write = vi.spyOn(storage, "setItem");
    expect(createNoteDraftStore().load(path, 4)).toBe(content);
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    drafts.clearAcknowledged(3);
    expect(storage.getItem(key(path))).toBeNull();
  });

  it("migrates both backends independently and retains local-first selection", () => {
    localStorage.setItem("Note", "local legacy");
    sessionStorage.setItem("Note", "session legacy");
    const drafts = createNoteDraftStore();
    expect(drafts.load("Note", 1)).toBe("local legacy");
    expect(localStorage.getItem(key("Note"))).toBe("local legacy");
    expect(sessionStorage.getItem(key("Note"))).toBe("session legacy");
    expect(localStorage.getItem("Note")).toBeNull();
    expect(sessionStorage.getItem("Note")).toBeNull();
    drafts.clear();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("preserves an empty legacy draft", () => {
    sessionStorage.setItem("Note", "");
    expect(createNoteDraftStore().load("Note", 1)).toBe("");
    expect(sessionStorage.getItem(key("Note"))).toBe("");
    expect(sessionStorage.getItem("Note")).toBeNull();
  });

  it.each(["local", "session"])("keeps both drafts when the %s destination is already occupied", backend => {
    const storage = backend === "local" ? localStorage : sessionStorage;
    storage.setItem("Note", "legacy work");
    storage.setItem(key("Note"), "namespaced work");
    const drafts = createNoteDraftStore();
    expect(drafts.load("Note", 1)).toBe("namespaced work");
    drafts.clear();
    expect(storage.getItem(key("Note"))).toBeNull();
    expect(storage.getItem("Note")).toBe("legacy work");
  });

  it("does not adopt another draft namespace entry as a legacy note path", () => {
    sessionStorage.setItem(key("Note"), "Note's draft");
    const drafts = createNoteDraftStore();
    expect(drafts.load(key("Note"), 0)).toBeNull();
    drafts.save(key("Note"), "distinct work", 1);
    expect(drafts.load(key("Note"), 1)).toBe("distinct work");
    drafts.clear();
    expect(sessionStorage.getItem(key("Note"))).toBe("Note's draft");
  });

  it("migrates app-like note names that are not app-owned keys", () => {
    for (const path of ["globnotes-my-note", "folder/token"]) {
      sessionStorage.setItem(path, "legacy work");
      expect(createNoteDraftStore().load(path, 0)).toBe("legacy work");
      expect(sessionStorage.getItem(key(path))).toBe("legacy work");
      expect(sessionStorage.getItem(path)).toBeNull();
    }
  });

  it("keeps legacy bytes when the migration copy fails", () => {
    const values = new Map([["Note", "legacy work"]]);
    const storage = {
      getItem: name => values.get(name) ?? null,
      setItem: () => { throw new Error("quota"); },
      removeItem: name => values.delete(name),
    };
    const drafts = createNoteDraftStore({ local: storage, session: storage });
    expect(() => drafts.load("Note", 1)).toThrow("quota");
    expect(values.get("Note")).toBe("legacy work");
  });

  it("does not remove a legacy draft whose bytes changed during the copy", () => {
    const values = new Map([["Note", "legacy work"]]);
    const storage = {
      getItem: name => values.get(name) ?? null,
      setItem: (name, value) => { values.set(name, value); values.set("Note", "newer legacy work"); },
      removeItem: name => values.delete(name),
    };
    expect(createNoteDraftStore({ local: storage, session: storage }).load("Note", 1)).toBe("legacy work");
    expect(values.get("Note")).toBe("newer legacy work");
    expect(values.get(key("Note"))).toBe("legacy work");
  });
});
