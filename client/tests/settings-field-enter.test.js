import { afterEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import SettingsField from '../components/SettingsField.vue';
import SyncSettingsPage from '../components/SyncSettingsPage.vue';
enableAutoUnmount(afterEach);
it.each(['text','number','slider'])('lets the native form own Enter without committing a %s field', async type => {
  const submit=vi.fn(), wrapper=mount({components:{SettingsField},data:()=>({field:{key:'value',label:'Value',type}}),template:'<form @submit.prevent="submit"><SettingsField :field="field" :value="1" /></form>',setup:()=>({submit})});
  const input=wrapper.get('input'),event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
  input.element.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(wrapper.findComponent(SettingsField).emitted('commit')).toBeUndefined();
  await input.trigger('blur');
  expect(submit).not.toHaveBeenCalled();
  expect(wrapper.findComponent(SettingsField).emitted('commit')).toEqual([['value']]);
});
it.each(['text','number','slider'])('retains Enter and blur commits outside a native form (%s)', async type => {
  const wrapper=mount(SettingsField,{props:{field:{key:'value',label:'Value',type},value:1,form:true}});
  const input=wrapper.get('input'),event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
  input.element.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await input.trigger('blur');
  expect(wrapper.emitted('commit')).toEqual([['value'],['value']]);
});
it('leaves Sync Label Enter uncancelled and blur does not invoke creation', async () => {
  const createInstance=vi.fn(),wrapper=mount(SyncSettingsPage,{props:{controller:{editAdd:vi.fn(),createInstance},snapshot:{loaded:true,adding:true,plugins:[{id:'test'}],instances:[],label:'Home',canCreate:true,addFields:[{key:'label',label:'Label',type:'text'}]}}});
  const input=wrapper.get('#sync-label'),event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
  input.element.dispatchEvent(event);expect(event.defaultPrevented).toBe(false);
  await input.trigger('blur');expect(createInstance).not.toHaveBeenCalled();
  // jsdom cannot implement implicit keyboard submission; native coverage proves it.
  await wrapper.get('form').trigger('submit');expect(createInstance).toHaveBeenCalledOnce();
});
