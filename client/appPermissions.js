// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly, ref, watch, watchEffect } from "vue";
import { getPluginPermissions, putPluginPermissions, getPluginPermissionRequests, decidePluginPermissionRequest } from "./api.js";
import { permissionEligibility, permissionSessionKey, permissionWritability } from "./appSessionPolicy.js";
import { modalStack } from "./modalState.js";
import { createPluginPermissionController, permissionScopeKey, permissionAttentionId } from "./pluginPermissionController.js";
import { pluginCatalog, refreshPluginRuntimeCatalog, startPluginRuntime, stopPluginRuntime } from "./pluginRuntime.js";
import { getStoredToken } from "./tokenStorage.js";
import { attention } from './attention.js';

export const permissionRequestKey = request => request ? JSON.stringify([request.pluginId, request.id, request.state, request.kind, request.scopes, request.source.key, request.source.revision]) : null;

/** App-owned permission session, fresh-read opener and retained risk decision. */
export function createAppPermissions({
  config, configReady, routeName, setupRequested, refreshConfig,
  catalog = pluginCatalog, modals = modalStack, token = getStoredToken,
  createPermissions = createPluginPermissionController,
  readView = getPluginPermissions, writeView = putPluginPermissions,
  readPending = getPluginPermissionRequests, decideRequest = decidePluginPermissionRequest,
  changed = refreshPluginRuntimeCatalog, startRuntime = startPluginRuntime, stopRuntime = stopPluginRuntime, attentionRegistry = attention,
}) {
  const permissions = createPermissions({ readView, writeView, readPending, decideRequest, changed });
  const permissionsEligible = computed(() => permissionEligibility(configReady(), config(), routeName(), token()));
  const permissionsWritable = computed(() => permissionWritability(permissionsEligible.value, config()));
  const activePermissionRequest = ref(null), permissionRiskVisible = ref(false), permissionRiskMessage = ref("");
  let requestOpening = 0, permissionRiskResolve = null, openingOwner = null, disposed=false;
  const narrowDrafts=reactive(new Map());
  const EMPTY_NARROW=Object.freeze({text:'',error:''});
  function narrowKey(request=activePermissionRequest.value) {return request ? JSON.stringify([session(),permissionRequestKey(request)]) : null;}
  function narrowDraft(create=false) {
    const request=activePermissionRequest.value; if(!request)return null;
    const key=narrowKey(request);
    if(create&&!narrowDrafts.has(key))narrowDrafts.set(key,{text:'',error:''});
    return narrowDrafts.get(key) ?? EMPTY_NARROW;
  }
  const narrowError=computed(()=>narrowDraft()?.error ?? ''), narrowHostText=computed(()=>narrowDraft()?.text ?? '');
  const activePermissionSnapshot = computed(() => activePermissionRequest.value ? permissions.snapshot(activePermissionRequest.value.pluginId) : null);
  const activePermissionChoices = computed(() => activePermissionRequest.value ? permissions.requestChoices(activePermissionRequest.value) : { scopes: [], allowNetwork: false });
  const requestPresentation = computed(() => {
    const request=activePermissionRequest.value, snapshot=activePermissionSnapshot.value;
    if (!request) return null;
    return { title:`${snapshot?.plugin?.name ?? request.pluginId} asks for ${request.kind === 'imports' ? 'remote code imports' : 'network access'}`,
      summary:snapshot?.view ? `Allow network is ${snapshot.view.allowNetwork ? 'on' : 'off'}. Approvals are separate from the plugin’s requested access and the server’s permissions.` : 'Current permissions are unavailable.',
      broad:request.scopes.some(scope=>scope.type==='all'),
      scopes:request.scopes.map(scope=>({scope,key:permissionScopeKey(scope),label:scope.type==='all' ? 'All hosts and all ports — broad access' : scope.authority,selected:activePermissionChoices.value.scopes.some(item=>permissionScopeKey(item)===permissionScopeKey(scope))})),
      selectedText:activePermissionChoices.value.scopes.map(scope=>scope.type==='all'?'All hosts':scope.authority).join(', '),
      canApprove:permissionsWritable.value && !snapshot?.busy && !!activePermissionChoices.value.scopes.length,
      canNarrow:permissionsWritable.value && !snapshot?.busy && !!narrowHostText.value,
    };
  });
  const session = () => permissionSessionKey(config(), token());
  const publishedAttention=new Map();
  const stopAttention=watchEffect(()=>{
    const current=new Set();
    // The controller publishes only its current session's admitted pending list.
    // Observe that owner, rather than enrolling a second session-admission watch.
    for(const request of permissions.pendingRequests.value) {
      const snapshot=permissions.snapshot(request.pluginId);
      if(request.state!=='pending' || !snapshot.available || !snapshot.hasServer) continue;
      const id=permissionAttentionId(request.pluginId,request.id);
      current.add(id);
      const release=attentionRegistry.publish({id,kind:'plugin-access-request',owner:request.pluginId,
        label:`${snapshot.plugin?.name ?? request.pluginId}: ${request.kind==='imports'?'remote code imports':'network access'}`,
        open:()=>openRequestedPermissionReview(request)});
      publishedAttention.get(id)?.(); publishedAttention.set(id,release);
    }
    for(const [id,release] of publishedAttention) if(!current.has(id)) {release();publishedAttention.delete(id);}
  });
  const stopNarrowRetirement=watchEffect(()=>{
    const current=new Set(permissions.pendingRequests.value.map(narrowKey));
    if(activePermissionRequest.value)current.add(narrowKey());
    for(const key of narrowDrafts.keys())if(!current.has(key))narrowDrafts.delete(key);
  });
  const stopSession = watch([configReady, routeName, session, () => config().setupRequired, permissionsWritable], () => {
    permissions.setSession(session(), { active: permissionsEligible.value, canWrite: permissionsWritable.value });
    requestOpening++; openingOwner=null; activePermissionRequest.value = null; finishPermissionRisk(false);
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
  async function attemptAutomaticOpening() {
    if(disposed)return;
    // Discovery owns automatic attempts only. A current explicit read owns its
    // original modal context until accepted; an unrelated discovery cannot steal it.
    if (openingOwner?.kind === 'manual' && openingOwner.context === modals.value && permissionsEligible.value && !setupRequested()) return;
    // Postponement invalidates the old opening without writing or deferring consent.
    const ticket = ++requestOpening;
    openingOwner=null;
    if (!automaticOpeningEligible()) return;
    const request = permissions.nextRequest(); if (!request) return;
    const key = permissionRequestKey(request), owner = session();
    openingOwner={kind:'automatic',ticket};
    const receipt = await permissions.load(request.pluginId);
    if (ticket === requestOpening && owner === session() && automaticOpeningEligible() &&
        permissionRequestKey(permissions.nextRequest()) === key && requestCurrent(request, receipt)) activePermissionRequest.value = request;
  }
  const stopOpening = watch([() => permissionRequestKey(permissions.nextRequest()), permissionsEligible, setupRequested, routeName, () => modals.value, catalog], attemptAutomaticOpening);
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
      permissionRiskMessage.value = `Approve all hosts and all ports for ${request.kind === 'imports' ? 'remote-code imports' : 'network data'}? This is broad access, separate from Allow network.`;
      permissionRiskVisible.value = true;
      if (!await new Promise(resolve => { permissionRiskResolve = resolve; })) return;
      if (activePermissionRequest.value !== request) return;
    }
    const choices = permissions.requestChoices(request), scopes = choices.scopes.filter(item => permissionScopeKey(item) !== permissionScopeKey(scope));
    if (selected) scopes.push(scope);
    permissions.editRequest(request, { scopes });
  }
  function chooseRequestMaster(value) { const request = activePermissionRequest.value; if (request) permissions.editRequest(request, { allowNetwork: value ?? !activePermissionChoices.value.allowNetwork }); }
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
    permissions.defer(request.id); requestOpening++; openingOwner=null; activePermissionRequest.value = null; finishPermissionRisk(false);
  }
  async function selectNarrowHost(text) {
    const request=activePermissionRequest.value;
    if (!request || !permissionsWritable.value || activePermissionSnapshot.value?.busy) return false;
    const draft=narrowDraft(true); draft.text=text; draft.error='';
    const invalid=()=>{ draft.error='Enter an exact host or host:port, without a URL, path or wildcard. Ports must be 1–65535.'; return false; };
    if (typeof text !== 'string' || !text || /[\s/@\\?#%*\0]/u.test(text)) return invalid();
    const match=text.startsWith('[') ? /^(\[[0-9a-fA-F:.]+\])(?::([0-9]+))?$/.exec(text) : /^([^:]+)(?::([0-9]+))?$/.exec(text);
    if (!match || match[2] !== undefined && (Number(match[2])<1 || Number(match[2])>65535)) return invalid();
    let host;
    try { host=new URL(`http://${match[1]}/`).hostname.toLowerCase(); } catch { return invalid(); }
    if (!host.startsWith('[') && (host.length>253 || host.replace(/\.$/,'').split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) return invalid();
    if (!request.scopes.some(scope=>scope.type==='all')) { draft.error='This request does not offer a broader host scope to narrow.'; return false; }
    await chooseRequestScope({type:'host',authority:match[2] === undefined ? host : `${host}:${Number(match[2])}`},true);
    draft.text='';
    return true;
  }
  function setNarrowHost(text) {if(activePermissionRequest.value && permissionsWritable.value && !activePermissionSnapshot.value?.busy)narrowDraft(true).text=text;}
  async function openRequestedPermissionReview(request) {
    if (!permissionsEligible.value) return;
    const ticket = ++requestOpening, owner = session();
    openingOwner={kind:'manual',ticket,context:modals.value};
    try {
      const receipt = await permissions.load(request.pluginId);
      if (ticket === requestOpening && owner === session() && permissionsEligible.value && !setupRequested() &&
          requestCurrent(request, receipt)) activePermissionRequest.value = request;
    } finally {
      if(openingOwner?.ticket===ticket){openingOwner=null;if(!activePermissionRequest.value)await attemptAutomaticOpening();}
    }
  }
  function dispose() {
    disposed=true;requestOpening++; openingOwner=null; finishPermissionRisk(false); permissions.dispose();
    stopSession(); stopRuntimeSession(); stopCatalog(); stopOpening(); stopActive(); stopAttention(); stopNarrowRetirement();
    for(const release of publishedAttention.values()) release(); publishedAttention.clear(); narrowDrafts.clear();
  }
  return {
    permissions,
    state: readonly(reactive({ permissionsEligible, permissionsWritable, activePermissionRequest, activePermissionSnapshot,
      activePermissionChoices, requestPresentation, narrowError, narrowHostText, permissionRiskVisible, permissionRiskMessage })),
    setPermissionRiskVisible: value => { permissionRiskVisible.value = value; },
    finishPermissionRisk, chooseRequestScope, chooseRequestMaster, approvePermissionRequest, denyPermissionRequest,
    selectNarrowHost, setNarrowHost, deferPermissionRequest, openRequestedPermissionReview, dispose,
  };
}
