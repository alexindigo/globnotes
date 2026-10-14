import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { appRelativePath, notePath } from "../notePath.js";

describe("document-to-router URL boundary", () => {
  it.each([
    ["", "/Seed"],
    ["/", "/Folder/Seed"],
    ["/notes", "/Seed"],
    ["/notes/", "/Folder/My%20note"],
    ["/notes", "/notes/Seed"],
    ["/notes", "/Folder/%E7%AC%94%E8%AE%B0%2Fpart"],
  ])("preserves literal document URL with base %s and note path %s", (base, path) => {
    const router = createRouter({ history: createMemoryHistory(base), routes: [{ path: "/:path(.*)", component: {} }] });
    const prefix = router.options.history.base.replace(/\/$/, "");
    const documentPath = prefix + path;
    const route = appRelativePath(documentPath, router.options.history.base);
    expect(router.resolve(route + "?x=one&x=two#source:L4").href).toBe(documentPath + "?x=one&x=two#source:L4");
    expect(router.resolve(route + "?x=one&x=two").href).toBe(documentPath + "?x=one&x=two");
  });

  it("strips only the exact configured segment boundary", () => {
    expect(appRelativePath("/notes-other/Seed", "/notes")).toBe("/notes-other/Seed");
    expect(appRelativePath("/notes", "/notes")).toBe("/");
    expect(appRelativePath("/notes/notes/Seed", "/notes")).toBe("/notes/Seed");
  });

  it("retains the existing per-segment note encoding", () => {
    expect(notePath("Folder/My note/笔记")).toBe("/Folder/My%20note/%E7%AC%94%E8%AE%B0");
  });
});
