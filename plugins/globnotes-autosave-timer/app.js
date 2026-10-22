// SPDX-License-Identifier: LGPL-3.0-only

function seconds(value, fallback, min, max) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

/** Text-free scheduler. Managed timers return cancellation functions, not IDs. */
export function createAutosaveTimer(ctx) {
  let settings = { enabled: false };
  let latest = null, editing = false, disposed = false;
  let readTicket = 0, timerTicket = 0, cancelTimer = null;

  function clearTimer() {
    timerTicket++;
    cancelTimer?.();
    cancelTimer = null;
  }
  const eligible = () => !disposed && editing && settings.enabled && latest?.unsaved && latest?.canSave;

  function schedulePause() {
    clearTimer();
    if (!eligible()) return;
    const ticket = timerTicket;
    cancelTimer = ctx.timers.setTimeout(() => {
      if (ticket !== timerTicket) return;
      cancelTimer = null;
      if (eligible() && ctx.actions.dispatch("editor:save") === false) schedulePause();
    }, settings.pauseSeconds * 1000);
  }

  async function readSettings() {
    const ticket = ++readTicket;
    settings = { enabled: false };
    clearTimer();
    let values;
    try { values = (await ctx.settings.read("autosave"))?.values; }
    catch { /* A failed read stays off until the next edit session. */ }
    if (disposed || ticket !== readTicket) return;
    settings = {
      enabled: values?.enabled === true,
      mode: values?.mode === "interval" ? "interval" : "pause",
      pauseSeconds: seconds(values?.pauseSeconds, 2, 1, 60),
      intervalSeconds: seconds(values?.intervalSeconds, 30, 5, 3600),
    };
    if (!editing || !settings.enabled) return;
    if (settings.mode === "pause") schedulePause();
    else {
      const timer = timerTicket;
      cancelTimer = ctx.timers.setInterval(() => {
        if (timer === timerTicket && eligible()) ctx.actions.dispatch("editor:save");
      }, settings.intervalSeconds * 1000);
    }
  }

  const releases = [
    ctx.events.on("note:edit-state", state => {
      const wasEditing = editing;
      editing = state.editing === true;
      latest = { unsaved: state.unsaved === true, canSave: state.canSave === true };
      if (!editing) {
        latest = null;
        readTicket++;
        clearTimer();
      } else if (!wasEditing) {
        // Includes a retained session delivered after asynchronous activation.
        void readSettings();
      } else if (settings.mode === "pause") schedulePause();
    }),
  ];

  function dispose() {
    if (disposed) return;
    disposed = true;
    readTicket++;
    clearTimer();
    for (const release of releases) release();
  }
  ctx.register(dispose);
  return { ready: readSettings(), dispose };
}

export async function activate(ctx) {
  await createAutosaveTimer(ctx).ready;
}
