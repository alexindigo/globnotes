// Debug mode — a menu toggle that surfaces every bus event as a toast, so
// event wiring is instantly visible while developing.
import { ref, watch } from "vue";

import { publish, subscribe, TOPICS } from "./bus/index.js";

const STORAGE_KEY = "debug";

export const debugEnabled = ref(localStorage.getItem(STORAGE_KEY) === "true");

export function toggleDebug() {
  debugEnabled.value = !debugEnabled.value;
  localStorage.setItem(STORAGE_KEY, String(debugEnabled.value));
  publish(TOPICS.DEBUG_CHANGE, { enabled: debugEnabled.value });
}

const unsubscribers = [];

// Hook the whole bus into the toast service. Called once from App.vue with
// the PrimeVue toast instance; a watcher on `debugEnabled` keeps the
// subscriptions in sync — subscribed only while debug is on.
export function initDebugNotifications(toast) {
  watch(
    debugEnabled,
    (on) => {
      if (on) {
        for (const topic of Object.values(TOPICS)) {
          unsubscribers.push(
            subscribe(topic, (payload) => {
              toast.add({
                summary: topic,
                detail: JSON.stringify(payload),
                severity: "info",
                closable: false,
                life: 2500,
              });
            }),
          );
        }
      } else {
        unsubscribers.forEach((unsub) => unsub());
        unsubscribers.length = 0;
      }
    },
    { immediate: true, flush: "sync" },
  );
}
