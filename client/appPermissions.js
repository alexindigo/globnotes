// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly, ref, watch } from "vue";
import { getPluginPermissions, putPluginPermissions, getPluginPermissionRequests, decidePluginPermissionRequest } from "./api.js";
import { permissionEligibility, permissionSessionKey, permissionWritability } from "./appSessionPolicy.js";
import { modalStack } from "./modalState.js";
import { createPluginPermissionController, permissionScopeKey } from "./pluginPermissionController.js";
import { pluginCatalog, refreshPluginRuntimeCatalog, startPluginRuntime, stopPluginRuntime } from "./pluginRuntime.js";
import { getStoredToken } from "./tokenStorage.js";

export const permissionRequestKey = request => request ? JSON.stringify([request.pluginId, request.id, request.state, request.kind, request.scopes, request.source.key, request.source.revision]) : null;

/** App-owned permission session, fresh-read opener and retained risk decision. */
export function createAppPermissions({
  config, configReady, routeName, setupRequested, refreshConfig,
  catalog = pluginCatalog, modals = modalStack, token = getStoredToken,
  createPermissions = createPluginPermissionController,
  readView = getPluginPermissions, writeView = putPluginPermissions,
  readPending = getPluginPermissionRequests, decideRequest = decidePluginPermissionRequest,
  changed = refreshPluginRuntimeCatalog, startRuntime = startPluginRuntime, stopRuntime = stopPluginRuntime,
}) {
  const permissions = createPermissions({ readView, writeView, readPending, decideRequest, changed });
  const permissionsEligible = computed(() => permissionEligibility(configReady(), config(), routeName(), token()));
  const permissionsWritable = computed(() => permissionWritability(permissionsEligible.value, config()));
  const activePermissionRequest = ref(null), permissionRiskVisible = ref(false), permissionRiskMessage = ref("");
  let requestOpening = 0, permissionRiskResolve = null;
  const activePermissionSnapshot = computed(() => activePermissionRequest.value ? permissions.snapshot(activePermissionRequest.value.pluginId) : null);
  const activePermissionChoices = computed(() => activePermissionRequest.value ? permissions.requestChoices(activePermissionRequest.value) : { scopes: [], allowNetwork: false });
  const session = () => permissionSessionKey(config(), token());
  const stopSession = watch([configReady, routeName, () => config().authType, () => config().setupRequired, permissionsWritable], () => {
    permissions.setSession(session(), { active: permissionsEligible.value, canWrite: permissionsWritable.value });
    requestOpening++; activePermissionRequest.value = null; finishPermissionRisk(false);
    if (permissionsEligible.value) { permissions.reconcile(catalog.value); permissions.refreshPending(); }
  }, { immediate: true });
  const stopRuntimeSession = watch([permissionsEligible, session], ([active, key]) => { if (active) startRuntime(key); else stopRuntime(); });
  const stopCatalog = watch(catalog, value => {
    permissions.reconcile(value); if (permissionsEligible.value) permissions.refreshPending();
    if (configReady()) refreshConfig();
  });
  function automaticOpeningEligible() {
    return permissionsEligible.value && !setupRequested() && !activePermissionRequest.value && !modals.value.some(owner => owner.name !== "settings");
  }
  function requestCurrent(request, receipt) {
    const snapshot = permissions.snapshot(request.pluginId);
    return receipt.status === "accepted" && receipt.current() && snapshot.available && snapshot.hasServer &&
      snapshot.view?.pendingRequests.some(item => permissionRequestKey(item) === permissionRequestKey(request));
  }
  const stopOpening = watch([() => permissionRequestKey(permissions.nextRequest()), permissionsEligible, setupRequested, routeName, () => modals.value, catalog], async () => {
    // Postponement invalidates the old opening without writing or deferring consent.
    const ticket = ++requestOpening;
    if (!automaticOpeningEligible()) return;
    const request = permissions.nextRequest(); if (!request) return;
    const key = permissionRequestKey(request), owner = session();
    const receipt = await permissions.load(request.pluginId);
    if (ticket === requestOpening && owner === session() && automaticOpeningEligible() &&
        permissionRequestKey(permissions.nextRequest()) === key && requestCurrent(request, receipt)) activePermissionRequest.value = request;
  });
  const stopActive = watch(() => activePermissionRequest.value && [activePermissionSnapshot.value.view, activePermissionSnapshot.value.available, permissions.pendingRequests.value], () => {
    const request = activePermissionRequest.value; if (!request) return;
    const view = permissions.snapshot(request.pluginId).view;
    if (!permissionsEligible.value || !activePermissionSnapshot.value.available || !view?.pendingRequests.some(item => permissionRequestKey(item) === permissionRequestKey(request))) {
      requestOpening++; activePermissionRequest.value = null; finishPermissionRisk(false);
    }
  });
  function finishPermissionRisk(value) { permissionRiskVisible.value = false; permissionRiskResolve?.(value); permissionRiskResolve = null; }
  async function chooseRequestScope(scope, selected) {
    const request = activePermissionRequest.value; if (!request || activePermissionSnapshot.value.busy) return;
    if (selected && scope.type === "all") {
      permissionRiskMessage.value = `Select all hosts and all ports for ${request.kind === 'imports' ? 'remote-code imports' : 'network data'}? This is broad access, separate from the master.`;
      permissionRiskVisible.value = true;
      if (!await new Promise(resolve => { permissionRiskResolve = resolve; })) return;
      if (activePermissionRequest.value !== request) return;
    }
    const choices = permissions.requestChoices(request), scopes = choices.scopes.filter(item => permissionScopeKey(item) !== permissionScopeKey(scope));
    if (selected) scopes.push(scope);
    permissions.editRequest(request, { scopes });
  }
  function chooseRequestMaster(value) { const request = activePermissionRequest.value; if (request) permissions.editRequest(request, { allowNetwork: value }); }
  async function approvePermissionRequest() {
    const request = activePermissionRequest.value; if (!request) return;
    const choices = permissions.requestChoices(request);
    if (await permissions.decide(request.pluginId, request, "approve", choices.allowNetwork, choices.scopes) && activePermissionRequest.value === request) activePermissionRequest.value = null;
  }
  async function denyPermissionRequest() {
    const request = activePermissionRequest.value; if (!request) return;
    if (await permissions.decide(request.pluginId, request, "deny") && activePermissionRequest.value === request) activePermissionRequest.value = null;
  }
  function deferPermissionRequest() {
    const request = activePermissionRequest.value; if (!request || activePermissionSnapshot.value?.busy) return;
    permissions.defer(request.id); requestOpening++; activePermissionRequest.value = null; finishPermissionRisk(false);
  }
  async function openRequestedPermissionReview(request) {
    if (!permissionsEligible.value) return;
    const ticket = ++requestOpening, owner = session();
    const receipt = await permissions.load(request.pluginId);
    if (ticket === requestOpening && owner === session() && permissionsEligible.value && !setupRequested() &&
        requestCurrent(request, receipt)) activePermissionRequest.value = request;
  }
  function dispose() {
    requestOpening++; finishPermissionRisk(false); permissions.dispose();
    stopSession(); stopRuntimeSession(); stopCatalog(); stopOpening(); stopActive();
  }
  return {
    permissions,
    state: readonly(reactive({ permissionsEligible, permissionsWritable, activePermissionRequest, activePermissionSnapshot,
      activePermissionChoices, permissionRiskVisible, permissionRiskMessage })),
    setPermissionRiskVisible: value => { permissionRiskVisible.value = value; },
    finishPermissionRisk, chooseRequestScope, chooseRequestMaster, approvePermissionRequest, denyPermissionRequest,
    deferPermissionRequest, openRequestedPermissionReview, dispose,
  };
}
