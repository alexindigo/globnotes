// SPDX-License-Identifier: LGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import DeclarativeSettingsPage from "../components/DeclarativeSettingsPage.vue";
import { createSettingsPageState } from "../settingsPageState.js";

let controller, wrapper;
afterEach(() => { wrapper?.unmount(); controller?.dispose(); wrapper = controller = null; });

describe("native settings drafts", () => {
  it("retains an in-progress color through a held authoritative refresh and commits its literal value only on change", async () => {
    const descriptor = { fields: [{ key: "color", label: "Color", type: "color", default: "#aabbcc" }] };
    const page = { id: "plugin:color:p", descriptor, available: true };
    const read = vi.fn(async () => ({ values: { color: "#aabbcc" }, revision: 0, sourceKey: "accepted" }));
    const commit = vi.fn(async (_page, values, revision) => ({ values, revision: revision + 1, sourceKey: "next" }));
    const confirm = vi.fn(async () => "cancel");
    controller = createSettingsPageState({ registry: { find: () => page, read, commit }, confirm });
    await controller.load(page.id);
    wrapper = mount(defineComponent({
      render() {
        return h(DeclarativeSettingsPage, {
          page: descriptor, snapshot: controller.snapshot(page.id),
          onEdit: ({ key, raw }) => controller.edit(page.id, key, raw),
          onCommit: key => controller.commit(page.id, key),
        });
      },
    }));
    let resolve;
    read.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const refreshing = controller.load(page.id);
    try {
      const field = wrapper.find('input[type="color"]');
      field.element.value = "#99b3cc";
      await field.trigger("input");
      expect(commit).not.toHaveBeenCalled();
      resolve({ values: { color: "#aabbcc" }, revision: 0, sourceKey: "accepted" });
      await refreshing; await flushPromises();
      expect(field.element.value).toBe("#99b3cc");
      expect(controller.snapshot(page.id).drafts.color).toBe("#99b3cc");
      expect(await controller.resolveDeparture([page.id], "closing during color selection")).toBe(false);
      expect(confirm).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      await field.trigger("change"); await controller.settle(); await flushPromises();
      expect(commit).toHaveBeenCalledExactlyOnceWith(page, { color: "#99b3cc" }, 0, "accepted");
      expect(controller.snapshot(page.id).committed.color).toBe("#99b3cc");
      expect(controller.hasWork()).toBe(false);
    } finally {
      resolve({ values: { color: "#aabbcc" }, revision: 0, sourceKey: "accepted" });
      await refreshing;
    }
  });
});
