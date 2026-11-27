// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-only
import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createIdentityAccessSettingsState } from "../accessSettingsState.js";
import AccessSettings from "../components/settings/AccessSettings.vue";
const active = [];
afterEach(async () => { for (const { wrapper, controller } of active.splice(0)) { wrapper.unmount(); await controller.dispose(); } document.body.innerHTML = ""; });
async function render(declared = false, options = {}) {
  const baseline = { vaultId: "vault", revision: 2, signature: "bytes", everybody: "view", grants: { alice: "view", sam: "edit" }, named: [{ id: "alice", login: "alex", level: "view" }, { id: "sam", login: "sam", level: "edit" }], declaredAdmin: declared ? { accountId: "alice", login: "alex", pinned: true } : { accountId: null, pinned: false } };
  const controller = createIdentityAccessSettingsState({ read: async () => baseline, currentAccount: () => ({ id: "alice", login: "alex" }), token: () => "token", canManage: () => true, ...options });
  await controller.load(); const wrapper = mount(AccessSettings, { props: { controller }, attachTo: document.body }); active.push({ wrapper, controller }); return { wrapper, controller };
}
it("server-set account renders a static explained value, never a fake selector or remove control", async () => {
  const { wrapper } = await render(true), row = wrapper.get('[data-account-row="alice"]');
  expect(row.text()).toContain("Admin, Set by server"); expect(row.find('select').exists()).toBe(false); expect(row.find('button').exists()).toBe(false);
  expect(wrapper.text()).toContain("Docker"); expect(wrapper.text()).toContain("change the server's configuration"); expect(wrapper.findAll('[disabled]')).toHaveLength(0);
});
it.each(["existing", "create"])("%s dialog edits a refused login and reviews stale CAS in its own action row", async kind => {
  const admission = vi.fn().mockRejectedValueOnce({ response: { status: 409, data: { code: "access_login_conflict" } } })
    .mockRejectedValueOnce({ response: { status: 409 } });
  const read = vi.fn(async () => ({ vaultId: "vault", revision: read.mock.calls.length === 1 ? 2 : 3,
    signature: read.mock.calls.length === 1 ? "before" : "peer", everybody: "view", grants: { alice: "admin" } }));
  const { wrapper, controller } = await render(false, { read, write: admission, createAccount: admission });
  await controller.openDialog(kind);
  const dialog = wrapper.getComponent({ name: "IdentityDialog" });
  await dialog.get("#access-login").setValue("first");
  if (kind === "create") await dialog.get("#access-temporary-password").setValue("temporary");
  await dialog.get("form").trigger("submit"); await flushPromises();
  expect(dialog.get("#access-login").element.readOnly).toBe(false);
  expect(dialog.findAll("button").map(button => button.text())).not.toContain("Review current access");
  await dialog.get("#access-login").setValue("corrected");
  await dialog.get("form").trigger("submit"); await flushPromises();
  const review = dialog.findAll("button").find(button => button.text() === "Review current access");
  expect(dialog.get("#access-login").element.readOnly).toBe(true);
  await review.trigger("click"); await flushPromises();
  expect([controller.state.login, controller.state.view.signature, dialog.get("#access-login").element.readOnly]).toEqual(["corrected", "peer", false]);
  expect(admission.mock.calls).toHaveLength(2);
  admission.mockImplementation(async request => kind === "create" ? { operationId: request.operationId, accountId: "added", committed: true } : { updateId: request.updateId, committed: true });
  await dialog.get("form").trigger("submit"); await flushPromises();
  expect(admission.mock.calls[2][0]).toMatchObject({ revision: 3, signature: "peer", ...(kind === "create"
    ? { login: "corrected", temporaryPassword: "temporary" } : { additions: [{ login: "corrected", level: "edit" }] }) });
  expect(controller.state.dialog).toBeNull();
});
it("Everybody else is the final fixed row and offers no Admin or remove action", async () => {
  const { wrapper } = await render(), row = wrapper.get('[data-everybody-row]');
  expect(wrapper.findAll('.access-row').at(-1).attributes('data-everybody-row')).toBeDefined(); expect(row.findAll('option').map(option => option.text())).toEqual(["Edit", "View", "No access"]); expect(row.find('button').exists()).toBe(false);
});
it("create-and-add form explains one atomic operation, never partial account-only success", async () => {
  const { wrapper, controller } = await render(); await controller.openDialog("create");
  expect(document.body.textContent).toContain("neither the account nor its vault access"); expect(document.body.textContent).toContain("Temporary password"); expect(document.body.textContent).not.toContain("Resume"); expect(wrapper.find('[disabled]').exists()).toBe(false);
});
it("named and Everybody else selectors forward the selected levels, not field keys", async () => {
  const { wrapper, controller } = await render();
  await wrapper.get('#access-sam').setValue(JSON.stringify('none'));
  await wrapper.get('#access-everybody').setValue(JSON.stringify('edit'));
  expect([controller.state.grants.sam, controller.state.everybody, controller.state.dirty]).toEqual(['none', 'edit', true]);
});
it("revocation makes the already rendered edit controls read-only", async () => {
  const { wrapper, controller } = await render();
  expect(wrapper.findAll("select").map(select => select.attributes("id"))).toEqual(["access-alice", "access-sam", "access-everybody"]);
  controller.revoke(); await nextTick();
  expect(wrapper.findAll("select")).toEqual([]);
  expect(wrapper.findAll("button")).toEqual([]);
  expect([controller.setLevel("sam", "none"), controller.state.grants.sam]).toEqual([false, "edit"]);
});
it("the dialog's level and password fields forward values to the same controller", async () => {
  const { controller } = await render(); await controller.openDialog('create');
  const dialog = active.at(-1).wrapper.getComponent({ name: 'IdentityDialog' });
  await dialog.get('#access-add-level').setValue(JSON.stringify('admin'));
  await dialog.get('#access-temporary-password').setValue('private temporary password');
  expect([controller.state.level, controller.state.temporaryPassword]).toEqual(['admin', 'private temporary password']);
});
