// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import ConflictComparison from "../components/ConflictComparison.vue";
import ConflictBadge from "../components/ConflictBadge.vue";
import Conflicts from "../views/Conflicts.vue";
import { CONFLICT_INBOX } from "../conflictInbox.js";
import { getConflict } from "../api.js";
vi.mock("../api.js", () => ({ getConflict: vi.fn(), getConflicts: vi.fn() }));
vi.mock("../vaultChanges.js", () => ({ acquireVaultChanges: vi.fn() }));
enableAutoUnmount(afterEach);
const member = (path, preview = "text") => ({ path, preview, content: '<script>alert("text")</script>\n', size: 30, mediaType: "text/markdown", version: "abc" });
const router = () => createRouter({ history: createMemoryHistory("/prefix"), routes: [
  { path: "/_/conflicts", name: "conflicts", component: Conflicts },
  { path: "/_/conflicts/:id", name: "conflict", component: Conflicts, props: true },
] });
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
    const wrapper = mount(Conflicts, { global: { plugins: [r], provide: { [CONFLICT_INBOX]: inbox } } });
    expect(wrapper.text()).not.toContain("No conflicts"); await wrapper.find("button").trigger("click"); expect(inbox.refresh).toHaveBeenCalledTimes(1);
  });
  it("detail id loads through its controller and renders resolved/missing messages", async () => {
    const r = router(); await r.push("/_/conflicts/a");
    getConflict.mockResolvedValueOnce({ id: "a", state: "resolved" });
    const wrapper = mount(Conflicts, { props: { id: "a" }, global: { plugins: [r], provide: { [CONFLICT_INBOX]: { state: {}, acquire: () => () => {} } } } });
    await flushPromises(); expect(wrapper.text()).toContain("This conflict was resolved elsewhere.");
    getConflict.mockRejectedValueOnce({ response: { status: 404 } }); await wrapper.setProps({ id: "b" }); await flushPromises();
    expect(wrapper.text()).toContain("Conflict not found."); expect(wrapper.findAll("[disabled]")).toHaveLength(0);
  });
});
