import { afterEach, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import SettingsField from '../components/SettingsField.vue';
enableAutoUnmount(afterEach);
const value='first\n  second\n\n    third\n'+ 'unbroken'.repeat(80);
it('retains line breaks and indentation in the shared read-only textarea value', () => {
  const wrapper=mount(SettingsField,{props:{field:{key:'instructions',label:'Instructions',type:'textarea'},value,readonly:true,provenance:{source:'environment',readonly:true}}});
  const displayed=wrapper.get('#settings-field-instructions');
  expect(displayed.element.tagName).toBe('SPAN');
  expect(displayed.element.textContent).toBe(value);
  expect(displayed.classes()).toContain('settings-field-multiline-value');
  expect(wrapper.find('textarea').exists()).toBe(false);
  expect(wrapper.text()).toContain('Set by the server configuration');
});
it('does not apply multiline whitespace styling to single-line retained values', () => {
  const wrapper=mount(SettingsField,{props:{field:{key:'name',label:'Name',type:'text'},value:'first  second',readonly:true}});
  const displayed=wrapper.get('#settings-field-name');
  expect(displayed.element.textContent).toBe('first  second');
  expect(displayed.classes()).not.toContain('settings-field-multiline-value');
});
