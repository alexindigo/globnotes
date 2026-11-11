// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import SettingRow from '../components/settings/SettingRow.vue';
import PluginInventorySettingsPage from '../components/PluginInventorySettingsPage.vue';
import KeybindingsSettingsPage from '../components/KeybindingsSettingsPage.vue';
import SettingsField from '../components/SettingsField.vue';
enableAutoUnmount(afterEach);

describe('shared settings rows', () => {
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
