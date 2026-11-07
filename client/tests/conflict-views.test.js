// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { RouterView, createMemoryHistory, createRouter } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach } from "vitest";
import ConflictComparison from "../components/ConflictComparison.vue";
import ConflictBadge from "../components/ConflictBadge.vue";
import Conflicts from "../views/Conflicts.vue";
import { CONFLICT_INBOX } from "../conflictInbox.js";
import { getConflict, resolveConflict } from "../api.js";
import { useGlobalStore } from "../globalStore.js";
vi.mock("../api.js", () => ({ getConflict: vi.fn(), getConflicts: vi.fn(), resolveConflict: vi.fn() }));
vi.mock("../vaultChanges.js", () => ({ acquireVaultChanges: vi.fn() }));
enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
const member = (path, preview = "text") => ({ path, preview, content: '<script>alert("text")</script>\n', size: 30, mediaType: "text/markdown", version: "abc" });
const router = () => createRouter({ history: createMemoryHistory("/prefix"), routes: [
  { path: "/_/conflicts", name: "conflicts", component: Conflicts },
  { path: "/_/conflicts/:id", name: "conflict", component: Conflicts, props: true },
] });
const routed = (r, inbox) => mount({ components: { RouterView }, template: "<RouterView />" }, {
  attachTo: document.body, global: { plugins: [r], provide: { [CONFLICT_INBOX]: inbox }, directives: { focus: { mounted: el => el.focus() } } },
});
const button = (wrapper, label, scope = "button") => wrapper.findAll(scope).find(b => b.text() === label);
describe("conflict render wiring", () => {
  it("renders the shared source panels as literal text and metadata-only files without body decode", () => {
    const wrapper = mount(ConflictComparison, { props: { pair: { original: member("A.md"), copy: member("B.md", "invalid_utf8") }, originalHref: "/a", copyHref: "/b" } });
    expect(wrapper.findAll("section").map(section => section.attributes("aria-label"))).toEqual(["Original", "Conflict copy"]);
    expect(wrapper.find("pre").text()).toContain('<script>alert("text")</script>'); expect(wrapper.find("script").exists()).toBe(false);
    expect(wrapper.text()).toContain("valid UTF-8"); expect(wrapper.findAll("a").map(a => a.attributes("href"))).toEqual(["/a", "/b"]);
    expect(wrapper.findAll("button, [disabled]")).toHaveLength(0);
  });
  it("keeps the conflict glyph at zero with exact adjacent count above zero", async () => {
    const r = router(); await r.push("/_/conflicts");
    const wrapper = mount(ConflictBadge, { props: { snapshot: { available: true, total: null, label: "Conflicts" } }, global: { plugins: [r] } });
    expect(wrapper.find("svg").exists()).toBe(true); expect(wrapper.find("a").attributes("aria-label")).toBe("Conflicts"); expect(wrapper.find(".conflict-badge__count").exists()).toBe(false);
    await wrapper.setProps({ snapshot: { available: true, total: 42, label: "Conflicts: 42 unresolved", stale: true } });
    expect(wrapper.find(".conflict-badge__count").text()).toBe("42"); expect(wrapper.text()).toContain("out of date");
    await wrapper.setProps({ snapshot: { available: false } }); expect(wrapper.find("a").exists()).toBe(false);
  });
  it("renders inbox paths/reason/count and forwards retry, never fabricating empty on failure", async () => {
    const r = router(); await r.push("/_/conflicts");
    const inbox = { state: { rows: [], total: null, error: "Could not load conflicts." }, acquire: () => () => {}, refresh: vi.fn() };
    const wrapper = routed(r, inbox); await flushPromises();
    expect(wrapper.text()).not.toContain("No conflicts"); await wrapper.find("button").trigger("click"); expect(inbox.refresh).toHaveBeenCalledTimes(1);
  });
  it("detail id loads through its controller and renders resolved/missing messages", async () => {
    const r = router(); await r.push("/_/conflicts/a");
    getConflict.mockResolvedValueOnce({ id: "a", state: "resolved" });
    const wrapper = routed(r, { state: {}, acquire: () => () => {} });
    await flushPromises(); expect(wrapper.text()).toContain("This conflict was resolved elsewhere.");
    getConflict.mockRejectedValueOnce({ response: { status: 404 } }); await r.push("/_/conflicts/b"); await flushPromises();
    expect(wrapper.text()).toContain("Conflict not found."); expect(wrapper.findAll("[disabled]")).toHaveLength(0);
  });
  it("wires source input, destructive confirmation and guarded route cancellation through the controller", async () => {
    const pair = { id: "a", revision: 1, state: "open", original: member("A.md"), copy: member("B.md") };
    getConflict.mockResolvedValue(pair);
    const r = router(); await r.push("/_/conflicts/a"); const resolved = vi.fn();
    const wrapper = routed(r, { state: { rows: [], total: 0 }, acquire: () => () => {}, resolved }); await flushPromises();
    await button(wrapper, "Edit a merge").trigger("click");
    await wrapper.find("textarea").setValue("exact merge\n");
    expect(wrapper.findAll('.conflicts-page__actions button').map(b => b.text())).toEqual(["Save merge", "Cancel merge", "Postpone"]);
    const navigation = r.push("/_/conflicts"); await flushPromises();
    expect(wrapper.get('[role=dialog]').text()).toContain("delete B.md"); await button(wrapper, "Cancel", '[role=dialog] button').trigger("click");
    await navigation; expect(r.currentRoute.value.params.id).toBe("a"); expect(wrapper.find("textarea").element.value).toBe("exact merge\n");
    await button(wrapper, "Save merge", ".conflicts-page__actions button").trigger("click");
    expect(wrapper.get('[role=dialog]').text()).toContain("Save merge to A.md and delete B.md?");
    resolveConflict.mockResolvedValue({ id: "a", revision: 2, status: "settled", action: "merge", remaining: [{ path: "A.md", version: "new" }], removed: ["B.md"] });
    await button(wrapper, "Save merge", '[role=dialog] button').trigger("click"); await flushPromises();
    expect(resolveConflict).toHaveBeenCalledWith("a", expect.objectContaining({ content: "exact merge\n" }));
    expect(resolved).toHaveBeenCalledWith("Kept A.md. Removed B.md."); expect(r.currentRoute.value.name).toBe("conflicts");
    expect(wrapper.findAll('[disabled]')).toHaveLength(0);
  });
  it("read-only comparison exposes no keep or merge controls", async () => {
    useGlobalStore().config = { authType: "read_only" };
    getConflict.mockResolvedValue({ id: "a", revision: 1, state: "open", original: member("A.md"), copy: member("B.md") });
    const r = router(); await r.push("/_/conflicts/a"); const wrapper = routed(r, { state: {}, acquire: () => () => {} }); await flushPromises();
    expect(wrapper.findAll('.conflicts-page__actions button').map(b => b.text())).toEqual(["Postpone"]);
  });
});
