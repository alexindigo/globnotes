// SPDX-License-Identifier: LGPL-3.0-only

/** Browser plugin facade (`@globnotes/plugin-sdk`). A narrow, managed
 * surface: existing bus facts/actions with ownership + disposal, the
 * command registry, plugin settings reads, and scoped timers. It never
 * exposes mutable global stores, auth objects, component refs, editor DOM
 * or raw server context. A browser module is trusted same-origin code —
 * NOT isolated by the Deno Worker sandbox (documented in docs/plugins). */

import { getPluginSettings } from "./api.js";
import { subscribe } from "./bus/index.js";
import { dispatchAction } from "./keybindings/dispatcher.js";
import { registerPluginCommand } from "./commands.js";

/**
 * @param {object} deps
 * @param {string} deps.pluginId host-bound identity (never caller-chosen)
 * @param {object} deps.snapshot activation-time host snapshot (immutable)
 * @param {(fn: Function) => Function} deps.own registers a disposer with
 *   the owning generation; returns the managed release function
 */
export function createPluginSdk({ pluginId, snapshot, own, assertActive = () => {} }) {
  const frozenSnapshot = Object.freeze(structuredClone(snapshot ?? {}));

  /** Check before effect creation and roll back rejected/reentrant adoption once. */
  function managed(create) {
    assertActive();
    const dispose = create();
    let retained = true, release;
    const rollback = () => {
      if (!retained) return;
      retained = false;
      return dispose();
    };
    try {
      assertActive();
      release = own(rollback);
      assertActive();
      return release;
    } catch (error) {
      try { release?.(); } finally { rollback(); }
      throw error;
    }
  }
  const current = () => { try { assertActive(); return true; } catch { return false; } };

  function timer(fn, ms, interval) {
    let release;
    const run = () => {
      if (!current()) return;
      if (!interval) release();
      Promise.resolve().then(() => { if (current()) return fn(); }).catch((error) => {
        console.error(`plugin '${pluginId}' timer failed`, error);
      });
    };
    release = managed(() => {
      const id = interval ? setInterval(run, ms) : setTimeout(run, ms);
      return () => (interval ? clearInterval(id) : clearTimeout(id));
    });
    return release;
  }

  return Object.freeze({
    pluginId,
    snapshot: frozenSnapshot,
    events: {
      /** Managed bus subscription: failure-isolated, disposed on unload. */
      on(topic, handler) {
        return managed(() => subscribe(topic, (payload) => {
          if (!current()) return;
          try {
            handler(payload);
          } catch (error) {
            console.error(`plugin '${pluginId}' event handler failed`, error);
          }
        }));
      },
    },
    actions: {
      /** Dispatch an app action through the common handler. Admission,
       * not completion — await a correlated fact for outcomes. */
      dispatch(action, payload) {
        assertActive();
        dispatchAction(action, payload);
      },
    },
    commands: {
      register(definition, handler) {
        return managed(() =>
          registerPluginCommand(
            pluginId,
            { ...definition, target: definition.target ?? "browser" },
            typeof handler === "function" ? (...args) => { assertActive(); return handler(...args); } : handler,
          ),
        );
      },
    },
    settings: {
      async read(page) {
        assertActive();
        return await getPluginSettings(pluginId, page);
      },
    },
    register: disposer => managed(() => disposer),
    timers: {
      setTimeout: (fn, ms) => timer(fn, ms, false),
      setInterval: (fn, ms) => timer(fn, ms, true),
    },
  });
}
