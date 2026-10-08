// SPDX-License-Identifier: LGPL-3.0-only

/** Modal ownership/stack: only the topmost dialog consumes Esc/Tab, lower
 * dialogs are inert, and global app/editor shortcuts are suspended while
 * Settings or a confirmation owns focus. Opening an already-open modal is
 * idempotent (focus/select, never duplicate). */

import { computed, shallowRef } from "vue";
import { TOPICS } from "./bus/topics.js";

const stack = shallowRef([]);
export const DIALOG_HOST = Symbol("globnotes dialog host");

function keydown(event) {
  const owner = stack.value.at(-1);
  if (!owner || event.defaultPrevented) return;
  if (owner.onKeydown?.(event) === true) {
    event.preventDefault();
    event.stopImmediatePropagation();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    owner.onEscape?.(event);
  } else if (event.key === "Tab" && owner.onTab?.(event) === true) {
    event.stopImmediatePropagation();
  }
}

export function registerModal(callbacks) {
  // Names describe dialogs; this entry's identity owns its lifetime.
  const entry = { ...callbacks, identity: Symbol(callbacks.name ?? "dialog") };
  if (!stack.value.length) document.addEventListener("keydown", keydown, true);
  stack.value = [...stack.value, entry];
  const topmost = computed(() => stack.value.at(-1) === entry);
  let disposed = false;
  return {
    topmost,
    level: computed(() => stack.value.indexOf(entry)),
    focus() { if (topmost.value) entry.focusInitial?.(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      const wasTop = topmost.value;
      stack.value = stack.value.filter(owner => owner !== entry);
      if (!stack.value.length) document.removeEventListener("keydown", keydown, true);
      if (wasTop) entry.restoreFocus?.();
    },
  };
}

/** True while any modal owns keyboard focus — global shortcuts suspend. */
export const modalDepth = () => stack.value.length;
export const modalStack = stack;

/** One availability decision for browser UI actions, including direct bus
 * consumers. Server Worker workflows have their own independent authority. */
export function isActionAvailable(action) {
  return !stack.value.length || (action === TOPICS.APP_OPEN_SETTINGS && stack.value.length === 1 && stack.value[0].name === "settings");
}
