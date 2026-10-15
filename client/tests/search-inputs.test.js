// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import SearchInput from "../partials/SearchInput.vue";
import SwitcherInput from "../components/SwitcherInput.vue";
import { apiErrorHandler, getTags } from "../api.js";
import { publish, TOPICS } from "../bus/index.js";
import { params } from "../constants.js";

const { toast } = vi.hoisted(() => ({ toast: { add: vi.fn() } }));
vi.mock("primevue/usetoast", () => ({ useToast: () => toast }));
vi.mock("../api.js", () => ({ getTags: vi.fn(), apiErrorHandler: vi.fn() }));
vi.mock("../bus/index.js", async importOriginal => ({ ...await importOriginal(), publish: vi.fn() }));
enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.clearAllMocks();
  getTags.mockReset().mockResolvedValue(["apple", "apricot", "banana"]);
});

async function render(Component, props = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/_/search", name: "search", component: { template: "<div/>" } },
  ] });
  await router.push({ name: "search", query: { folder: "Recipes", sortBy: "1" } });
  const Host = Component === SwitcherInput ? defineComponent({ setup() {
    const value = ref("");
    return () => h(SwitcherInput, { ...props, modelValue: value.value, "onUpdate:modelValue": term => { value.value = term; } });
  } }) : Component;
  const wrapper = mount(Host, { props: Component === SearchInput ? props : {}, global: {
    plugins: [router], directives: { focus: () => {} },
  } });
  await flushPromises();
  return { wrapper, router, input: wrapper.find("input") };
}

async function type(input, text, cursor = text.length) {
  await input.setValue(text); input.element.setSelectionRange(cursor, cursor);
  await input.trigger("keyup", { key: "p" }); await flushPromises();
}

describe.each([["SearchInput", SearchInput], ["SwitcherInput", SwitcherInput]])("%s shared completion wiring", (_, Component) => {
  it("renders lowercase matches, replaces only the caret word and publishes the new term", async () => {
    const { wrapper, input } = await render(Component);
    await type(input, "find #AP tail", 7);
    expect(wrapper.findAll("p").map(row => row.text())).toEqual(["#apple", "#apricot"]);
    await wrapper.findAll("p")[1].trigger("click"); await flushPromises();
    expect(input.element.value).toBe("find #apricot tail");
    expect(wrapper.findAll("p")).toHaveLength(0);
    expect(publish.mock.calls.filter(([topic]) => topic === TOPICS.SEARCH_CHANGE)).toEqual([
      [TOPICS.SEARCH_CHANGE, { term: "find #AP tail" }],
      [TOPICS.SEARCH_CHANGE, { term: "find #apricot tail" }],
    ]);
  });

  it("delegates arrow selection and completion Enter while Escape only dismisses", async () => {
    const { wrapper, input, router } = await render(Component);
    await type(input, "#ap");
    const rows = wrapper.findAll("p"); rows.forEach(row => { row.element.scrollIntoView = vi.fn(); });
    await input.trigger("keydown", { key: "ArrowDown" });
    expect(rows[1].classes()).toContain("bg-theme-background-elevated");
    expect(rows[1].element.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    await input.trigger("keydown", { key: "ArrowUp" });
    expect(rows[0].classes()).toContain("bg-theme-background-elevated");
    await input.trigger("keydown", { key: "Enter" }); await flushPromises();
    expect(input.element.value).toBe("#apple");
    expect(router.currentRoute.value.query[params.searchTerm]).toBeUndefined();
    if (Component === SwitcherInput) expect(wrapper.findComponent(SwitcherInput).emitted("submit")).toBeUndefined();
    await type(input, "#");
    await input.trigger("keydown", { key: "Escape" });
    expect(wrapper.findAll("p")).toHaveLength(0);
    await input.trigger("click"); await flushPromises();
    expect(wrapper.findAll("p")).toHaveLength(0); // Equal-count update remains hidden.
  });

  it("hides on blur and reports a cached transport failure through the toast adapter", async () => {
    const { wrapper, input } = await render(Component);
    await type(input, "#ap"); await input.trigger("blur");
    expect(wrapper.findAll("p")).toHaveLength(0);
    const error = new Error("offline"); getTags.mockRejectedValueOnce(error);
    const second = await render(Component);
    await type(second.input, "#a"); await type(second.input, "#b");
    expect(apiErrorHandler).toHaveBeenCalledExactlyOnceWith(error, toast);
    expect(second.wrapper.findAll("p")).toHaveLength(0);
    expect(getTags).toHaveBeenCalledTimes(2);
  });
});

it("preserves SearchInput query context, prop updates, clear-to-all and empty validation", async () => {
  const { wrapper, input, router } = await render(SearchInput, { initialSearchTerm: "old" });
  expect(publish).not.toHaveBeenCalled();
  await wrapper.setProps({ initialSearchTerm: "from props" });
  expect(input.element.value).toBe("from props");
  expect(publish).toHaveBeenLastCalledWith(TOPICS.SEARCH_CHANGE, { term: "from props" });
  await input.trigger("keydown", { key: "Enter" }); await flushPromises();
  expect(router.currentRoute.value.query).toEqual({ folder: "Recipes", sortBy: "1", [params.searchTerm]: "from props" });
  expect(wrapper.emitted("search")).toHaveLength(1);
  await wrapper.find("button").trigger("click"); await flushPromises();
  expect(input.element.value).toBe("*");
  expect(router.currentRoute.value.query).toEqual({ folder: "Recipes", sortBy: "1", [params.searchTerm]: "*" });
  await input.setValue(""); await input.trigger("keydown", { key: "Enter" });
  expect(toast.add.mock.lastCall[0]).toMatchObject({ summary: "Error", detail: "Please enter a search term.", severity: "error" });
  expect(wrapper.emitted("search")).toHaveLength(2);
});

it("preserves SwitcherInput result shortcuts and focus forwarding outside completion", async () => {
  const { wrapper, input } = await render(SwitcherInput);
  const component = wrapper.findComponent(SwitcherInput);
  await input.trigger("focus"); await input.trigger("keydown", { key: "ArrowDown" });
  await input.trigger("keydown", { key: "ArrowUp" });
  await input.trigger("keydown", { key: "Enter" });
  for (const modifier of ["ctrlKey", "metaKey"]) {
    await input.trigger("keydown", { key: "2", [modifier]: true });
    await input.trigger("keydown", { key: "Enter", [modifier]: true });
  }
  await input.trigger("keydown", { key: "3" });
  expect(component.emitted("focus")).toHaveLength(1);
  expect(component.emitted("navigate")).toEqual([[1], [-1]]);
  expect(component.emitted("submit")).toHaveLength(1);
  expect(component.emitted("jump")).toEqual([[2], [2]]);
  expect(component.emitted("search")).toHaveLength(2);
});
