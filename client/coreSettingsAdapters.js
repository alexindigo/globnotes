// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive } from "vue";
import { publish, TOPICS } from "./bus/index.js";
import { commandRegistry } from "./commands.js";
import { debugEnabled, toggleDebug } from "./debug.js";
import { saveViewLineNumbers, viewLineNumbers } from "./pluginSettings.js";
import { currentTheme, GLOBNOTES_DARK, GLOBNOTES_LIGHT, setTheme, THEMES } from "./themes.js";
import { CUSTOM_BASE_LAYER_ID, CUSTOM_LAYER_ID, LAYER_ORDER, LAYERS } from "./keybindings/layers.js";
import { isMac, platformKey } from "./keybindings/keys.js";
import { currentLayerId, customOverridesMap, effectiveBindings, isCustomLayer, removeCustomBinding, setCustomBinding, setLayer } from "./keybindings/store.js";

const slots = ["logo", "icon"];
const namedKeys = new Set(["Enter", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const copy = value => JSON.parse(JSON.stringify(value));
async function observe(wire, message = "Branding write outcome is unknown; review current status before an explicit retry.") {
  let timer;
  try { return await Promise.race([wire, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), 5000); })]); }
  finally { clearTimeout(timer); }
}

/** Core effects and retained File drafts. Pages receive only snapshots/callbacks. */
export function createCoreSettingsAdapters({ getBrand, applyBrand, writable, writeBrand, readBrand }) {
  const prefix = document.querySelector('meta[name="globnotes-prefix"]')?.content || "";
  const state = reactive({ loaded: false, committed: {}, name: "", accent: "#38bdf8", accentTouched: false, accentCleared: false,
    picked: { logo: null, icon: null }, urls: { logo: null, icon: null }, remove: { logo: false, icon: false }, versions: { name: 0, accent: 0, logo: 0, icon: 0 },
    pending: false, inFlight: false, reviewing: false, unknown: false, readBack: false, error: "", reload: 0, capturing: null });
  let disposed = false, wire = null, uncertain = null;
  function releaseUrl(slot) { if (state.urls[slot]) URL.revokeObjectURL(state.urls[slot]); state.urls[slot] = null; }
  function loadBrand() {
    if (state.loaded && (brandDirty() || state.pending || state.inFlight || state.reviewing || state.unknown)) return;
    state.committed = copy(getBrand() ?? {}); state.name = state.committed.name ?? ""; state.accent = state.committed.accent ?? "#38bdf8";
    state.accentTouched = false; state.accentCleared = false; state.loaded = true; state.error = "";
    for (const slot of slots) { releaseUrl(slot); state.picked[slot] = null; state.remove[slot] = false; }
  }
  function brandDirty() { return state.loaded && (state.name !== (state.committed.name ?? "") || state.accentTouched || state.accentCleared || slots.some(slot => state.picked[slot] || state.remove[slot])); }
  function customFile(slot) { return state.committed.files?.find(file => file.startsWith(`${slot}.`)); }
  function brandSnapshot() {
    if (!state.loaded) loadBrand();
    return { name: state.name, accent: state.accent, accentCleared: state.accentCleared, dirty: brandDirty(), busy: state.pending || state.inFlight || state.reviewing, reviewing: state.reviewing,
      writable: writable(), unknown: state.unknown, error: state.error, canRetry: state.unknown && !state.inFlight,
      hasBranding: !!(state.committed.name || state.committed.accent || state.committed.files?.length),
      files: Object.fromEntries(slots.map(slot => [slot, { picked: !!state.picked[slot], present: !!customFile(slot), removed: state.remove[slot],
        preview: state.urls[slot] || (customFile(slot) && !state.remove[slot] ? `${prefix}/_/brand/${customFile(slot)}?v=${state.reload}` : null) }])) };
  }
  function editBrand(key, value) {
    if (!writable()) return;
    if (!state.loaded) loadBrand(); state.versions[key]++;
    if (key === "name") state.name = value;
    if (key === "accent") { state.accent = value; state.accentTouched = true; state.accentCleared = false; }
  }
  function clearAccent() { if (!writable()) return; state.versions.accent++; state.accentTouched = false; state.accentCleared = true; }
  function chooseFile(slot, file) { if (!writable() || !file) return; state.versions[slot]++; releaseUrl(slot); state.picked[slot] = file; state.urls[slot] = URL.createObjectURL(file); state.remove[slot] = false; }
  function discardFile(slot) { if (!writable()) return; state.versions[slot]++; releaseUrl(slot); state.picked[slot] = null; }
  function removeFile(slot) { if (!writable()) return; state.versions[slot]++; state.remove[slot] = true; }
  function acknowledge(submitted, fresh) {
    state.committed = copy(fresh); state.reload++; applyBrand(fresh); publish(TOPICS.BRAND_CHANGE, fresh);
    if (state.versions.name === submitted.versions.name) state.name = fresh.name ?? "";
    if (state.versions.accent === submitted.versions.accent) { state.accent = fresh.accent ?? "#38bdf8"; state.accentTouched = false; state.accentCleared = false; }
    for (const slot of slots) if (state.versions[slot] === submitted.versions[slot]) { releaseUrl(slot); state.picked[slot] = null; state.remove[slot] = false; }
    state.unknown = false; state.readBack = false; state.error = ""; uncertain = null;
  }
  async function saveBrand(reset = false) {
    if (!writable() || state.pending || state.inFlight || state.reviewing || (state.unknown && !state.readBack)) return false;
    const submitted = { versions: { ...state.versions }, reset }, form = new FormData();
    if (reset) { form.append("name", ""); form.append("accent", ""); form.append("removeLogo", "true"); form.append("removeIcon", "true"); }
    else {
      if (state.name !== (state.committed.name ?? "")) form.append("name", state.name);
      if (state.accentCleared) form.append("accent", ""); else if (state.accentTouched) form.append("accent", state.accent);
      for (const slot of slots) { if (state.picked[slot]) form.append(slot, state.picked[slot]); if (state.remove[slot]) form.append(slot === "logo" ? "removeLogo" : "removeIcon", "true"); }
    }
    state.pending = true; state.inFlight = true; state.error = ""; state.readBack = false;
    let observed = false;
    wire = Promise.resolve().then(() => writeBrand(form));
    wire.then(fresh => { if (!observed && !disposed && state.unknown) acknowledge(submitted, fresh); }, () => {})
      .finally(() => { state.inFlight = false; }).catch(() => {});
    try { const fresh = await observe(wire); observed = true; if (disposed) return false; acknowledge(submitted, fresh); return true; }
    catch (error) { if (!disposed) { state.error = error.response?.data?.detail ?? error.message; state.unknown = true; uncertain = { submitted, form }; } return false; }
    finally { state.pending = false; }
  }
  async function reviewBrand() {
    if (state.inFlight || state.pending || state.reviewing || disposed) return false;
    state.reviewing = true;
    try {
      const fresh = await observe(Promise.resolve().then(() => readBrand()), "Current branding could not be read within the deadline; your choices are retained.");
      if (disposed) return false;
      const old = state.committed;
      if (state.name === (old.name ?? "")) state.name = fresh.name ?? "";
      const accentRequested = uncertain?.form.get("accent");
      if (!state.accentTouched && !state.accentCleared || accentRequested !== null && accentRequested !== undefined && state.versions.accent === uncertain.submitted.versions.accent && (fresh.accent ?? "") === accentRequested) {
        state.accent = fresh.accent ?? "#38bdf8"; state.accentTouched = false; state.accentCleared = false;
      }
      for (const slot of slots) {
        if (state.remove[slot] && !fresh.files?.some(file => file.startsWith(`${slot}.`))) state.remove[slot] = false;
      }
      if (uncertain?.submitted.reset && !fresh.name && !fresh.accent && !fresh.files?.length) {
        const submitted = uncertain.submitted;
        if (state.versions.name === submitted.versions.name) state.name = "";
        if (state.versions.accent === submitted.versions.accent) { state.accent = "#38bdf8"; state.accentTouched = false; state.accentCleared = false; }
        for (const slot of slots) if (state.versions[slot] === submitted.versions[slot]) { releaseUrl(slot); state.picked[slot] = null; state.remove[slot] = false; }
      }
      // File names cannot acknowledge uploaded bytes. Keep chosen File drafts
      // until a successful response, explicit retry, or explicit discard.
      state.committed = copy(fresh); state.reload++; applyBrand(fresh); publish(TOPICS.BRAND_CHANGE, fresh);
      state.unknown = false; state.readBack = true; state.error = ""; uncertain = null;
      return true;
    } catch (error) { state.error = error.message; return false; }
    finally { state.reviewing = false; }
  }
  async function retryBrand() { if (!await reviewBrand()) return false; return !brandDirty() || saveBrand(); }
  async function settle() { if (state.inFlight) { try { await observe(wire); } catch {} } return !state.inFlight && !state.pending && !state.reviewing && !state.unknown; }
  function discardBrand() { if (state.pending || state.inFlight || state.reviewing || (state.unknown && !state.readBack)) return false; state.unknown = false; state.loaded = false; loadBrand(); return true; }
  function resetMessage() { const parts = []; if (state.committed.name) parts.push(`name "${state.committed.name}"`); if (state.committed.accent) parts.push(`accent ${state.committed.accent}`); if (state.committed.files?.length) parts.push(`${state.committed.files.length} uploaded files (${state.committed.files.join(", ")})`); return `This clears ${parts.join(", ")}. Unsaved branding choices are also replaced only when this reset succeeds. The instance returns to default globnotes branding.`; }

  const layers = LAYER_ORDER.map(id => id === CUSTOM_LAYER_ID ? { id, label: "Custom", description: "Starts as a copy of Legacy; overrides are stored in this browser." } : LAYERS[id]);
  function display(binding) { if (!binding) return "Unassigned"; const key = platformKey(binding); return binding.alias ? `${key} or ${display(binding.alias)}` : key; }
  const bindings = computed(() => {
    const effective = effectiveBindings(), overrides = customOverridesMap(), base = LAYERS[CUSTOM_BASE_LAYER_ID].bindings, groups = new Map();
    const commands = [...commandRegistry.value], present = new Set(commands.map(command => command.id));
    for (const id of Object.keys(overrides)) if (!present.has(id) && id.startsWith("plugin:")) commands.push({ id, label: id, group: "Dormant plugin commands", dormant: true });
    for (const command of commands) { const name = command.group || "Plugins"; if (!groups.has(name)) groups.set(name, []); groups.get(name).push({ action: command.id, label: command.label,
      display: display(effective[command.id] ?? (command.dormant ? overrides[command.id] : null)), dormant: !!command.dormant,
      modified: isCustomLayer() && Object.hasOwn(overrides, command.id) && JSON.stringify(base[command.id]) !== JSON.stringify(overrides[command.id]) }); }
    return [...groups].map(([name, rows]) => ({ name, rows }));
  });
  function startCapture(action) { if (isCustomLayer() && !state.capturing) state.capturing = action; }
  function stopCapture() { state.capturing = null; }
  function captureKey(event) {
    if (!state.capturing) return false;
    event.preventDefault(); if (event.key === "Escape") { stopCapture(); return true; }
    if (event.key.length !== 1 && !namedKeys.has(event.key)) return true;
    const parts = []; if (event.ctrlKey) parts.push("Ctrl"); if (event.metaKey) parts.push("Cmd"); if (event.altKey) parts.push("Alt"); if (event.shiftKey) parts.push("Shift"); parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
    const mac = parts.join("+"), other = isMac() ? mac.replace("Cmd+", "Ctrl+") : mac;
    setCustomBinding(state.capturing, { mac, other }); stopCapture(); return true;
  }
  return { THEMES, currentTheme, setTheme, themeSwatch: theme => theme.mode ? theme.colors?.brand || (theme.mode === "dark" ? GLOBNOTES_DARK : GLOBNOTES_LIGHT).brand : undefined,
    layers, keybindings: () => ({ id: currentLayerId.value, description: (LAYERS[currentLayerId.value] ?? LAYERS[CUSTOM_BASE_LAYER_ID]).description, custom: isCustomLayer(), capturing: state.capturing, groups: bindings.value }),
    setLayer, startCapture, stopCapture, captureKey, resetBinding: removeCustomBinding, viewLineNumbers, saveViewLineNumbers, debugEnabled, toggleDebug,
    loadBrand, brandSnapshot, editBrand, clearAccent, chooseFile, discardFile, removeFile, saveBrand, resetMessage, reviewBrand, retryBrand, discardBrand, settle,
    hasWork: () => brandDirty() || state.pending || state.inFlight || state.reviewing || state.unknown,
    dispose() { disposed = true; stopCapture(); slots.forEach(releaseUrl); } };
}
