// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQuickAccess, homeSearchTarget, quickAccessQuery, quickAccessTarget } from "../quickAccess.js";
import { apiErrorHandler, getNotes } from "../api.js";
import { params, searchSortOptions } from "../constants.js";

vi.mock("../api.js", () => ({ getNotes: vi.fn(), apiErrorHandler: vi.fn() }));

const config = { quickAccessTerm: "#inbox", quickAccessSort: "lastModified", quickAccessLimit: 4 };

describe("Home quick access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defers missing config and skips a hidden section without changing load state", async () => {
    let current = {};
    const loadNotes = vi.fn();
    const controller = createQuickAccess({ config: () => current, loadNotes });
    await controller.init();
    current = { ...config, quickAccessHide: true };
    await controller.init();
    expect(loadNotes).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ notes: [], loaded: false, load: { status: "loading" } });
  });

  it.each(["title", "path", "score", "lastModified", undefined])("keeps the original order policy for %s", (sort) => {
    expect(quickAccessQuery({ ...config, quickAccessSort: sort }))
      .toEqual(["#inbox", sort, sort === "title" ? "asc" : "desc", 5]);
  });

  it("requests one extra row even at a zero limit", () => {
    expect(quickAccessQuery({ ...config, quickAccessLimit: 0 })).toEqual(["#inbox", "lastModified", "desc", 1]);
  });

  it("loads through the default adapter after config arrives and exposes all rows", async () => {
    let current = {};
    const rows = [{ path: "A" }, { path: "B" }];
    getNotes.mockResolvedValueOnce(rows);
    const controller = createQuickAccess({ config: () => current });
    await controller.init();
    current = config;
    await controller.init();
    expect(getNotes).toHaveBeenCalledExactlyOnceWith("#inbox", "lastModified", "desc", 5);
    expect(controller.snapshot()).toMatchObject({ notes: rows, loaded: true, load: { status: "loaded" } });
  });

  it("reports a load error while retaining earlier rows and marking the surface failed", async () => {
    const error = new Error("offline");
    const toast = { add: vi.fn() };
    getNotes.mockResolvedValueOnce([{ path: "Saved" }]).mockRejectedValueOnce(error);
    const controller = createQuickAccess({ config: () => config, toast });
    await controller.init();
    await controller.init();
    expect(controller.snapshot()).toMatchObject({ notes: [{ path: "Saved" }], loaded: true, load: { status: "failed" } });
    expect(apiErrorHandler).toHaveBeenCalledExactlyOnceWith(error, toast);
  });

  it("exposes loaded empty results for the empty-vault greeting", async () => {
    const controller = createQuickAccess({ config: () => config, loadNotes: vi.fn().mockResolvedValue([]) });
    await controller.init();
    expect(controller.snapshot()).toMatchObject({ notes: [], loaded: true, load: { status: "loaded" } });
  });

  it("builds Show more with the configured term and numeric route sort", () => {
    expect(quickAccessTarget(config)).toEqual({ name: "search", query: { [params.searchTerm]: "#inbox", [params.sortBy]: searchSortOptions.lastModified } });
  });

  it("keeps an unknown sort unmapped in Show more", () => {
    expect(quickAccessTarget({ ...config, quickAccessSort: "title" }).query[params.sortBy]).toBeUndefined();
  });

  it("trims submitted search text and ignores empty searches", () => {
    expect(homeSearchTarget(" \n ")).toBeNull();
    expect(homeSearchTarget("  a #tag  ")).toEqual({ name: "search", query: { [params.searchTerm]: "a #tag" } });
  });
});
