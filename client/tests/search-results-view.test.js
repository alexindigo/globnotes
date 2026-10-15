// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import SearchResults from "../views/SearchResults.vue";
import { getNotes, rewriteRefs } from "../api.js";
import { includeNested } from "../searchPreferences.js";
import { params, searchSortOptions } from "../constants.js";
import { publish, TOPICS } from "../bus/index.js";

const { toast } = vi.hoisted(() => ({ toast: { add: vi.fn() } }));
vi.mock("primevue/usetoast", () => ({ useToast: () => toast }));
vi.mock("../api.js", () => ({ getNotes: vi.fn(), rewriteRefs: vi.fn(), apiErrorHandler: vi.fn() }));
vi.mock("../bus/index.js", async importOriginal => ({ ...await importOriginal(), publish: vi.fn() }));

enableAutoUnmount(afterEach);

async function render(props = {}, query = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/_/search", name: "search", component: { template: "<p>Search</p>" } },
    { path: "/:path(.*)", name: "note", component: { template: "<p>Note</p>" } },
  ] });
  await router.push({ name: "search", query }); await router.isReady();
  const wrapper = mount(SearchResults, { props: { searchTerm: "word", ...props }, global: {
    plugins: [router],
    stubs: {
      SearchInput: { props: ["initialSearchTerm"], template: '<input :value="initialSearchTerm">' },
      PrimeMenu: { props: ["model"], template: '<div><button v-for="item in model" @click="item.command()">{{item.label}}</button></div>' },
    },
  } });
  await flushPromises();
  return { wrapper, router };
}

describe("SearchResults controller wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks(); includeNested.value = true;
    getNotes.mockReset().mockResolvedValue([]); rewriteRefs.mockReset().mockResolvedValue(undefined);
  });

  it("renders sorted titles/highlights, watches input and resorts without a fetch", async () => {
    getNotes.mockResolvedValue([
      { path: "F/Z", title: "Display Z", score: 9, lastModifiedAsString: "Today", contentHighlights: "<b>hit</b>" },
      { path: "F/A", pathHighlights: "<em>Highlighted A</em>", score: 1 },
    ]);
    const { wrapper } = await render({ folder: "F" });
    expect(wrapper.find('a[href="/F/Z"]').text()).toContain("Display Z");
    expect(wrapper.find('a[href="/F/Z"] b').text()).toBe("hit");
    expect(wrapper.find('a[href="/F/A"] em').text()).toBe("Highlighted A");
    await wrapper.setProps({ sortBy: searchSortOptions.path });
    expect(wrapper.findAll('a[href^="/F/"]').map(a => a.attributes("href"))).toEqual(["/F/A", "/F/Z"]);
    expect(getNotes).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ searchTerm: "next" }); await flushPromises();
    expect(getNotes.mock.lastCall).toEqual(["next", undefined, undefined, undefined, true, "F"]);
    expect(wrapper.find("input").element.value).toBe("next");
    await wrapper.setProps({ folder: "G" }); await flushPromises();
    expect(getNotes.mock.lastCall[5]).toBe("G");
  });

  it("wires nested toggle, folder/up targets and sort menu navigation", async () => {
    const { wrapper, router } = await render({ folder: "F/sub" });
    getNotes.mockResolvedValueOnce([]).mockResolvedValueOnce([{ title: "F/sub/Child/n" }]);
    await wrapper.findComponent({ name: "Toggle" }).trigger("click"); await flushPromises();
    expect(localStorage.getItem("includeNested")).toBe("false");
    const child = wrapper.findAll("a").find(a => a.text() === "Child");
    expect(child).toBeDefined();
    expect(router.resolve(child.attributes("href")).query).toMatchObject({ [params.folder]: "F/sub/Child", [params.searchTerm]: "word" });
    const up = wrapper.findAll("a").find(a => a.text() === "..");
    expect(router.resolve(up.attributes("href")).query[params.folder]).toBe("F");
    const sort = wrapper.findAll("button").find(b => b.text() === "Sort By: Title");
    await sort.trigger("click"); await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ [params.searchTerm]: "word", [params.sortBy]: String(searchSortOptions.path) });
  });

  it("forwards single and bulk reference actions and removes acknowledged banner rows", async () => {
    const files = ["A", "B", "C"].map(name => ({ oldPath: "old/" + name, newPath: "new/" + name }));
    const { wrapper } = await render({}, { rewriteFiles: JSON.stringify(files) });
    const fixes = wrapper.findAll("button").filter(b => b.text() === "Fix");
    await fixes[0].trigger("click"); await flushPromises();
    expect(wrapper.findAll("li")).toHaveLength(2);
    expect(rewriteRefs).toHaveBeenCalledWith("old/A", "new/A");
    const all = wrapper.findAll("button").find(b => b.text() === "Fix all");
    await all.trigger("click"); await flushPromises();
    expect(wrapper.text()).not.toContain("Fix broken references");
    expect(publish.mock.calls.filter(([topic]) => topic === TOPICS.NOTE_REFS_REWRITTEN)).toEqual(files.map(f => [TOPICS.NOTE_REFS_REWRITTEN, f]));
    expect(toast.add.mock.lastCall[0].summary).toBe("All fixed");
  });

  it("keeps the newest query rendered when an older request finishes last", async () => {
    let finishOld;
    getNotes.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce([{ path: "New", title: "Current result" }]);
    const { wrapper } = await render();
    await wrapper.setProps({ searchTerm: "new" }); await flushPromises();
    expect(wrapper.find('a[href="/New"]').text()).toContain("Current result");
    finishOld([{ path: "Old", title: "Retired result" }]); await flushPromises();
    expect(wrapper.find('a[href="/New"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/Old"]').exists()).toBe(false);
  });
});
