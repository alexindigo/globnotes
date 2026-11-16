// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import SettingsPage from '../components/settings/SettingsPage.vue';
import StatusLine from '../components/StatusLine.vue';
enableAutoUnmount(afterEach);

it('owns one persistent status slot between the title and header action', async () => {
  const wrapper = mount(SettingsPage, { props: { title: 'Preferences' }, slots: { default: '<input>', action: '<button>Manage</button>' } });
  const status = wrapper.getComponent(StatusLine);
  const element = status.element;
  expect(element.previousElementSibling.tagName).toBe('H2');
  expect(element.nextElementSibling.tagName).toBe('BUTTON');
  expect(element.parentElement.classList.contains('settings-page-heading')).toBe(true);
  expect(wrapper.get('header').element.nextElementSibling.tagName).toBe('INPUT');
  expect(status.classes()).toContain('text-theme-text-muted');
  expect(status.props('message')).toBe('');
  await wrapper.setProps({ status: 'Saving...' });
  expect(wrapper.findAllComponents(StatusLine)).toHaveLength(1);
  expect(wrapper.get('[role=status]').element).toBe(element);
  expect(status.props('message')).toBe('Saving...');
  await wrapper.setProps({ status: '' });
  expect(wrapper.get('[role=status]').element).toBe(element);
  expect(status.text()).toBe('');
});
