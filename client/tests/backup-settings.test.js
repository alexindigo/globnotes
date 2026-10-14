// SPDX-License-Identifier: LGPL-3.0-only
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createSettingsPageState } from "../settingsPageState.js";
import SettingsField from "../components/SettingsField.vue";

describe("backup settings", () => {
  it("retires a source-conflicted unknown submission while retaining a draft for explicit discard", async () => {
    const page = { id: "plugin:p:backup", descriptor: { fields: [{ key: "basePath", type: "folder", default: "" }] } };
    let sourceKey = "old";
    const confirm = vi.fn(async () => "discard"), write = vi.fn(async () => { throw new Error("response lost"); });
    const state = createSettingsPageState({ registry: { find: () => page, read: async () => ({ values: { basePath: "" }, revision: 0, sourceKey }), commit: write }, confirm });
    await state.load(page.id); state.edit(page.id, "basePath", "retained");
    expect(await state.commit(page.id)).toBe(false);
    await Promise.resolve(); sourceKey = "replacement";
    expect(await state.retry(page.id)).toBe(false);
    expect(state.snapshot(page.id).drafts.basePath).toBe("retained");
    expect(await state.resolveDeparture([page.id], "close")).toBe(true);
    expect(confirm).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledOnce();
    state.dispose();
  });
  it("carries the accepted source and effective pin with a writable sibling without persisting a UI substitution", async () => {
    const page = { id: "plugin:p:backup", descriptor: { fields: [{ key: "retention", type: "slider", default: 2, min: 1, max: 10, step: 1 }, { key: "basePath", type: "folder", default: "" }] } };
    const commit = vi.fn(async (_page, values, revision, sourceKey) => ({ values, revision: revision + 1, sourceKey: "accepted-next", fields: { basePath: { source: "environment", readonly: true } } }));
    const state = createSettingsPageState({ registry: { find: () => page, read: async () => ({ values: { retention: 2, basePath: "/effective" }, revision: 4, sourceKey: "accepted-original", fields: { basePath: { source: "environment", readonly: true } } }), commit }, confirm: vi.fn() });
    await state.load(page.id);
    state.edit(page.id, "basePath", "/replacement");
    expect(state.snapshot(page.id).drafts).toEqual({});
    state.edit(page.id, "retention", "7");
    expect(await state.commit(page.id)).toBe(true);
    expect(commit).toHaveBeenCalledWith(page, { retention: 7, basePath: "/effective" }, 4, "accepted-original");
    expect(state.snapshot(page.id).sourceKey).toBe("accepted-next");
    expect(state.snapshot(page.id).fields.basePath.readonly).toBe(true);
    state.dispose();
  });
  it("uses a range draft with separate Enter/blur commit, and visibly disables an environment-pinned field", async () => {
    const range = mount(SettingsField, { props: { field: { key: "retention", label: "Versions", type: "slider", min: 1, max: 10, step: 1 }, value: 2 } });
    await range.find('input[type="range"]').setValue("8");
    expect(range.emitted("edit")[0]).toEqual([{ key: "retention", raw: "8" }]);
    expect(range.emitted("commit")).toBeUndefined();
    await range.find("input").trigger("keydown", { key: "Enter" });
    expect(range.emitted("commit")[0]).toEqual(["retention"]);
    range.unmount();
    const pinned = mount(SettingsField, { props: { field: { key: "basePath", label: "Base", type: "folder" }, value: "/effective", readonly: true, provenance: { source: "environment", readonly: true } } });
    expect(pinned.text()).toContain("Set by environment");
    expect(pinned.find("input").element.readOnly).toBe(true);
    await pinned.find("input").setValue("/attempt");
    expect(pinned.emitted("edit")).toBeUndefined();
    pinned.unmount();
  });
});
