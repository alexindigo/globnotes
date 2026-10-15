// SPDX-License-Identifier: LGPL-3.0-only
import { getRenderedHtml } from "./api.js";
import { subscribe as subscribeToBus, TOPICS } from "./bus/index.js";
import { renderWithPlugins } from "./noteRendering.js";
import { viewLineNumbers } from "./pluginSettings.js";

const renderSavedNote = (title, isCurrent) => renderWithPlugins(
  disabled => getRenderedHtml(title, disabled, viewLineNumbers.value),
  { isCurrent },
);

/** Owns saved-note render requests; the surface owns DOM presentation only. */
export function createServerViewer({
  getContext,
  setHtml,
  rendered,
  failed,
  render = renderSavedNote,
  subscribe = subscribeToBus,
  reportError = (...args) => console.error(...args),
}) {
  let renderVersion = 0;

  async function renderNote() {
    const version = ++renderVersion;
    const { root, title } = getContext();
    if (!title || !root) return;
    // A response belongs to one request, title and mounted surface only.
    const isCurrent = () => {
      const current = getContext();
      return version === renderVersion && current.root === root && current.title === title;
    };
    let html;
    try {
      html = await render(title, isCurrent);
      if (!isCurrent()) return;
      setHtml(html);
    } catch (error) {
      if (!isCurrent()) return;
      reportError("Note render failed", error);
      failed(error);
      return;
    }
    rendered(isCurrent);
  }

  const unsubscribers = [
    subscribe(TOPICS.PLUGIN_TOGGLE, renderNote),
    subscribe(TOPICS.PLUGIN_AUTO_ENABLE, renderNote),
    subscribe(TOPICS.THEME_CHANGE, renderNote),
  ];

  function dispose() {
    renderVersion++;
    for (const unsubscribe of unsubscribers) unsubscribe();
  }

  return { renderNote, dispose };
}
