// SPDX-License-Identifier: LGPL-3.0-only
import { renderBuffer } from "./api.js";
import { renderWithPlugins } from "./noteRendering.js";

// Read the retained buffer after plugin discovery, just like the saved-note
// render path reads its live preferences when constructing the render request.
const renderPreview = (getBuffer, isCurrent) => renderWithPlugins(
  disabled => renderBuffer(getBuffer(), disabled),
  { isCurrent },
);

/** Debounced render of the unsaved buffer. Vue glue consumes snapshots only. */
export function createNotePreview({ render = renderPreview, delay = 400, changed = () => {} } = {}) {
  let timer = null;
  let html = "";
  let disposed = false;
  let generation = 0;
  const state = () => Object.freeze({ html });

  function schedule({ isActive, getBuffer }) {
    if (disposed || !isActive()) return;
    if (timer != null) clearTimeout(timer);
    const owner = generation;
    const isCurrent = () => !disposed && owner === generation;
    timer = setTimeout(async () => {
      timer = null;
      if (!isCurrent() || !isActive()) return;
      try {
        const rendered = await render(getBuffer, isCurrent);
        if (!isCurrent()) return;
        html = rendered;
      } catch {
        if (!isCurrent()) return;
        html = '<p class="render-error">Preview render failed.</p>';
      }
      changed(state());
    }, delay);
  }

  function cancel() {
    generation++;
    if (timer != null) clearTimeout(timer);
    timer = null;
  }
  function dispose() {
    disposed = true;
    cancel();
  }

  return { state, schedule, cancel, dispose };
}
