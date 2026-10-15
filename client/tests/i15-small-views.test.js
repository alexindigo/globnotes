import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import CommandPalettePanel from "../components/CommandPalettePanel.vue";
import DeclarativeSettingsPage from "../components/DeclarativeSettingsPage.vue";
import PermissionHostRows from "../components/PermissionHostRows.vue";
import PermissionRequestModal from "../components/PermissionRequestModal.vue";
import { permissionScopeKey } from "../pluginPermissionController.js";

vi.mock("../commands.js", async () => { const { ref } = await import("vue"); return { commandRegistry: ref([
  { id: "save", label: "Save note", group: "Notes" }, { id: "inspect", label: "Inspect vault", group: "Tools" },
]), commandHint: id => id === "save" ? "Ctrl+S" : "" }; });

let wrapper;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

describe("small views render extracted policy", () => {
  it("palette filters rendered rows, retains hints and emits the selected command", async () => {
    wrapper = mount(CommandPalettePanel);
    expect(wrapper.findAll("li").map(row => row.text())).toEqual(["Save noteCtrl+S", "Inspect vault"]);
    const input = wrapper.find("input");
    await input.setValue("  TOOLS  ");
    expect(wrapper.findAll("li").map(row => row.text())).toEqual(["Inspect vault"]);
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("run")).toEqual([["inspect"]]);
    await input.setValue("missing"); expect(wrapper.text()).toContain("No matching commands.");
  });
  it("descriptor grouping and visibility follow committed values rather than raw drafts", async () => {
    const fields = [{ key: "enabled", label: "Enabled", type: "toggle" },
      { key: "detail", label: "Detail", type: "text", visibleWhen: { field: "enabled", equals: true } },
      { key: "tail", label: "Tail", type: "text" }];
    const snapshot = { available: true, loaded: true, values: { enabled: false, detail: "stored", tail: "last" }, drafts: { enabled: true }, errors: {} };
    wrapper = mount(DeclarativeSettingsPage, { props: { page: { fields, groups: [{ id: "first", label: "First", fields: ["detail", "enabled"] }] }, snapshot },
      global: { stubs: { SettingsField: { props: ["field", "value"], template: "<p>{{field.key}}:{{value}}</p>" } } } });
    expect(wrapper.findAll("section").map(section => section.text())).toEqual(["Firstenabled:true", "tail:last"]);
    await wrapper.setProps({ snapshot: { ...snapshot, values: { ...snapshot.values, enabled: true } } });
    expect(wrapper.findAll("section").map(section => section.text())).toEqual(["Firstdetail:storedenabled:true", "tail:last"]);
  });
  it.each([
    [{ type: "all" }, "all"], [{ type: "host", authority: "example.test" }, "host:example.test"],
    [{ type: "host", authority: "example.test:443" }, "host:example.test:443"],
    [{ type: "host", authority: "[::1]:8443" }, "host:[::1]:8443"],
  ])("one scope key identifies host rows and equivalent request choices: %s", async (scope, key) => {
    expect(permissionScopeKey(scope)).toBe(key);
    const onApprove = vi.fn();
    wrapper = mount(PermissionHostRows, { props: { kind: "network", heading: "Network", rows: [{ scope, requested: true, approved: false, sources: [], approvalCoverage: [], blockedReasons: [] }], onApprove, onDelete() {} } });
    expect(wrapper.find("[data-permission-scope]").attributes("data-permission-scope")).toBe(key);
    await wrapper.find("button").trigger("click"); expect(onApprove).toHaveBeenCalledWith(scope);
    wrapper.unmount();
    const onScope = vi.fn();
    wrapper = mount(PermissionRequestModal, { props: { request: { kind: "network", scopes: [scope], source: { revision: 0 } }, choices: { scopes: [{ ...scope }], allowNetwork: false }, writable: true,
      onScope, onMaster() {}, onApprove() {}, onDeny() {}, onCancel() {} },
      global: { stubs: { Modal: { template: "<slot />" }, PluginPermissionPanel: true } } });
    expect(wrapper.find('input[type="checkbox"]').element.checked).toBe(true);
    await wrapper.find('input[type="checkbox"]').setValue(false);
    expect(onScope).toHaveBeenCalledWith(scope, false);
  });
});
