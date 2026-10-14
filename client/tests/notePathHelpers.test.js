import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { params } from "../constants.js";
import { directoryFromPath } from "../helpers.js";
import {
  basenameOf,
  decodeRewriteFiles,
  encodeRewriteFiles,
  folderSearchTarget,
  joinNotePath,
  newNoteTarget,
  pathBreadcrumbs,
} from "../notePath.js";

function searchRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/_/search", name: "search", component: {} }],
  });
}

function routedRewriteFiles(files) {
  const link = `/_/search?${params.searchTerm}=*&rewriteFiles=${encodeRewriteFiles(files)}`;
  return searchRouter().resolve(link).query.rewriteFiles;
}

describe("basenameOf", () => {
  it.each([
    ["", ""],
    ["Root note", "Root note"],
    ["folder/nested/笔记 %2F", "笔记 %2F"],
    ["/note", "note"],
    ["folder/", ""],
  ])("takes the literal final segment of %s", (path, expected) => {
    expect(basenameOf(path)).toBe(expected);
  });
});

describe("joinNotePath", () => {
  it.each([
    ["", "Untitled", "Untitled"],
    [undefined, "Untitled", "Untitled"],
    ["folder/nested", "笔记 %2F", "folder/nested/笔记 %2F"],
    ["folder", "", "folder/"],
    ["folder/", "../note", "folder//../note"],
  ])("joins %s and %s without normalizing", (folder, basename, expected) => {
    expect(joinNotePath(folder, basename)).toBe(expected);
  });
});

describe("pathBreadcrumbs", () => {
  it("has no breadcrumbs for the root", () => {
    expect(pathBreadcrumbs("")).toEqual([]);
  });

  it("retains cumulative folder targets for short paths", () => {
    expect(pathBreadcrumbs("a/笔记/c")).toEqual([
      { label: "a", folder: "a" },
      { label: "笔记", folder: "a/笔记" },
      { label: "c", folder: "a/笔记/c" },
    ]);
  });

  it("retains all sections at the exact 60-character boundary", () => {
    const a = "a".repeat(52);
    expect(pathBreadcrumbs(`${a}/b/c/d/e`)).toEqual([
      { label: a, folder: a },
      { label: "b", folder: `${a}/b` },
      { label: "c", folder: `${a}/b/c` },
      { label: "d", folder: `${a}/b/c/d` },
      { label: "e", folder: `${a}/b/c/d/e` },
    ]);
  });

  it("keeps two sections each side of an unlinked ellipsis above 60 characters", () => {
    const a = "a".repeat(53);
    expect(pathBreadcrumbs(`${a}/b/c/d/e`)).toEqual([
      { label: a, folder: a },
      { label: "b", folder: `${a}/b` },
      { ellipsis: true },
      { label: "d", folder: `${a}/b/c/d` },
      { label: "e", folder: `${a}/b/c/d/e` },
    ]);
  });

  it("preserves the existing overlapping sections for long shallow folders", () => {
    const a = "a".repeat(61);
    expect(pathBreadcrumbs(`${a}/b`)).toEqual([
      { label: a, folder: a },
      { label: "b", folder: `${a}/b` },
      { ellipsis: true },
      { label: a, folder: a },
      { label: "b", folder: `${a}/b` },
    ]);
  });
});

describe("folderSearchTarget", () => {
  it("browses the selected folder with the wildcard term", () => {
    expect(folderSearchTarget("folder/笔记")).toEqual({
      name: "search",
      query: { [params.searchTerm]: "*", [params.folder]: "folder/笔记" },
    });
  });

  it("retains the search term, sort and caller query without mutating it", () => {
    const query = { [params.searchTerm]: "#tag", [params.sortBy]: 0 };
    expect(folderSearchTarget("folder/sub", query)).toEqual({
      name: "search",
      query: { ...query, [params.folder]: "folder/sub" },
    });
    expect(query).toEqual({ [params.searchTerm]: "#tag", [params.sortBy]: 0 });
  });

  it("omits the folder key when moving up from a top-level folder", () => {
    const query = { [params.searchTerm]: "#tag", [params.sortBy]: undefined };
    expect(folderSearchTarget(directoryFromPath("folder") || undefined, query)).toEqual({
      name: "search",
      query,
    });
    expect(folderSearchTarget(directoryFromPath("folder/sub"), query).query).toEqual({
      ...query,
      [params.folder]: "folder",
    });
  });

  it("distinguishes an explicit empty folder from an omitted folder", () => {
    expect(folderSearchTarget("").query).toEqual({ [params.searchTerm]: "*", [params.folder]: "" });
    expect(folderSearchTarget().query).toEqual({ [params.searchTerm]: "*" });
  });
});

describe("newNoteTarget", () => {
  it("uses a missing wikilink path literally, ahead of any route context", () => {
    expect(newNoteTarget({ path: "folder/Missing %2F", route: { name: "search", query: { folder: "other" } } })).toEqual({
      name: "new",
      query: { path: "folder/Missing %2F" },
    });
    expect(newNoteTarget({ path: undefined })).toEqual({ name: "new", query: { path: undefined } });
  });

  it("creates beside the note being viewed", () => {
    expect(newNoteTarget({ route: { name: "note", params: { path: "folder/nested/Note" } } })).toEqual({
      name: "new",
      query: { folder: "folder/nested" },
    });
  });

  it("uses the search folder without carrying the term or sort", () => {
    expect(newNoteTarget({ route: { name: "search", query: { folder: "folder/sub", term: "#tag", sortBy: 2 } } })).toEqual({
      name: "new",
      query: { folder: "folder/sub" },
    });
  });

  it.each([
    undefined,
    { name: "home" },
    { name: "new", query: { folder: "ignored" } },
    { name: "search", query: {} },
    { name: "search", query: { folder: "" } },
    { name: "note", params: { path: "Root note" } },
    { name: "note", params: { path: "" } },
  ])("creates at the root for route %j", (route) => {
    expect(newNoteTarget({ route })).toEqual({ name: "new" });
  });
});

describe("rewrite file URL boundary", () => {
  it("encodes JSON once for a raw query string", () => {
    const files = [{ oldPath: "folder/A + B", newPath: "moved/笔记" }];
    const raw = routedRewriteFiles(files);
    expect(encodeRewriteFiles(files)).toBe(encodeURIComponent(JSON.stringify(files)));
    expect(raw).toBe(JSON.stringify(files));
    expect(decodeRewriteFiles(raw)).toEqual(files);
  });

  it.each([undefined, null, "", "{invalid", "%"])("retains the empty fallback for absent or malformed query %s", (raw) => {
    expect(decodeRewriteFiles(raw)).toEqual([]);
  });

  it("preserves literal percent escapes after router decoding", () => {
    const files = [{ oldPath: "folder/literal%2Fname", newPath: "moved/literal%25name" }];
    const raw = routedRewriteFiles(files);
    expect(raw).toBe(JSON.stringify(files));
    expect(decodeRewriteFiles(raw)).toEqual(files);
  });

  it("preserves valid JSON containing a lone percent", () => {
    const files = [{ oldPath: "folder/100%", newPath: "moved/100%" }];
    const raw = routedRewriteFiles(files);
    expect(JSON.parse(raw)).toEqual(files);
    expect(decodeRewriteFiles(raw)).toEqual(files);
  });

  it.each(["%20", "%2F", "%25", "%22", "%5C", "%zz", "笔记 + # & ?", "a\"b\\c"])("round-trips the literal path segment %s through the router query consumer", (segment) => {
    const files = [{ oldPath: `before/${segment}`, newPath: `after/${segment}` }];
    expect(decodeRewriteFiles(routedRewriteFiles(files))).toEqual(files);
  });
});
