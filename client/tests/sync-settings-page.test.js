// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import SyncSettingsPage from "../components/SyncSettingsPage.vue";
import DriverInstance from "../components/settings/DriverInstance.vue";
import DriverSecretField from "../components/settings/DriverSecretField.vue";
enableAutoUnmount(afterEach);
const controller=()=>Object.fromEntries(["refresh","review","discard","startAdd","editAdd","createInstance","edit","save","toggle","syncNow","remove","editKey","saveKey","clearKey","decision"].map(name=>[name,vi.fn()]));
const button=(wrapper,text)=>wrapper.findAll("button").find(button=>button.text()===text);
describe("Sync settings rendering",()=>{
  it("renders honest empty/error/loading states and routes the plugin recovery link",async()=>{
    const c=controller(), onPlugins=vi.fn(), wrapper=mount(SyncSettingsPage,{props:{controller:c,onPlugins,snapshot:{loaded:false,loading:true,plugins:[],instances:[]}}});
    expect(wrapper.text()).toContain("Loading sync settings");expect(wrapper.text()).not.toContain("No sync set up.");
    await wrapper.setProps({snapshot:{loaded:true,plugins:[],instances:[]}});expect(wrapper.text()).toContain("No sync set up.");await button(wrapper,"Plugins").trigger("click");expect(onPlugins).toHaveBeenCalledOnce();
    await wrapper.setProps({snapshot:{loaded:true,stale:true,error:"Could not load",plugins:[],instances:[]}});expect(wrapper.text()).not.toContain("No sync set up.");await button(wrapper,"Retry reading").trigger("click");expect(c.refresh).toHaveBeenCalledOnce();
  });
  it("forwards add selection and label without giving the view workflow ownership",async()=>{
    const c=controller(),wrapper=mount(SyncSettingsPage,{props:{controller:c,snapshot:{loaded:true,plugins:[{id:"test",name:"Test remote"}],instances:[],adding:true,plugin:"test",label:"Home",canCreate:true}}});
    await wrapper.get("#sync-label").setValue("New remote");expect(c.editAdd).toHaveBeenCalledWith("label","New remote");await wrapper.get("form").trigger("submit");expect(c.createInstance).toHaveBeenCalledOnce();
  });
  it("password input starts empty, uses native password semantics and forwards only explicit intents",async()=>{
    const onEdit=vi.fn(),onSave=vi.fn(),onClear=vi.fn();const field={id:"key-home-token",label:"Access token",set:true,input:"",canSave:false,canClear:true};
    const wrapper=mount(DriverSecretField,{props:{field,editable:true,onEdit,onSave,onClear}});expect(wrapper.get("input").attributes()).toMatchObject({type:"password",autocomplete:"new-password"});expect(wrapper.get("input").element.value).toBe("");
    await wrapper.get("input").setValue("typed");expect(onEdit).toHaveBeenCalledWith("typed");expect(onSave).not.toHaveBeenCalled();await button(wrapper,"Clear").trigger("click");expect(onClear).toHaveBeenCalledOnce();
    await wrapper.setProps({field:{...field,input:"typed",canSave:true}});await button(wrapper,"Save key").trigger("click");expect(onSave).toHaveBeenCalledOnce();
  });
  it.each(["Off","Starting","Active","Locked","Failed","Paused"])("renders %s, attention and available actions with no disabled controls",async stateLabel=>{
    const onDecision=vi.fn(),onToggle=vi.fn(),onSync=vi.fn();const instance={id:"home",label:"Home",plugin:"test",pluginName:"Test remote",stateLabel,status:stateLabel.toLowerCase(),fields:[],secrets:[],attentionNotices:[],canToggle:true,canSync:true,canDecide:true,enabled:true,attention:{held:[{path:"gone.md"}],remoteEmpty:{files:[{path:"other.md"}]},issues:[{path:"bad.md",reason:"Unsupported name"}]}};
    const wrapper=mount(DriverInstance,{props:{instance,onDecision,onToggle,onSync}});expect(wrapper.get(".driver-instance__state").text()).toBe(stateLabel);expect(wrapper.findAll("[disabled]")).toHaveLength(0);
    await wrapper.get('[role="switch"]').trigger("click");expect(onToggle).toHaveBeenCalledWith("home");await button(wrapper,"Sync now").trigger("click");expect(onSync).toHaveBeenCalledWith("home");
    await button(wrapper,"Restore here").trigger("click");expect(onDecision).toHaveBeenCalledWith("home","held_restore",["gone.md"]);
    await button(wrapper,"Delete these 1 files here too").trigger("click");expect(onDecision).toHaveBeenCalledWith("home","remote_empty_delete");expect(wrapper.text()).toContain("Unsupported name");
  });
  it("gives repeated declarative fields unique label/control identities per instance",()=>{
    const row=id=>({id,label:id,pluginName:"Remote",stateLabel:"Off",status:"off",editable:true,fields:[{id:`driver-${id}-url`,field:{key:"url",label:"Endpoint",type:"text"},value:"http://remote"}],secrets:[],attentionNotices:[]});
    const wrapper=mount({components:{DriverInstance},template:'<DriverInstance :instance="a"/><DriverInstance :instance="b"/>',setup:()=>({a:row("one"),b:row("two")})});
    expect(wrapper.get('label[for="driver-one-url"]').text()).toBe("Endpoint");expect(wrapper.get('input#driver-two-url').element.value).toBe("http://remote");
  });
});
