import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyncStatus, SYNC_ACTIVITY_MIN_MS } from "../syncStatusController.js";
import { TOPICS } from "../bus/index.js";

const row = (values = {}) => ({ id:"home", label:"Home", pluginName:"Remote", enabled:true, status:"active", activity:null, failingSince:null, warning:false,warningAfterMs:null,reason:null, nextRetry:null, lastSync:null, ...values });
function fixture(instances = [row()]) {
  let now = 1_000, lifetimeListener;
  const handlers = new Map(), release = vi.fn();
  const read = vi.fn(async () => ({ instances }));
  const controller = createSyncStatus({ read, now:() => now, subscribe:(topic, fn) => { handlers.set(topic, fn); return () => handlers.delete(topic); },
    acquireChanges:() => release, lifetime:{subscribe(fn) { lifetimeListener = fn; fn(true); return vi.fn(); }} });
  controller.setContext({ active:true, key:"admin" });
  return { controller, read, handlers, release, time(value) { now = value; }, visibility:value => lifetimeListener(value), rows(value) { instances = value; } };
}
const settle = async () => { for(let i=0;i<15;i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
describe("sync status owner", () => {
  it("hides an empty list and never treats a paused connection or absent onset as trouble",async()=>{
    const f=fixture([]);f.time(700_000);await settle();expect(f.controller.state.visible).toBe(false);
    f.rows([row({status:"paused",failingSince:1000})]);await f.controller.refresh();expect(f.controller.state.visible).toBe(true);expect(f.controller.state.tone).toBe("idle");
    f.rows([row({status:"failed"})]);await f.controller.refresh();expect(f.controller.state.tone).toBe("idle");f.controller.dispose();
  });
  it("keeps continuous trouble while a replacement is starting, until genuine recovery",async()=>{
    const f=fixture([row({status:"starting",failingSince:1000,warning:true})]);f.time(700_000);await settle();expect(f.controller.state.tone).toBe("danger");
    f.rows([row()]);await f.controller.refresh();expect(f.controller.state.tone).toBe("idle");f.controller.dispose();
  });
  it("shows idle whenever any connection is enabled and includes all connections", async () => {
    const f=fixture([row(),row({id:"office",enabled:false,status:"off"})]);await settle();
    expect(f.controller.state.visible).toBe(true);expect(f.controller.state.icon).toBe("tabCloud");expect(f.controller.state.tone).toBe("idle");expect(f.controller.state.instances).toHaveLength(2);f.controller.dispose();
  });
  it.each([-9_000_000,9_000_000])("uses one server-relative refresh despite browser clock skew %s", async skew => {
    vi.useFakeTimers();const f=fixture([row({status:"failed",failingSince:1_000,warningAfterMs:120_000,reason:"network_denied",nextRetry:5000})]);f.time(skew);await settle();
    expect(f.controller.state.tone).toBe("idle");await vi.advanceTimersByTimeAsync(119_999);expect(f.read).toHaveBeenCalledTimes(1);
    f.rows([row({status:"failed",failingSince:1000,warning:true,reason:"network_denied",nextRetry:5000})]);await vi.advanceTimersByTimeAsync(1);await settle();
    expect(f.controller.state.tone).toBe("danger");expect(f.controller.state.icon).toBe("tabCloudExclamation");expect(f.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500_000);expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.controller.state.instances[0].stateLabel).toBe("Failed");expect(f.controller.state.instances[0].reasonLabel).toBe("Network access needs approval");f.controller.dispose();
  });
  it("stream recovery clears trouble immediately; Off never triggers and locked does", async () => {
    const f=fixture([row({status:"locked",failingSince:1_000,warning:true})]);await settle();expect(f.controller.state.tone).toBe("danger");
    f.rows([row()]);await f.handlers.get(TOPICS.VAULT_DRIVERS)();await settle();expect(f.controller.state.tone).toBe("idle");
    f.rows([row({enabled:false,status:"off",failingSince:1_000,warning:true,activity:"receiving"})]);await f.controller.refresh();expect(f.controller.state.visible).toBe(false);expect(f.controller.state.tone).toBe("idle");f.controller.dispose();
  });
  it.each([["sending","tabCloudUpload"],["receiving","tabCloudDownload"]])("%s uses accent and the matching Tabler shape",async(activity,icon)=>{
    const f=fixture([row({activity})]);await settle();expect(f.controller.state.icon).toBe(icon);expect(f.controller.state.tone).toBe("active");f.controller.dispose();
  });
  it("receiving wins across connections and trouble wins over accent",async()=>{
    const f=fixture([row({activity:"sending"}),row({id:"other",activity:"receiving"}),row({id:"broken",status:"failed",failingSince:1_000,warning:true})]);f.time(700_000);await settle();
    expect(f.controller.state.icon).toBe("tabCloudDownload");expect(f.controller.state.tone).toBe("danger");expect(f.controller.state.label).toContain("needs attention");f.controller.dispose();
  });
  it("holds the shown activity for one second without requests, but Off clears it immediately",async()=>{
    vi.useFakeTimers();const f=fixture([row({activity:"receiving"})]);await settle();
    f.time(1100);f.rows([row()]);await f.controller.refresh();expect(f.controller.state.icon).toBe("tabCloudDownload");
    f.time(1000+SYNC_ACTIVITY_MIN_MS);await vi.advanceTimersByTimeAsync(SYNC_ACTIVITY_MIN_MS);expect(f.controller.state.icon).toBe("tabCloud");expect(f.read).toHaveBeenCalledTimes(2);
    f.rows([row({activity:"sending"})]);await f.controller.refresh();f.rows([row({enabled:false})]);await f.controller.refresh();expect(f.controller.state.visible).toBe(false);expect(f.controller.state.icon).toBe("tabCloud");f.controller.dispose();
  });
  it("a receiving hold does not obscure a new actual send, or extend forever across reads",async()=>{
    vi.useFakeTimers();const f=fixture([row({activity:"receiving"})]);await settle();f.time(1200);f.rows([row({activity:"sending"})]);await f.controller.refresh();expect(f.controller.state.icon).toBe("tabCloudUpload");
    f.time(1500);await f.controller.refresh();f.rows([row()]);await f.controller.refresh();f.time(2200);await vi.advanceTimersByTimeAsync(1000);expect(f.controller.state.icon).toBe("tabCloud");f.controller.dispose();
  });
  it("no access clears status and does not leak across contexts", async () => {
    const f=fixture();f.time(700_000);await settle();f.read.mockRejectedValue({response:{status:403}});await f.controller.refresh();expect(f.controller.state.visible).toBe(false);expect(f.controller.state.instances).toEqual([]);
    f.controller.setContext({active:false,key:"viewer"});expect(f.release).toHaveBeenCalledOnce();f.controller.dispose();
  });
  it("retires a server warning deadline when hidden or recovered",async()=>{
    vi.useFakeTimers();const f=fixture([row({status:"locked",failingSince:1000,warningAfterMs:2000})]);await settle();f.visibility(false);await vi.advanceTimersByTimeAsync(5000);expect(f.read).toHaveBeenCalledTimes(1);
    f.visibility(true);await settle();f.rows([row()]);await f.controller.refresh();await vi.advanceTimersByTimeAsync(5000);expect(f.read).toHaveBeenCalledTimes(3);expect(f.controller.state.tone).toBe("idle");f.controller.dispose();
  });
  it("a transient read failure preserves known connections, not unconfirmed activity",async()=>{
    vi.useFakeTimers();const f=fixture([row({activity:"receiving"})]);await settle();f.read.mockRejectedValue(Error("offline"));await f.controller.refresh();f.time(3000);await vi.advanceTimersByTimeAsync(2000);
    expect(f.controller.state.visible).toBe(true);expect(f.controller.state.icon).toBe("tabCloud");expect(f.controller.state.error).toBe("Could not refresh sync status.");f.controller.dispose();
  });
  it("releases hidden connections and refreshes on return, fencing old replies", async () => {
    const f=fixture();await settle();f.visibility(false);expect(f.release).toHaveBeenCalledOnce();expect(f.handlers.size).toBe(0);
    f.rows([row({status:"active",failingSince:null})]);f.visibility(true);await settle();expect(f.read).toHaveBeenCalledTimes(2);expect(f.controller.state.instances[0].status).toBe("active");f.controller.dispose();
  });
  it("a newer invalidation supersedes an in-flight snapshot", async () => {
    const f=fixture();await settle();let resolve;f.read.mockImplementationOnce(()=>new Promise(r=>resolve=r));const flight=f.controller.refresh();await settle();f.rows([row({status:"active",failingSince:null})]);f.handlers.get(TOPICS.VAULT_DRIVERS)();resolve({instances:[row()]});await flight;await settle();expect(f.controller.state.instances[0].status).toBe("active");f.controller.dispose();
  });
  it("session replacement fences an old request and clears activity",async()=>{
    const f=fixture();await settle();let resolve;f.read.mockImplementationOnce(()=>new Promise(r=>resolve=r));const flight=f.controller.refresh();await settle();f.controller.setContext({active:false,key:"viewer"});resolve({instances:[row({activity:"receiving"})]});await flight;expect(f.controller.state.visible).toBe(false);expect(f.controller.state.instances).toEqual([]);f.controller.dispose();
  });
});
