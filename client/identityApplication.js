// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly, ref } from "vue";
import { createIdentityAppSession } from "./appSession.js";
import { createIdentitySetupFormState } from "./setupFormState.js";
import { createIdentitySettingsControllers, createIdentityAccountPage } from "./identitySettings.js";
import { createIdentityNoteIndex } from "./noteIndex.js";
import { createIdentityPluginRuntime } from "./pluginRuntime.js";
import { createVaultChanges } from "./vaultChanges.js";
import { createOwnershipScope } from "../shared/ownership.js";
import { hasUnsavedWork, resolveParticipants } from "./sessionActions.js";
import { getToastOptions } from "./helpers.js";
import { connectionLifetime } from "./connectionLifetime.js";
import { createIdentityLoginState } from "./loginFlow.js";
import { matchReauthentication } from "./reauthentication.js";
import { canCreateNote } from "./noteCreation.js";

export const IDENTITY_APPLICATION = Symbol("identity application");

/** Injection seam for I14c. Constructing this factory installs no global
 * transport, route or active application. All workflows stay in plain modules. */
export function createIdentityApplication({ config, setConfig, tokens, transport, store,
  navigate, toast, loaded = () => {}, failed = () => {}, outage = () => {}, currentRoute = () => null,
  reauthenticate, resolve = resolveParticipants, applyBrand,
  index: indexAdapters, runtime: runtimeAdapters, changes: changesAdapters,
  setup: setupAdapters, account, access, confirmDeparture, setSettingsVisible = () => {} } = {}) {
  const custody = createOwnershipScope(), signInVisible = ref(false);
  let index, runtime, changes, closing;
  const session = createIdentityAppSession({ config, setConfig, tokens, transport, navigate, failed, outage, currentRoute,
    resolve, applyBrand, retainedWork: hasUnsavedWork, reauthenticate,
    startRuntime: key => { void runtime.start(key); }, stopRuntime: () => runtime?.stop(),
    setChangesSession: key => changes?.setSession(key), setBrowseSession: key => index?.setSession(key),
    refreshNotes: () => { void index.refresh(); }, recover: task => changes.revalidate(task) });
  custody.defer(async () => { (await session.dispose()).throwIfFailed(); });
  const hasLiveConfig = computed(() => session.key() != null);
  const io = session.transport;
  index = createIdentityNoteIndex({ ...indexAdapters, store, sessionKey: session.key,
    canRead: () => session.key() != null && config().capabilities?.canRead === true, read: () => io.read("note-index") });
  custody.defer(async () => { (await index.dispose()).throwIfFailed(); });
  runtime = createIdentityPluginRuntime({ lifetime: connectionLifetime, ...runtimeAdapters, sessionKey: session.key,
    readCatalog: () => io.read("plugin-host"), openEvents: options => io.openPluginHostEvents(options) });
  custody.defer(runtime.stop);
  changes = createVaultChanges({ lifetime: connectionLifetime, ...changesAdapters, sessionKey: session.key,
    open: options => io.openVaultChanges(options) });
  custody.defer(async () => { const report = await changes.dispose(); if (report.errors.length) throw new AggregateError(report.errors, "Vault changes cleanup failed"); });
  const setup = createIdentitySetupFormState({ ...setupAdapters,
    beforeCommit: async () => await resolve("finishing setup") === "proceed",
    completed: async result => {
      const accepted = await session.signIn(result.access_token, { login: setup.state.username });
      if (accepted?.current()) await navigate({ name: "home" });
    },
    signIn: async message => { toast.add(getToastOptions(message, "Sign in", "info")); await navigate({ name: "login" }); },
  });
  custody.defer(async () => { (await setup.dispose()).throwIfFailed(); });
  return Object.freeze({ session, setup, index, runtime, changes,
    state: readonly(reactive({ configReady: computed(() => session.state.ready), hasLiveConfig, signInVisible,
      noteShell: computed(() => hasLiveConfig.value && config().capabilities?.canRead === true && !["account", "login", "setup"].includes(currentRoute()?.name)) })),
    createLogin({ redirect, authenticated, isCurrent }) {
      const recovery = matchReauthentication(authenticated, isCurrent);
      return createIdentityLoginState({ session, navigate, redirect, authenticated, isCurrent, recovery, toast });
    },
    createSettings() {
      custody.assertCurrent();
      const controllers = createIdentitySettingsControllers({ session, config, navigate, toast, account, access, confirmDeparture, resolve });
      custody.defer(async () => { (await controllers.dispose()).throwIfFailed(); }); return controllers;
    },
    createAccountPage() {
      custody.assertCurrent();
      const controller = createIdentityAccountPage({ session, navigate, toast, account });
      custody.defer(async () => { (await controller.dispose()).throwIfFailed(); }); return controller;
    },
    // Reader/editor discovery never reads the old Admin manifest endpoint.
    async readerPlugins() {
      if (session.key() == null || !config().capabilities?.canRead) return [];
      const current = session.capture();
      try {
        const catalog = await io.read("plugin-host");
        return current() ? catalog.plugins.filter(plugin => plugin.enabled).map(({ id, name, version, client }) => ({ id, name, version, client })) : [];
      } catch (error) { if (current()) throw error; return []; }
    },
    openSignIn() { signInVisible.value = true; }, closeSignIn() { signInVisible.value = false; },
    routeChanged(name) { if (["login", "account"].includes(name)) { signInVisible.value = false; setSettingsVisible(false); } },
    async load() { const accepted = await session.load(); if (accepted && session.state.ready) loaded(); return accepted; },
    newNote() { if (session.state.valid && canCreateNote(config())) return navigate({ name: "new" }); },
    refreshConfig: session.refreshLive, logoutFromSettings: session.logout,
    dispose() {
      if (closing) return closing;
      closing = Promise.resolve().then(() => custody.releaseAll());
      custody.retire(); void session.dispose(); return closing;
    },
  });
}
