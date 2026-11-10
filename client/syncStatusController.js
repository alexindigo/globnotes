// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly, watch } from "vue";
import { getDrivers } from "./api.js";
import { subscribe, TOPICS } from "./bus/index.js";
import { acquireVaultChanges } from "./vaultChanges.js";
import { connectionLifetime } from "./connectionLifetime.js";
import { getStoredToken } from "./tokenStorage.js";
import { permissionEligibility, permissionSessionKey } from "./appSessionPolicy.js";
import { driverStates, driverReason } from "./driverPresentation.js";
import { createConflictReadRetry } from "./conflictReadRetry.js";

export const SYNC_STATUS = Symbol("sync-status");
export const SYNC_ACTIVITY_MIN_MS = 1000;

/** The vault stream owns transport cadence. The server alone decides warnings;
 * its relative deadline requests one fresh status read, not a polling loop.
 * Failed pending reads reuse snapshot backoff; a local timer holds brief activity.
 * Hidden documents release all scheduled work. */
export function createSyncStatus({ read = getDrivers, subscribe:on = subscribe,
  acquireChanges = acquireVaultChanges, lifetime = connectionLifetime,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  token = getStoredToken } = {}) {
  const data = reactive({ instances:[], visible:false, icon:"tabCloud",tone:"idle",label:"Sync",error:"" });
  let active = false, visible = false, disposed = false, identity = null;
  let generation = 0, flight = null, dirty = false, releases = [], timer = null, warningTimer = null, stopContext;
  let shownActivity = null, activityUntil = 0;
  const live = () => active && visible && !disposed;
  const retry = createConflictReadRetry(refresh,{lifetime,setTimer,clearTimer});
  const warningDelays = () => data.instances.filter(row => row.enabled && !row.warning && Number.isFinite(row.warningAfterMs) && row.warningAfterMs > 0).map(row => row.warningAfterMs);
  function derive() {
    clearTimer(timer);timer = null;
    const currentTime = now(), enabled = data.instances.filter(row => row.enabled);
    data.visible = enabled.length > 0;
    const trouble = enabled.some(row => row.warning === true);
    const actual = enabled.some(row => row.activity === "receiving") ? "receiving" : enabled.some(row => row.activity === "sending") ? "sending" : null;
    if (!data.visible) { shownActivity = null;activityUntil = 0; }
    else if (actual) {
      if (actual !== shownActivity) activityUntil = currentTime + SYNC_ACTIVITY_MIN_MS;
      shownActivity = actual;
    } else if (currentTime >= activityUntil) shownActivity = null;
    data.icon = shownActivity === "receiving" ? "tabCloudDownload" : shownActivity === "sending" ? "tabCloudUpload" : trouble ? "tabCloudExclamation" : "tabCloud";
    data.tone = trouble ? "danger" : shownActivity ? "active" : "idle";
    data.label = `Sync${shownActivity === "receiving" ? ": receiving changes" : shownActivity === "sending" ? ": sending changes" : ""}${trouble ? ": needs attention" : ""}`;
    if (live() && !actual && shownActivity) timer = setTimer(derive, Math.max(1,activityUntil - currentTime));
  }
  function retire(clear = true) {
    retry.reset();
    generation++;flight = null;dirty = false;clearTimer(timer);timer = null;
    clearTimer(warningTimer);warningTimer = null;
    releases.splice(0).forEach(release => release());
    shownActivity = null;activityUntil = 0;
    if(clear) { data.instances = [];data.error = "";derive(); }
  }
  async function refresh() {
    if(!live()) return false;
    retry.begin();
    clearTimer(warningTimer);warningTimer = null;
    if(flight) { dirty = true;return flight; }
    const own = generation;
    const work = (async () => {
      await Promise.resolve();
      try {
        const result = await read();
        if(!live() || own !== generation || dirty) return false;
        data.instances = result.instances.map(row => ({ ...row, stateLabel:driverStates[row.status] ?? row.status, reasonLabel:driverReason(row),
          lastSyncLabel:row.lastSync ? new Date(row.lastSync).toLocaleString() : "Not synced yet",
          failingLabel:Number.isFinite(row.failingSince) ? new Date(row.failingSince).toLocaleString() : "",
          retryLabel:Number.isFinite(row.nextRetry) ? `Next retry: ${new Date(now() + row.nextRetry).toLocaleTimeString()}` : "No retry scheduled" }));
        data.error = "";
        retry.reset();
        const deadlines = warningDelays();
        if(deadlines.length) warningTimer = setTimer(() => {
          warningTimer = null;
          if(own === generation) void refresh();
        },Math.min(2_147_483_647,...deadlines));
        derive();return true;
      } catch (error) {
        if(own === generation && !dirty) {
          const status = error?.response?.status;
          if(status === 401 || status === 403) data.instances = [];
          else data.instances = data.instances.map(row => ({...row,activity:null}));
          // A failed deadline read does not settle the server's warning decision.
          // Keep that obligation until a fresh snapshot or lifetime boundary.
          if(warningDelays().length) retry.failed(error);
          data.error = "Could not refresh sync status.";derive();
        }
        return false;
      } finally {
        if(own === generation) { flight = null;if(dirty) { dirty = false;void refresh(); } }
      }
    })();flight = work;return work;
  }
  function start() {
    if(!live() || releases.length) return;
    releases = [on(TOPICS.VAULT_DRIVERS,refresh),on(TOPICS.VAULT_RESET,refresh),acquireChanges()];void refresh();
  }
  const offLifetime = lifetime.subscribe(value => { if(visible === value) return;visible = value;if(value) start();else retire(false); });
  function setContext({active:next,key}) {
    if(active === next && identity === key) return;
    retire();active = next;identity = key;start();
  }
  function bindContext({config,configReady,routeName}) {
    stopContext?.();
    stopContext = watch(() => [!!routeName() && permissionEligibility(configReady(),config(),routeName(),token()),permissionSessionKey(config(),token())],
      ([active,key]) => setContext({active,key}),{immediate:true,flush:"sync"});
  }
  return { state:readonly(reactive(Object.fromEntries(Object.keys(data).map(key => [key,computed(() => data[key])])))),
    setContext,bindContext,refresh,dispose() { stopContext?.();offLifetime();retire();retry.dispose();disposed = true; } };
}
