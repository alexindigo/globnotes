import { afterEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import PluginInventorySettingsPage from '../components/PluginInventorySettingsPage.vue';
import SettingRow from '../components/settings/SettingRow.vue';
enableAutoUnmount(afterEach);
it.each([true,false])('retains an unmuted plugin state value when toggling is unavailable (%s)', enabled => {
  const wrapper=mount(PluginInventorySettingsPage,{props:{autoEnable:{value:enabled,canToggle:false},rows:[{id:'test',name:'Test plugin',enabled,hasServer:true,canToggle:false,pages:[],attention:[]}],onExpansion:vi.fn()}});
  const heading=wrapper.get('.plugin-row-heading');
  expect(wrapper.findAllComponents(SettingRow).find(row=>row.classes().includes('plugin-row-heading')).props('as')).toBe('value');
  const value=heading.get('.plugin-row-toggle-lane > .settings-text');
  expect(value.text()).toBe(enabled?'On':'Off');
  expect(value.classes()).not.toContain('text-theme-text-muted');
  expect(heading.findAll('[role=switch],[disabled]')).toHaveLength(0);
});
