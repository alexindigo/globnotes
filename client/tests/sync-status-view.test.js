import { afterEach, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import SyncStatus from "../components/SyncStatus.vue";
import { ICON_PATHS } from "../icons.js";
import { readFileSync } from "node:fs";
enableAutoUnmount(afterEach);
it("uses the generated outline paths from the pinned Tabler package",()=>{
  for(const [name,key]of [["cloud","tabCloud"],["cloud-upload","tabCloudUpload"],["cloud-download","tabCloudDownload"],["cloud-exclamation","tabCloudExclamation"]]) {
    const svg=readFileSync(`node_modules/@tabler/icons/icons/outline/${name}.svg`,"utf8");
    const paths=[...svg.matchAll(/<path\b([^>]*)\/>/g)].filter(([,attrs])=>!attrs.includes('stroke="none"')).map(([,attrs])=>/\bd="([^"]+)"/.exec(attrs)[1]);
    expect(ICON_PATHS[key]).toEqual(paths);
  }
});
const snapshot = {visible:true,icon:"tabCloudDownload",tone:"danger",label:"Sync: receiving changes: needs attention",instances:[{id:"home",label:"Home",enabled:true,pluginName:"Remote",status:"failed",stateLabel:"Failed",reasonLabel:"Could not reach the server",failingLabel:"9:00 AM",retryLabel:"Next retry: 9:10 AM"}]};
it("renders the controller's Tabler shape, tone, panel rows and settings intent",async()=>{
  const onSettings=vi.fn(),view=mount(SyncStatus,{props:{snapshot,onSettings},attachTo:document.body});
  expect(view.findAll("svg path").map(p=>p.attributes("d"))).toEqual(ICON_PATHS.tabCloudDownload);
  expect(view.get("[data-sync-status]").classes()).toContain("sync-status__trigger--danger");
  await view.get("[data-sync-status]").trigger("click");
  expect(view.get('[role="dialog"]').attributes("aria-labelledby")).toBe("sync-status-title");
  expect(document.activeElement.id).toBe("sync-status-panel");
  expect(view.text()).toContain("Could not reach the server");expect(view.text()).toContain("Next retry");expect(view.findAll("[disabled]")).toHaveLength(0);
  await view.get('[role="dialog"]').trigger("keydown.esc");expect(view.find('[role="dialog"]').exists()).toBe(false);expect(document.activeElement).toBe(view.get("[data-sync-status]").element);
  await view.get("[data-sync-status]").trigger("click");await view.get(".sync-status__settings").trigger("click");expect(onSettings).toHaveBeenCalledOnce();
  await view.setProps({snapshot:{...snapshot,visible:false}});expect(view.find("[data-sync-status]").exists()).toBe(false);
});
