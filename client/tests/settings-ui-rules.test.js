// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import CustomButton from '../components/CustomButton.vue';
import ConfirmModal from '../components/ConfirmModal.vue';
import SettingsField from '../components/SettingsField.vue';
import BrandingSettingsPage from '../components/BrandingSettingsPage.vue';
import KeybindingsSettingsPage from '../components/KeybindingsSettingsPage.vue';
import PluginPermissions from '../components/settings/PluginPermissions.vue';
import InventoryRecovery from '../components/settings/InventoryRecovery.vue';
import TextInput from '../components/TextInput.vue';
import { readFileSync } from 'node:fs';
enableAutoUnmount(afterEach);

describe('Settings UI rules', () => {
  it('shares fixed-pixel Settings typography between actions, inputs and value rows', () => {
    const settingsStyles=readFileSync('client/style.css','utf8');
    expect(settingsStyles).toMatch(/\.settings-text\s*\{\s*font-size:\s*14px;\s*line-height:\s*21px;/);
    expect(settingsStyles).toMatch(/\.settings-help\s*\{\s*font-size:\s*13px;\s*line-height:\s*19\.5px;/);
    const action=mount(CustomButton,{props:{size:'settings',label:'Action'}});
    const input=mount(TextInput,{props:{variant:'settings'}});
    const value=mount(SettingsField,{props:{field:{key:'message',label:'Message',type:'text'},value:'Saved',readonly:true}});
    for(const wrapper of [action,input,value.get('#settings-field-message')]){
      expect(wrapper.classes()).toContain('settings-text');
      expect(wrapper.classes()).not.toContain('text-sm');
    }
    expect(value.get('[role=note]').classes()).toContain('settings-help');
  });
  it('opts text actions into normal foreground without changing other callers', () => {
    const ordinary=mount(CustomButton,{props:{variant:'text',label:'Other caller'}});
    const settings=mount(CustomButton,{props:{variant:'text',textTone:'normal',label:'Settings action'}});
    expect(ordinary.classes()).toContain('text-theme-text-muted');
    expect(settings.classes()).toContain('text-theme-text');
    expect(settings.classes()).not.toContain('text-theme-text-muted');
  });
  it.each([
    ['toggle',false,'Off'],['toggle',true,'On'],['color','#abcdef','#abcdef'],
    ['slider',3,'3'],['select',2,'Two'],['text','Name','Name'],
    ['textarea','Notes','Notes'],['number',5,'5'],['folder','/vault','/vault'],['file','Note.md','Note.md'],
  ])('shows the applied %s value instead of an unavailable control', (type,value,display) => {
    const field={key:'value',label:'Value',type,options:[{value:2,label:'Two'}]};
    const wrapper=mount(SettingsField,{props:{id:'readonly-value',field,value,readonly:true}});
    expect(wrapper.findAll('button,input,select,textarea,[disabled]')).toHaveLength(0);
    expect(wrapper.get('#readonly-value').text()).toBe(display);
    expect(wrapper.text()).toContain('Changes are unavailable for this setting.');
    expect(wrapper.find('label[for]').exists()).toBe(false);
  });
  it('keeps copyable text but hides folder browsing under read-only authority', () => {
    const wrapper=mount(SettingsField,{props:{field:{key:'folder',label:'Folder',type:'folder'},value:'/vault',readonly:true,onBrowse:vi.fn()}});
    expect(wrapper.get('#settings-field-folder').element.tagName).toBe('SPAN');
    expect(wrapper.get('#settings-field-folder').text()).toBe('/vault');
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(false);
  });
  it('hides unavailable confirmation only when its caller asks', () => {
    const options={props:{modelValue:true,confirmDisabled:true,hideUnavailable:true},global:{directives:{focus:{}}}};
    const wrapper=mount(ConfirmModal,options);
    expect(wrapper.findAllComponents(CustomButton).map(button=>button.props('label'))).toEqual(['Cancel']);
    const ordinary=mount(ConfirmModal,{...options,props:{...options.props,hideUnavailable:false}});
    expect(ordinary.findAllComponents(CustomButton).find(button=>button.props('label')==='Confirm').props('disabled')).toBe(true);
  });
  it('keeps Branding values and the read-only explanation without dead actions', () => {
    const snapshot={writable:false,slots:[],files:{},name:'Brand',accent:'#abcdef',canSave:false,canReset:false,canCancel:false};
    const wrapper=mount(BrandingSettingsPage,{props:{snapshot}});
    expect(wrapper.text()).toContain('branding changes are unavailable');
    expect(wrapper.text()).toContain('#abcdef');
    expect(wrapper.findAll('button,[disabled],input[type=color]')).toHaveLength(0);
  });
  it('renders binding data but no static description or shortcut tooltip', () => {
    const wrapper=mount(KeybindingsSettingsPage,{props:{layers:[{id:'custom',label:'Custom',description:'Ctrl+E static hint'}],snapshot:{id:'custom',custom:true,description:'Ctrl+E static hint',groups:[{name:'App',rows:[{action:'save',label:'Save',display:'Chosen key',assigned:true}]}]},onLayer:vi.fn(),onCapture:vi.fn(),onReset:vi.fn()}});
    expect(wrapper.text()).toContain('Chosen key');
    expect(wrapper.text()).not.toContain('Ctrl+E');
    expect(wrapper.find('[title="Ctrl+E static hint"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('press Escape');
  });
  it('retains recovery explanations but never renders unavailable actions', () => {
    const recovery={text:'Outcome unknown. Your choice is retained.',pendingText:'Reading current state...',canDiscard:false,canReview:false,canRetry:false};
    const inventory=mount(InventoryRecovery,{props:{recovery}});
    expect(inventory.text()).toContain(recovery.text);
    expect(inventory.findAll('button,[disabled]')).toHaveLength(0);
    const permissions=mount(PluginPermissions,{props:{view:{id:'test',available:true,allowNetwork:true,canChange:false,network:[],imports:[],requests:[],pendingText:recovery.pendingText,recovery}}});
    expect(permissions.text()).toContain('On');
    expect(permissions.text()).toContain(recovery.pendingText);
    expect(permissions.findAll('button,[disabled],label[for]')).toHaveLength(0);
  });
});
