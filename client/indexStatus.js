// SPDX-License-Identifier: LGPL-3.0-only
import { ref, watch } from "vue";
import { getIndexStatus } from "./api.js";
import { refreshNoteIndex } from "./noteIndex.js";

/** Index progress and its polling lifetime for one mounted banner. */
export function createIndexStatus({
  loadStatus = getIndexStatus, refreshIndex = refreshNoteIndex,
  schedule = setInterval, cancel = clearInterval,
} = {}) {
  const syncing = ref(false);
  const done = ref(0);
  const total = ref(0);
  let timer = null;

  async function poll() {
    const status = await loadStatus();
    syncing.value = status.syncing;
    done.value = status.done;
    total.value = status.total;
    if (status.syncing && !timer) {
      timer = schedule(poll, 3000);
    } else if (!status.syncing && timer) {
      cancel(timer);
      timer = null;
    }
  }

  const stop = watch(syncing, (now, before) => {
    if (before && !now) refreshIndex();
  });

  function dispose() {
    stop();
    if (timer) cancel(timer);
  }

  function snapshot() {
    return { syncing: syncing.value, done: done.value, total: total.value };
  }

  return { snapshot, poll, dispose };
}
