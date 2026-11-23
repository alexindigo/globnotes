// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-only
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createAccountSettingsState } from "../accountSettingsState.js";
import { createIdentitySetupFormState } from "../setupFormState.js";
import { createIdentityLoginState } from "../loginFlow.js";
import AccountSettings from "../components/settings/AccountSettings.vue";
import RequiredPasswordForm from "../components/RequiredPasswordForm.vue";
import IdentitySetupForm from "../components/IdentitySetupForm.vue";
import IdentityLoginForm from "../components/IdentityLoginForm.vue";
import PasswordField from "../components/PasswordField.vue";
import IdentityDialog from "../components/IdentityDialog.vue";
import TextInput from "../components/TextInput.vue";

const wrappers = [], controllers = [];
beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => { for (const w of wrappers.splice(0)) w.unmount(); for (const c of controllers.splice(0)) await c.dispose(); document.body.innerHTML = ""; });
const render = (component, controller, props = {}) => { controllers.push(controller); const wrapper = mount(component, { props: { controller, ...props }, attachTo: document.body }); wrappers.push(wrapper); return wrapper; };
it("Your account shows personal credential controls, not vault access", async () => {
  const c = createAccountSettingsState({ read: async () => ({ login: "alice", credentialRevision: 1, totpEnabled: true }), token: () => "token" });
  await c.load(); const w = render(AccountSettings, c);
  expect(w.text()).toContain("Your account"); expect(w.text()).toContain("Password + authenticator");
  expect(w.findAll('input[type="password"]')).toHaveLength(3); expect(w.find('#account-current-code').exists()).toBe(true);
  expect(w.text()).toContain("Replace authenticator"); expect(w.text()).not.toContain("Everybody else"); expect(w.findAll('[disabled]')).toHaveLength(0);
});
it("recipient renders two private-password fields and logout, without current-password or vault controls", async () => {
  const c = createAccountSettingsState({ read: async () => ({ login: "jordan", credentialRevision: 0, passwordChangeRequired: true, totpEnabled: false }), token: () => "token" });
  await c.load(); const w = render(RequiredPasswordForm, c);
  expect(w.text()).toContain("jordan"); expect(w.findAll('input[type="password"]')).toHaveLength(2);
  expect(w.text()).not.toContain("Current password"); expect(w.text()).not.toContain("Authenticator"); expect(w.text()).toContain("Log out");
});
it("setup displays View, no guest Admin, and forwards radio and field intents", async () => {
  const c = createIdentitySetupFormState({ submit: vi.fn() }), w = render(IdentitySetupForm, c);
  expect(w.find('input[value="view"]').element.checked).toBe(true);
  expect(w.findAll('input[type="radio"]').map(n => n.attributes('value'))).toEqual(["edit", "view", "none"]);
  await w.find('input[value="none"]').setValue(true); await w.find('#setup-login').setValue("alex");
  expect([c.state.everybody, c.state.username]).toEqual(["none", "alex"]);
});
it("setup disables native choices while their submitted snapshot is frozen", async () => {
  const entered = Promise.withResolvers(), response = Promise.withResolvers();
  const c = createIdentitySetupFormState({ submit(data) { entered.resolve(data); return response.promise; } }), w = render(IdentitySetupForm, c);
  c.setField("username", "alice"); c.setField("password", "test");
  const request = c.finish();
  expect((await entered.promise).everybody).toBe("view");
  expect(w.find('input[value="none"]').element.matches(":disabled")).toBe(true);
  expect(w.find('#setup-login').element.matches(":disabled")).toBe(true);
  response.reject({ status: 422 }); await request;
  expect(w.find('input[value="view"]').element.checked).toBe(true);
  expect(w.find('input[value="none"]').element.matches(":disabled")).toBe(false);
});
it("the shared sign-in form advances to the code step and clears proof on another account", async () => {
  const session = { transport: { getToken: async () => { throw { response: { status: 401, data: { code: "authenticator_required" } } }; } },
    beforeSignIn: async () => true, capture: () => () => true, acceptToken: vi.fn(), refresh: vi.fn() };
  const c = createIdentityLoginState({ session, navigate: vi.fn(), toast: { add: vi.fn() } }), w = render(IdentityLoginForm, c);
  await w.find('#identity-login-name').setValue("alice"); await w.find('#identity-login-password').setValue("password"); await c.submit();
  expect([w.find('#identity-login-code').exists(), w.find('#identity-login-password').exists(), w.find('h1').text()]).toEqual([true, false, "Authenticator code"]);
  c.useAnotherAccount(); expect([c.state.password, c.state.username]).toEqual(["", ""]);
});
it("public-note dialog uses the same form without another password-page heading", () => {
  const controller = { state: { step: "password", username: "", password: "", rememberMe: false }, submit: vi.fn(), setField: vi.fn(), dispose: vi.fn() };
  const w = render(IdentityLoginForm, controller, { dialog: true }); expect(w.findAll('h1')).toHaveLength(0);
  expect(w.findAll('input').map(n => n.attributes('id'))).toEqual(["identity-login-name", "identity-login-password", undefined]);
});
it("password eye preserves input attributes and keyboard-operable visibility", async () => {
  const w = mount(PasswordField, { props: { id: "password", modelValue: "secret" }, attrs: { autocomplete: "new-password", required: true } }); wrappers.push(w);
  expect([w.find('input').attributes('autocomplete'), w.find('input').attributes('type')]).toEqual(["new-password", "password"]);
  await w.find('button').trigger('click'); expect([w.find('input').attributes('type'), w.find('button').attributes('aria-label')]).toEqual(["text", "Hide password"]);
});
it("confirmation forwards cancel without submitting", async () => {
  const write = vi.fn(), c = createAccountSettingsState({ read: async () => ({ login: "alice", credentialRevision: 1, totpEnabled: false }), token: () => "token", write, resolve: async () => "proceed" });
  await c.load(); c.setField('currentPassword', 'old'); c.setField('newPassword', 'new'); c.setField('confirmPassword', 'new'); await c.requestChange();
  const w = render(AccountSettings, c), dialog = w.findAllComponents(IdentityDialog)[1]; await dialog.props('cancel')();
  expect([c.state.confirmation, c.state.newPassword, write.mock.calls]).toEqual([null, "new", []]);
});
for (const reveal of [false, true]) it(`shared input updates its model before forwarding input (${reveal})`, async () => {
  const events = [], w = mount(TextInput, { props: { modelValue: "", reveal, 'onUpdate:modelValue': value => events.push(["model", value]) },
    attrs: { onInput: () => events.push(["input"]) } }); wrappers.push(w);
  await w.find('input').setValue("changed"); expect(events).toEqual([["model", "changed"], ["input"]]);
});
