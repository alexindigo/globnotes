// SPDX-License-Identifier: LGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import DeclarativeSettingsPage from "../components/DeclarativeSettingsPage.vue";
import { createSettingsPageState } from "../settingsPageState.js";

let controller, wrapper;
afterEach(() => { wrapper?.unmount(); controller?.dispose(); wrapper = controller = null; });

describe("native settings drafts", () => {
  it('r2 B10 preserves a stored null instead of displaying a default', async () => {
    const page={id:'plugin:null:p',descriptor:{fields:[{key:'value',type:'select',default:'default',options:[{label:'None',value:null},{label:'Default',value:'default'}]}]}};
    controller=createSettingsPageState({registry:{find:()=>page,read:async()=>({values:{value:null},revision:0})},confirm:async()=>'cancel'});
    await controller.load(page.id); expect(controller.snapshot(page.id).fieldViews.value.value).toBeNull();
  });
  it('r2 B6 keeps inactive blocking qualification in the page projection', () => {
    const page={id:'plugin:off:p',blocking:{active:false,actions:['save']},descriptor:{fields:[]}};
    controller=createSettingsPageState({registry:{find:()=>page},confirm:async()=>'cancel'});
    expect(controller.snapshot(page.id).blockingText).toContain('Can block when on: save');
  });
  it('r2 B6 reads live blocking metadata while preserving a retained invalid draft', async () => {
    let page={id:'plugin:retained-blocking:p',available:true,blocking:{active:true,actions:['save']},descriptor:{fields:[{key:'limit',type:'number',min:1,default:2}]}};
    const commit=vi.fn();controller=createSettingsPageState({registry:{find:()=>page,read:async()=>({values:{limit:2},revision:0}),commit},confirm:async()=>'cancel'});
    await controller.load(page.id);controller.edit(page.id,'limit','invalid');
    page={...page,available:false,blocking:{active:false,actions:['save']}};controller.reconcile();
    expect(controller.snapshot(page.id).blockingText).toContain('Can block when on: save');
    expect(controller.snapshot(page.id).fieldViews.limit.value).toBe('invalid');expect(commit).not.toHaveBeenCalled();
  });
  it("exposes read-back admission for an uncertain retained definition without replaying removed fields", async () => {
    let page={id:"plugin:retained:p",available:true,descriptor:{fields:[{key:"message",type:"text",default:"old"}]}};
    const read=vi.fn(async()=>({values:{message:"old"},revision:0,sourceKey:"old-source"}));
    const commit=vi.fn(async()=>{throw Error("response lost");});
    const confirm=vi.fn(async()=>"cancel");
    controller=createSettingsPageState({registry:{find:()=>page,read,commit},confirm});
    await controller.load(page.id);controller.edit(page.id,"message","retained D1");
    expect(await controller.commit(page.id)).toBe(false);await flushPromises();
    page={...page,descriptor:{fields:[{key:"d3",type:"text",default:"new"}]}};controller.reconcile();
    expect(controller.snapshot(page.id).canRetry).toBe(true);
    expect(controller.snapshot(page.id).fieldViews.message.value).toBe("retained D1");
    read.mockResolvedValue({values:{d3:"D3 authoritative"},revision:1,sourceKey:"new-source"});
    expect(await controller.retry(page.id)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);expect(commit).toHaveBeenCalledOnce();
    expect(controller.snapshot(page.id).drafts.message).toBe("retained D1");
    expect(controller.snapshot(page.id).canRetry).toBe(false);
    expect(await controller.resolveDeparture([page.id],"close")).toBe(false);
    expect(controller.snapshot(page.id).drafts.message).toBe("retained D1");
    expect(await controller.resolveDeparture([page.id],"close","discard")).toBe(true);
    await controller.load(page.id);
    expect(controller.snapshot(page.id).values).toEqual({d3:"D3 authoritative"});
    expect(controller.snapshot(page.id).drafts).toEqual({});expect(commit).toHaveBeenCalledOnce();
  });
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
