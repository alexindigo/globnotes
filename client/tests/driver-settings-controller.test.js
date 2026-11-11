// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { watch } from "vue";
import { createDriverSettings } from "../driverSettingsController.js";
import { TOPICS } from "../bus/index.js";
import remotelySave from "../../plugins/globnotes-remotely-save/manifest.json";
vi.mock("../router.js", () => ({ default:{} }));
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export const declaration = { settings:[{key:"baseUrl",label:"Endpoint",type:"text",default:""},{key:"limit",label:"Limit",type:"number",min:1,default:2}], secrets:[{key:"token",label:"Access token"}], capabilities:{mutations:{create:"emulated",update:"conditional",delete:"conditional"}} };
export const instance = () => ({ id:"home", label:"Home", plugin:"test", pluginName:"Test remote", revision:1, enabled:false, settings:{baseUrl:"http://remote",limit:2}, declaration:copy(declaration), secrets:[{key:"token",label:"Access token",set:false,updatedAt:null}], status:"off",reason:null,error:null,lastSync:null,nextRetry:null,attention:{revision:10,held:[],remoteEmpty:null,issues:[],notices:[]} });
const owned = [];
afterEach(() => { owned.splice(0).forEach(controller => controller.dispose()); vi.useRealTimers(); });
function fixture(options = {}) {
  const view = { revision:1,notice:"Keys are stored in /vault/.globnotes; tools that copy the whole vault folder copy them too.",plugins:[{id:"test",name:"Test remote",driver:copy(declaration)}],instances:[instance()] };
  const events = new Map(), off = vi.fn(), release = vi.fn(), unload = {set:vi.fn(),dispose:vi.fn()};
  const read = vi.fn(async () => copy(view));
  const update = vi.fn(async (id,payload) => { Object.assign(view.instances.find(row=>row.id===id),copy(payload),{revision:payload.revision+1}); return {id,revision:payload.revision+1}; });
  const setKey = vi.fn(async (id,key,payload) => { const row=view.instances.find(row=>row.id===id); row.revision++; row.secrets[0].set=true; return {id,revision:row.revision}; });
  const remove = vi.fn(async id => { view.instances=view.instances.filter(row=>row.id!==id); return {id,removed:true}; });
  const decide = vi.fn(async id => ({id,revision:1})), sync=vi.fn(async id=>({id,revision:1}));
  const confirm=vi.fn(async()=>"cancel"), confirmRemove=vi.fn(async()=>true);
  const acquireChanges=vi.fn(()=>release), subscribe=vi.fn((topic, fn)=>{events.set(topic,fn);return off;});
  const controller = createDriverSettings({read,update,setKey,remove,decide,sync,confirm,confirmRemove,acquireChanges,subscribe,unload,...options}); owned.push(controller);
  return {controller,view,read,update,setKey,remove,decide,sync,confirm,confirmRemove,events,off,release,unload,acquireChanges,subscribe};
}
const loaded = async options => { const f=fixture(options);f.controller.activate();await flushPromises();return f; };
const row = f => f.controller.state.instances[0];
describe("Sync workflow ownership", () => {
  it('projects add-form choice descriptors without moving derivation into the view',async()=>{
    const f=await loaded();
    expect(f.controller.state.addFields).toEqual([{key:'plugin',label:'Sync plugin',type:'select',options:[{label:'Test remote',value:'test'}]},{key:'label',label:'Label',type:'text',maxLength:128}]);
    expect(f.controller.startAdd()).toBe(true);f.controller.editAdd('label','Home two');
    expect(f.controller.state.label).toBe('Home two');
  });
  it("projects shipped backend/auth/encryption visibility from drafts without erasing hidden settings or keys", async () => {
    const f=fixture(), definition=copy(remotelySave.driver), base=f.view.instances[0];
    base.declaration=definition;
    base.settings=Object.fromEntries(definition.settings.map(field=>[field.key,field.default]));
    Object.assign(base.settings,{s3Bucket:"retained-bucket",webdavUrl:"http://retained-dav"});
    base.secrets=definition.secrets.map(secret=>({...secret,set:true,updatedAt:"saved"}));
    f.controller.activate();await flushPromises();
    const fields=()=>row(f).fields.map(item=>item.field.key), keys=()=>row(f).secrets.map(item=>item.key);
    expect(fields()).toContain("s3Bucket");expect(fields()).not.toContain("webdavUrl");
    expect(keys()).toEqual(["s3_access_key","s3_secret_key","s3_session_token"]);
    f.controller.editKey("home","s3_access_key","retained-input");
    f.controller.edit("home","backend","webdav");
    expect(fields()).toContain("webdavUrl");expect(fields()).not.toContain("s3Bucket");expect(keys()).toEqual([]);
    expect(f.controller.saveKey("home","s3_access_key")).toBe(false);
    for(const auth of ["basic","digest"]) {f.controller.edit("home","webdavAuth",auth);expect(keys()).toEqual(["webdav_password"]);}
    for(const encryption of ["openssl-base64","rclone-base64"]) {f.controller.edit("home","encryption",encryption);expect(keys()).toEqual(["webdav_password","encryption_password"]);}
    f.controller.edit("home","encryption","none");expect(keys()).toEqual(["webdav_password"]);
    expect(await f.controller.save("home")).toBe(true);await flushPromises();
    expect(f.update.mock.calls[0][1].settings).toMatchObject({backend:"webdav",s3Bucket:"retained-bucket",webdavUrl:"http://retained-dav",encryption:"none"});
    expect(f.setKey).not.toHaveBeenCalled();expect(f.view.instances[0].secrets.every(secret=>secret.set)).toBe(true);
    f.controller.edit("home","backend","s3");expect(keys()).toEqual(["s3_access_key","s3_secret_key","s3_session_token"]);
    expect(row(f).secrets[0].input).toBe("retained-input");expect(row(f).fields.find(item=>item.field.key==="s3Bucket").value).toBe("retained-bucket");
  });
  it("starts lazily, subscribes before reading and projects empty/error without invented success", async () => {
    const f=fixture();expect(f.read).not.toHaveBeenCalled();f.view.instances=[];f.controller.activate();await flushPromises();
    expect(f.subscribe.mock.invocationCallOrder[0]).toBeLessThan(f.read.mock.invocationCallOrder[0]);
    expect(f.controller.state).toMatchObject({loaded:true,instances:[],error:""});
    f.read.mockRejectedValue(Error("failed"));await f.controller.refresh();expect(f.controller.state.stale).toBe(true);expect(f.controller.state.error).toContain("Could not load");
    f.controller.dispose();expect(f.release).toHaveBeenCalledOnce();expect(f.off).toHaveBeenCalledTimes(2);
  });
  it("coalesces invalidations during reads and ignores the superseded snapshot", async () => {
    const first=deferred(), f=fixture({read:vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({revision:2,notice:null,plugins:[],instances:[]})});
    f.controller.activate();await flushPromises();f.events.get(TOPICS.VAULT_DRIVERS)();f.events.get(TOPICS.VAULT_DRIVERS)();
    first.resolve(f.view);await flushPromises();expect(f.controller.state.instances).toHaveLength(0);expect(f.controller.state.loaded).toBe(true);
  });
  it("uses visible draft values with the instance CAS and preserves newer typing on acknowledgement", async () => {
    const f=await loaded(), held=deferred();f.update.mockReturnValueOnce(held.promise);
    f.controller.edit("home","baseUrl","http://chosen");f.controller.edit("home","limit","3");const saving=f.controller.save("home");await flushPromises();
    expect(f.update).toHaveBeenCalledWith("home",{revision:1,label:"Home",enabled:false,settings:{baseUrl:"http://chosen",limit:3}});
    f.controller.edit("home","baseUrl","http://newer");Object.assign(f.view.instances[0],{revision:2,settings:{baseUrl:"http://chosen",limit:3}});
    held.resolve({id:"home",revision:2});expect(await saving).toBe(true);await flushPromises();
    expect(row(f).fields[0].value).toBe("http://newer");expect(row(f).dirty).toBe(true);expect(row(f).canSave).toBe(true);
  });
  it("validates raw fields and retains them across explicit Save/Discard/Cancel departure", async () => {
    const f=await loaded();f.controller.edit("home","limit","");expect(row(f).canSave).toBe(false);expect(row(f).fields[1].error).toBeTruthy();
    expect(await f.controller.resolveDeparture("closing Settings")).toBe(false);expect(row(f).fields[1].value).toBe("");expect(f.unload.set).toHaveBeenLastCalledWith(true);
    f.confirm.mockResolvedValue("discard");expect(await f.controller.resolveDeparture("closing Settings")).toBe(true);expect(row(f).fields[1].value).toBe(2);
    f.controller.edit("home","baseUrl","http://saved");f.confirm.mockResolvedValue("save");expect(await f.controller.resolveDeparture("closing Settings")).toBe(true);expect(f.view.instances[0].settings.baseUrl).toBe("http://saved");
  });
  it("keeps key values out of historical snapshots, clears only the settled PUT input and never puts them in review intent", async () => {
    const f=await loaded(), held=deferred();f.setKey.mockReturnValueOnce(held.promise);const before=row(f);
    f.controller.editKey("home","token","secret-one");expect(before.secrets[0].input).toBe("secret-one");const saving=f.controller.saveKey("home","token");await flushPromises();
    expect(f.setKey).toHaveBeenCalledWith("home","token",{revision:1,value:"secret-one"});f.controller.editKey("home","token","secret-two");
    f.view.instances[0].revision=2;held.resolve({id:"home",revision:2});expect(await saving).toBe(true);await flushPromises();expect(row(f).secrets[0].input).toBe("secret-two");
    const saved=f.controller.saveKey("home","token");await saved;await flushPromises();expect(before.secrets[0].input).toBe("");expect(JSON.stringify(f.controller.state)).not.toContain("secret-");
    f.controller.editKey("home","token","secret-three");expect(await f.controller.resolveDeparture("closing Settings")).toBe(false);expect(f.confirm).toHaveBeenLastCalledWith(expect.objectContaining({canSave:false}));
    f.controller.dispose();expect(before.secrets[0].input).toBe("");expect(f.unload.dispose).toHaveBeenCalled();
  });
  it("clears key input on rejected PUT, retains newer input and does not log/echo secret-bearing errors", async () => {
    const f=await loaded();f.setKey.mockRejectedValueOnce(Error("secret-marker"));f.controller.editKey("home","token","secret-marker");
    expect(await f.controller.saveKey("home","token")).toBe(false);await flushPromises();expect(row(f).secrets[0].input).toBe("");expect(JSON.stringify(f.controller.state)).not.toContain("secret-marker");
    expect(f.controller.state.unknown).toBe(true);expect(f.controller.toggle("home")).toBe(false);await f.controller.review();
    expect(f.setKey).toHaveBeenCalledTimes(1);expect(row(f).secrets[0].canSave).toBe(false);
  });
  it("a timed-out original wire cannot be discarded, reviewed or escaped; its late receipt never acknowledges newer input", async () => {
    vi.useFakeTimers();const held=deferred(), f=await loaded({setKey:()=>held.promise});f.controller.editKey("home","token","first");
    const saving=f.controller.saveKey("home","token");await vi.advanceTimersByTimeAsync(5000);expect(await saving).toBe(false);
    expect(f.controller.state).toMatchObject({busy:true,unknown:true,canReview:false});expect(f.controller.discard()).toBe(false);expect(await f.controller.review()).toBe(false);
    const departure=f.controller.resolveDeparture("logout");await vi.advanceTimersByTimeAsync(5000);expect(await departure).toBe(false);
    f.controller.editKey("home","token","newer");f.view.instances[0].revision=2;held.resolve({id:"home",revision:2});await flushPromises();
    expect(f.controller.state.unknown).toBe(false);expect(row(f).secrets[0].input).toBe("newer");
  });
  it.each([409,503])("requires fresh review after a %s before a new explicit settings choice", async status => {
    const f=await loaded();f.controller.edit("home","baseUrl","http://mine");f.update.mockRejectedValueOnce({response:{status,data:{code:status===409?"driver_stale":"operation_partial"}}});
    expect(await f.controller.save("home")).toBe(false);await flushPromises();f.view.instances[0].revision=3;
    expect(await f.controller.save("home")).toBe(false);expect(await f.controller.review()).toBe(true);expect(f.update).toHaveBeenCalledTimes(1);expect(row(f).fields[0].value).toBe("http://mine");
    expect(await f.controller.save("home")).toBe(true);expect(f.update.mock.calls[1][1].revision).toBe(3);
  });
  it("does not replace a dirty schema with a changed declaration or make review permission to submit it", async () => {
    const f=await loaded();f.controller.edit("home","baseUrl","http://mine");f.view.instances[0].declaration.settings=[];await f.controller.refresh();
    expect(row(f).fields[0].field.key).toBe("baseUrl");expect(row(f).schemaChanged).toBe(true);await f.controller.review();expect(row(f).canSave).toBe(false);expect(row(f).editable).toBe(false);
    f.controller.discard("home");expect(row(f).fields).toEqual([]);
  });
  it("stale attention is read again, never replayed; the new explicit decision uses both fresh revisions", async () => {
    const f=await loaded();Object.assign(f.view.instances[0],{enabled:true,status:"active",attention:{revision:11,held:[{path:"gone.md"}],remoteEmpty:null,issues:[],notices:[]}});await f.controller.refresh();
    f.decide.mockRejectedValueOnce({response:{status:409,data:{code:"driver_stale"}}});expect(await f.controller.decision("home","held_restore",["gone.md"])).toBe(false);await flushPromises();
    f.view.instances[0].revision=2;f.view.instances[0].attention.revision=12;await f.controller.review();expect(f.decide).toHaveBeenCalledTimes(1);
    await f.controller.decision("home","held_delete");expect(f.decide).toHaveBeenLastCalledWith("home",{instanceRevision:2,attentionRevision:12,action:"held_delete"});
  });
  it("confirms removal against the captured instance and never deletes while key input is unsaved", async () => {
    const f=await loaded();f.controller.editKey("home","token","typed");expect(await f.controller.remove("home")).toBe(false);expect(f.confirmRemove).not.toHaveBeenCalled();
    f.controller.editKey("home","token","");expect(await f.controller.remove("home")).toBe(true);expect(f.confirmRemove).toHaveBeenCalledWith("Home");expect(f.remove).toHaveBeenCalledWith("home",{revision:1});
  });
  it.each(["unchanged","runtime state"])("removal confirmation survives a %s refresh of the same instance revision",async change=>{
    const answer=deferred(), f=await loaded({confirmRemove:()=>answer.promise});
    const removing=f.controller.remove("home");await flushPromises();
    if(change==="runtime state")Object.assign(f.view.instances[0],{status:"active",lastSync:123456,attention:{...f.view.instances[0].attention,revision:11}});
    await f.controller.refresh();expect(row(f).canRemove).toBe(true);
    answer.resolve(true);expect(await removing).toBe(true);await flushPromises();
    expect(f.remove).toHaveBeenCalledExactlyOnceWith("home",{revision:1});expect(f.controller.state.instances).toEqual([]);
  });
  it.each(["revision","binding","removed","session","disposed"])("removal confirmation cannot cross a changed %s",async change=>{
    let session="one";const answer=deferred(), f=await loaded({confirmRemove:()=>answer.promise,getSession:()=>session});
    const removing=f.controller.remove("home");await flushPromises();
    if(change==="revision")f.view.instances[0].revision++;
    if(change==="binding")f.view.instances[0].plugin="replacement";
    if(change==="removed")f.view.instances=[];
    if(change==="session")session="two";
    if(change==="disposed")f.controller.dispose();else await f.controller.refresh();
    answer.resolve(true);expect(await removing).toBe(false);expect(f.remove).not.toHaveBeenCalled();
  });
  it("creates off without sending a draft secret/settings and cancels only the add draft", async () => {
    const create=vi.fn(async()=>({id:"new",revision:1})), f=await loaded({create});f.controller.startAdd();f.controller.editAdd("label","New remote");
    await f.controller.createInstance();expect(create).toHaveBeenCalledWith({plugin:"test",label:"New remote"});expect(f.controller.state.adding).toBe(false);
    f.controller.edit("home","baseUrl","retained");f.controller.startAdd();await f.controller.cancelAdd();expect(row(f).dirty).toBe(true);expect(f.controller.state.adding).toBe(false);
  });
  it("hides writes under read-only authority and fences a pending old-session read", async () => {
    let key="one";const held=deferred(), f=fixture({read:()=>held.promise,getSession:()=>key,writable:()=>false});f.controller.activate();key="two";held.resolve(f.view);await flushPromises();expect(f.controller.state.loaded).toBe(false);
    await f.controller.refresh();expect(row(f).editable).toBe(false);expect(row(f).canToggle).toBe(false);expect(f.controller.startAdd()).toBe(false);
  });
  it("disposal fences late writes and clears live key getters", async () => {
    const held=deferred(), f=await loaded({setKey:()=>held.promise});f.controller.editKey("home","token","never-retained");const old=row(f), saving=f.controller.saveKey("home","token");await flushPromises();
    f.controller.dispose();held.resolve({id:"home",revision:2});expect(await saving).toBe(false);expect(old.secrets[0].input).toBe("");expect(f.controller.state.instances).toEqual([]);
  });
  it("one explicit review drains a coalesced read instead of losing the user's review intent",async()=>{
    const f=await loaded();f.controller.edit("home","baseUrl","http://mine");f.update.mockRejectedValueOnce(Error("lost reply"));await f.controller.save("home");await flushPromises();
    const held=deferred();f.read.mockReturnValueOnce(held.promise);const reading=f.controller.refresh();await flushPromises();
    const reviewing=f.controller.review();held.resolve(copy(f.view));await reading;expect(await reviewing).toBe(true);expect(f.controller.state.unknown).toBe(false);expect(row(f).canSave).toBe(true);
  });
  it("a successful receipt does not leave its own newer draft flagged stale by a preceding refresh",async()=>{
    const held=deferred(), f=await loaded({update:()=>held.promise});f.controller.edit("home","baseUrl","http://first");
    const saving=f.controller.save("home");await flushPromises();f.controller.edit("home","baseUrl","http://newer");
    Object.assign(f.view.instances[0],{revision:2,settings:{baseUrl:"http://first",limit:2}});
    held.resolve({id:"home",revision:2});expect(await saving).toBe(true);await flushPromises();expect(row(f).changed).toBe(false);expect(row(f).canSave).toBe(true);
  });
  it("fresh reads mark a dirty external base stale, but explicit discard removes that review obligation",async()=>{
    const f=await loaded();f.controller.edit("home","prefix","not-a-field");f.controller.edit("home","baseUrl","http://mine");f.view.instances[0].revision=2;await f.controller.refresh();expect(row(f).changed).toBe(true);
    f.controller.discard("home");expect(f.controller.state.canReview).toBe(false);expect(row(f).changed).toBe(false);
  });
  it("computed actions follow the retained reservation as its wire settles before acknowledgement",async()=>{
    const f=await loaded();expect(f.controller.state.canAdd).toBe(true);f.controller.edit("home","baseUrl","http://mine");const held=deferred();f.update.mockReturnValueOnce(held.promise);
    const saving=f.controller.save("home");await flushPromises();expect(f.controller.state.canAdd).toBe(false);expect(f.controller.state.canReview).toBe(false);
    const stop=watch(()=>f.controller.state.busy,()=>{void f.controller.state.canReview;void f.controller.state.canAdd;},{flush:"sync"});Object.assign(f.view.instances[0],{revision:2,settings:{baseUrl:"http://mine",limit:2}});held.resolve({id:"home",revision:2});await saving;await flushPromises();stop();
    expect(f.controller.state.canReview).toBe(false);expect(f.controller.state.canAdd).toBe(true);
  });
  it("a write receipt cannot lend old attention revisions to the next action while its fresh snapshot is held",async()=>{
    const f=await loaded();f.view.instances[0].enabled=true;await f.controller.refresh();const held=deferred();f.read.mockReturnValue(held.promise);
    expect(await f.controller.syncNow("home")).toBe(true);await flushPromises();expect(row(f).canDecide).toBe(false);expect(row(f).canToggle).toBe(false);
    held.resolve(copy(f.view));await flushPromises();expect(row(f).canDecide).toBe(true);
  });
  it("unknown On/Off choices survive read-back as visible drafts for an explicit retry",async()=>{
    const f=await loaded();f.update.mockRejectedValueOnce(Error("lost toggle reply"));expect(await f.controller.toggle("home")).toBe(false);await flushPromises();
    expect(await f.controller.review()).toBe(true);expect(row(f).enabled).toBe(true);expect(row(f).canSave).toBe(true);expect(f.update).toHaveBeenCalledTimes(1);
    expect(await f.controller.save("home")).toBe(true);expect(f.update.mock.calls[1][1]).toMatchObject({enabled:true,revision:1});
  });
  it("departure Save waits for a fresh snapshot between instance drafts",async()=>{
    const f=fixture(), held=deferred();f.view.instances.push({...instance(),id:"work",label:"Work"});
    f.controller.activate();await flushPromises();
    f.controller.edit("home","baseUrl","http://home-chosen");f.controller.edit("work","baseUrl","http://work-chosen");
    f.read.mockReturnValueOnce(held.promise);let settled=false;
    const departure=f.controller.resolveDeparture("closing Settings","save").then(result=>{settled=true;return result;});
    await flushPromises();expect(f.update).toHaveBeenCalledTimes(1);expect(settled).toBe(false);
    held.resolve(copy(f.view));expect(await departure).toBe(true);
    expect(f.update.mock.calls.map(([id])=>id)).toEqual(["home","work"]);
    expect(f.view.instances.map(row=>row.settings.baseUrl)).toEqual(["http://home-chosen","http://work-chosen"]);
    expect(f.controller.hasWork()).toBe(false);
  });
  it.each(["failed","changed"])("departure Save retains later drafts after a %s inter-instance read",async ending=>{
    const f=fixture(), held=deferred();f.view.instances.push({...instance(),id:"work",label:"Work"});
    f.controller.activate();await flushPromises();
    f.controller.edit("home","label","Home chosen");f.controller.edit("work","label","Work chosen");
    f.read.mockReturnValue(held.promise);
    const departure=f.controller.resolveDeparture("logout","save");await flushPromises();
    expect(f.update).toHaveBeenCalledTimes(1);
    if(ending==="failed")held.reject(Error("read unavailable"));else {f.view.instances[1].revision=2;held.resolve(copy(f.view));}
    expect(await departure).toBe(false);expect(f.update).toHaveBeenCalledTimes(1);
    if(ending==="failed")expect(f.controller.state.stale).toBe(true);
    expect(f.controller.state.instances.find(row=>row.id==="work")).toMatchObject({label:"Work chosen",dirty:true});
  });
  it("departure Save can use an accepted fresh follow-up after a superseded read fails",async()=>{
    const f=fixture(), held=deferred();f.view.instances.push({...instance(),id:"work",label:"Work"});
    f.controller.activate();await flushPromises();
    f.controller.edit("home","label","Home chosen");f.controller.edit("work","label","Work chosen");
    f.read.mockReturnValueOnce(held.promise);
    const departure=f.controller.resolveDeparture("closing Settings","save");await flushPromises();
    f.events.get(TOPICS.VAULT_DRIVERS)();held.reject(Error("superseded read failed"));
    expect(await departure).toBe(true);expect(f.controller.state.stale).toBe(false);
    expect(f.update.mock.calls.map(([id])=>id)).toEqual(["home","work"]);expect(f.controller.hasWork()).toBe(false);
  });
});
