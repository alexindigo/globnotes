import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiErrorHandler, getTags } from "../api.js";
import { publish, TOPICS } from "../bus/index.js";
import {
  createTagCompletion, searchTermChanged, wordOnCursor, wordOnCursorPosition,
} from "../tagCompletion.js";

vi.mock("../api.js", () => ({ getTags: vi.fn(), apiErrorHandler: vi.fn() }));
vi.mock("../bus/index.js", () => ({ publish: vi.fn(), TOPICS: { SEARCH_CHANGE: "search:change" } }));

beforeEach(() => { vi.clearAllMocks(); getTags.mockReset().mockResolvedValue(["apple", "apricot", "banana"]); });

describe("cursor word boundaries", () => {
  it.each([
    ["", 0, 0, 0, ""],
    ["#app", 0, 0, 4, "#app"],
    ["#app", 4, 0, 4, "#app"],
    ["one #app tail", 6, 4, 8, "#app"],
    ["one #app tail", 8, 4, 8, "#app"],
    ["one #app tail", 9, 9, 13, "tail"],
    ["one  #app", 4, 4, 4, ""],
    ["one\t#app", 6, 0, 8, "one\t#app"],
  ])("finds the space-delimited word in %j at %i", (text, cursor, start, end, word) => {
    expect(wordOnCursorPosition(text, cursor)).toEqual({ start, end });
    expect(wordOnCursor(text, cursor)).toBe(word);
  });
});

describe("tag completion owner", () => {
  it("lazily uses the default adapter, lowercases input and caches its tags", async () => {
    const completion = createTagCompletion();
    expect(completion.snapshot()).toEqual({ matches: [], index: 0, visible: false });
    await completion.update("ordinary", 8);
    expect(getTags).not.toHaveBeenCalled();
    await completion.update("one #AP rest", 7);
    expect(completion.snapshot()).toEqual({ matches: ["#apple", "#apricot"], index: 0, visible: true });
    await completion.update("#b", 2);
    expect(completion.snapshot().matches).toEqual(["#banana"]);
    expect(getTags).toHaveBeenCalledTimes(1);
  });

  it("uses injected transport/error handling and retains a failed empty cache", async () => {
    const error = new Error("offline"), toast = { add: vi.fn() };
    const loadTags = vi.fn().mockRejectedValue(error), reportError = vi.fn();
    const completion = createTagCompletion({ loadTags, reportError, toast });
    await completion.update("#a", 2);
    await completion.update("#b", 2);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(error, toast);
    expect(loadTags).toHaveBeenCalledTimes(1);
    expect(completion.snapshot().visible).toBe(false);
  });

  it("binds the default error adapter to the input's toast", async () => {
    const error = new Error("denied"), toast = {};
    getTags.mockRejectedValueOnce(error);
    await createTagCompletion({ toast }).update("#", 1);
    expect(apiErrorHandler).toHaveBeenCalledExactlyOnceWith(error, toast);
  });

  it("keeps cache lifetime local to each input", async () => {
    const first = createTagCompletion(), second = createTagCompletion();
    await first.update("#a", 2); await second.update("#b", 2);
    expect(getTags).toHaveBeenCalledTimes(2);
    expect(first.snapshot().matches).toEqual(["#apple", "#apricot"]);
    expect(second.snapshot().matches).toEqual(["#banana"]);
  });

  it("excludes exact tags and hides the menu when no longer matched", async () => {
    const completion = createTagCompletion();
    await completion.update("#apple", 6);
    expect(completion.snapshot().matches).toEqual([]);
    await completion.update("#ap", 3);
    await completion.update("#z", 2);
    expect(completion.snapshot()).toEqual({ matches: [], index: 0, visible: false });
  });

  it("clamps selection, retains it at equal match count and resets it on count change", async () => {
    const completion = createTagCompletion();
    await completion.update("#ap", 3);
    expect(completion.move(-1)).toBe(0);
    expect(completion.move(1)).toBe(1);
    expect(completion.move(1)).toBe(1);
    await completion.update("#a", 2);
    expect(completion.snapshot().index).toBe(1);
    await completion.update("#b", 2);
    expect(completion.snapshot()).toEqual({ matches: ["#banana"], index: 0, visible: true });
  });

  it("preserves equal-count hiding after dismissal", async () => {
    const completion = createTagCompletion();
    await completion.update("#ap", 3); completion.move(1); completion.hide();
    await completion.update("#a", 2);
    expect(completion.snapshot()).toEqual({ matches: ["#apple", "#apricot"], index: 1, visible: false });
  });

  it.each([false, true])("preserves non-tag clearing policy %s", async clearOnNonTag => {
    const completion = createTagCompletion({ clearOnNonTag });
    await completion.update("#ap", 3); completion.move(1);
    await completion.update("text", 4);
    expect(completion.snapshot()).toEqual({ matches: clearOnNonTag ? [] : ["#apple", "#apricot"], index: 1, visible: false });
    await completion.update("#ap", 3);
    expect(completion.snapshot().visible).toBe(clearOnNonTag);
    expect(completion.snapshot().index).toBe(clearOnNonTag ? 0 : 1);
  });

  it("replaces only the cursor word and hides without clearing matches", async () => {
    const completion = createTagCompletion();
    await completion.update("one #ap tail #b", 6);
    expect(completion.choose("one #ap tail #b", 6, "#apple")).toBe("one #apple tail #b");
    expect(completion.snapshot()).toEqual({ matches: ["#apple", "#apricot"], index: 0, visible: false });
  });
});

it("publishes one unchanged SEARCH_CHANGE payload per term notification", () => {
  for (const term of ["typed", "#apple", "*", "", "from props"]) searchTermChanged(term);
  expect(publish.mock.calls).toEqual(["typed", "#apple", "*", "", "from props"].map(term => [TOPICS.SEARCH_CHANGE, { term }]));
});
