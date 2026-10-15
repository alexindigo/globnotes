// SPDX-License-Identifier: LGPL-3.0-only
import { renderBuffer } from "./api.js";
import { renderWithPlugins } from "./noteRendering.js";

// Read the retained buffer after plugin discovery, just like the saved-note
// render path reads its live preferences when constructing the render request.
const renderPreview = getBuffer => renderWithPlugins(disabled => renderBuffer(getBuffer(), disabled));

/** Debounced render of the unsaved buffer. Vue glue consumes snapshots only. */
export function createNotePreview({ render = renderPreview, delay = 400, changed = () => {} } = {}) {
  let timer = null;
  let html = "";
  const state = () => Object.freeze({ html });

  function schedule({ isActive, getBuffer }) {
    if (!isActive()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (!isActive()) return;
      try {
        html = await render(getBuffer);
      } catch {
        html = '<p class="render-error">Preview render failed.</p>';
      }
      changed(state());
    }, delay);
  }

  return { state, schedule };
}
