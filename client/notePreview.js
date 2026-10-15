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
  const state = () => Object.freeze({ html });

  function schedule({ isActive, getBuffer }) {
    if (disposed || !isActive()) return;
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (disposed || !isActive()) return;
      try {
        const rendered = await render(getBuffer, () => !disposed);
        if (disposed) return;
        html = rendered;
      } catch {
        if (disposed) return;
        html = '<p class="render-error">Preview render failed.</p>';
      }
      changed(state());
    }, delay);
  }

  function dispose() {
    disposed = true;
    if (timer != null) clearTimeout(timer);
    timer = null;
  }

  return { state, schedule, dispose };
}
