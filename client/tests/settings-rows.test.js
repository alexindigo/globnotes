// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import SettingRow from '../components/settings/SettingRow.vue';
import PluginInventorySettingsPage from '../components/PluginInventorySettingsPage.vue';
import KeybindingsSettingsPage from '../components/KeybindingsSettingsPage.vue';
import SettingsField from '../components/SettingsField.vue';
import SyncSettingsPage from '../components/SyncSettingsPage.vue';
import DriverInstance from '../components/settings/DriverInstance.vue';
import BrandingSettingsPage from '../components/BrandingSettingsPage.vue';
enableAutoUnmount(afterEach);

describe('shared settings rows', () => {
  it('gives Sync add one form layout and one available action row', async () => {
    const snapshot={adding:true,loaded:true,plugins:[{}],instances:[],plugin:'test',label:'Home',canCreate:true,addFields:[{key:'plugin',label:'Sync plugin',type:'select',options:[{label:'Test',value:'test'}]},{key:'label',label:'Label',type:'text'}]};
    const wrapper=mount(SyncSettingsPage,{props:{snapshot,controller:{editAdd:vi.fn(),createInstance:vi.fn()},onCancelAdd:vi.fn()}});
    expect(wrapper.findAll('.setting-row-form')).toHaveLength(2);
    expect(wrapper.get('[data-settings-actions-end]').findAll('button').map(button=>button.text())).toEqual(['Cancel','Add instance']);
    await wrapper.setProps({snapshot:{...snapshot,canCreate:false}});
    expect(wrapper.get('[data-settings-actions-end]').findAll('button').map(button=>button.text())).toEqual(['Cancel']);
    expect(wrapper.findAll('[disabled]')).toHaveLength(0);
  });
  it('uses the same form row for connection labels, typed fields and keys', () => {
    const instance={id:'home',label:'Home',editable:true,fields:[{id:'remote',field:{key:'url',label:'Remote URL',type:'text'},value:'http://remote'},{id:'atomic',field:{key:'atomic',label:'Atomic groups',type:'toggle'},value:true}],secrets:[{id:'token',key:'token',label:'Access token',input:'',set:true}],attentionNotices:[]};
    const wrapper=mount(DriverInstance,{props:{instance}});
    expect(wrapper.findAll('.setting-row-form')).toHaveLength(4);
    expect(wrapper.findAll('.setting-row:not(.setting-row-form)')).toHaveLength(0);
  });
  it('uses form rows for Branding inputs and file choices', () => {
    const snapshot={writable:true,name:'Brand',accent:'#abcdef',slots:[{id:'logo',label:'Logo'}],files:{logo:{}}};
    const wrapper=mount(BrandingSettingsPage,{props:{snapshot}});
    expect(wrapper.findAll('.setting-row-form')).toHaveLength(3);
    expect(wrapper.findAll('.setting-row:not(.setting-row-form)')).toHaveLength(0);
  });
  it('owns the label and control lanes even with a rich disclosure label', () => {
    const wrapper=mount(SettingRow,{props:{as:'value',short:true},slots:{label:'<button type="button">Disclosure</button>',default:'<button type="button">Action</button>'}});
    expect(wrapper.get('.setting-row-label button').text()).toBe('Disclosure');
    expect(wrapper.get('.setting-row-control button').text()).toBe('Action');
  });
  it('renders plugin headers and automatic policy through the same row owner without disabled controls', () => {
    const wrapper=mount(PluginInventorySettingsPage,{props:{autoEnable:{value:true,canToggle:true},rows:[{id:'test',name:'Test plugin',enabled:true,hasServer:true,canToggle:true,pages:[],attention:[]}],onAutoEnable:vi.fn(),onEnabled:vi.fn(),onExpansion:vi.fn()}});
    expect(wrapper.findAllComponents(SettingRow)).toHaveLength(2);
    expect(wrapper.get('.plugin-row-heading.setting-row').exists()).toBe(true);
    expect(wrapper.findAll('[disabled]')).toHaveLength(0);
  });
  it('hides unavailable plugin and policy actions instead of disabling them', () => {
    const wrapper=mount(PluginInventorySettingsPage,{props:{autoEnable:{value:true,canToggle:false},rows:[{id:'test',name:'Test plugin',enabled:true,hasServer:true,canToggle:false,pages:[],attention:[]}],onExpansion:vi.fn()}});
    expect(wrapper.findAll('[role="switch"],[disabled]')).toHaveLength(0);
  });
  it('renders keybinding values and remapping intents in shared rows', async () => {
    const onCapture=vi.fn(),onReset=vi.fn();
    const snapshot={id:'custom',custom:true,groups:[{name:'Editing',rows:[{action:'save',label:'Save note',assigned:true,display:'Ctrl+S',modified:true}]}]};
    const wrapper=mount(KeybindingsSettingsPage,{props:{layers:[],snapshot,onCapture,onReset,onLayer:vi.fn()}});
    const row=wrapper.findComponent(SettingRow);
    expect(row.props()).toMatchObject({label:'Save note',as:'value',short:true});
    await row.get('button[aria-label^="Remap"]').trigger('click');expect(onCapture).toHaveBeenCalledWith('save');
    expect(row.get('.setting-row-control').text()).toContain('Ctrl+S');
  });
  it('gives every choice a structural icon lane and retains typed values', async () => {
    const wrapper=mount(SettingsField,{props:{id:'choice',field:{key:'choice',label:'Choice',type:'select',options:[{label:'One',value:1},{label:'Two',value:2}]},value:1}});
    expect(wrapper.get('[data-settings-select] [data-select-icon]').exists()).toBe(true);
    await wrapper.get('select').setValue('2');expect(wrapper.emitted('edit')).toEqual([[{key:'choice',raw:2}]]);
  });
});
