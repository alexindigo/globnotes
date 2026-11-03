// SPDX-License-Identifier: LGPL-3.0-only
import { getRenderedHtml } from "./api.js";
import { subscribe as subscribeToBus, TOPICS } from "./bus/index.js";
import { renderWithPlugins } from "./noteRendering.js";
import { viewLineNumbers } from "./pluginSettings.js";

const renderSavedNote = (title, isCurrent) => renderWithPlugins(
  disabled => getRenderedHtml(title, disabled, viewLineNumbers.value),
  { isCurrent },
);

/** Owns saved-note render requests; the surface owns DOM presentation only.
 * `rendered` may return a promise for its asynchronous enhancements (diagrams
 * laid out after the HTML lands). `busy` reports true from a render's request
 * until those enhancements settle, so the surface can mark itself aria-busy
 * while its content and layout are still changing. */
export function createServerViewer({
  getContext,
  setHtml,
  rendered,
  failed,
  busy = () => {},
  render = renderSavedNote,
  subscribe = subscribeToBus,
  reportError = (...args) => console.error(...args),
}) {
  let renderVersion = 0;
  // The one busy owner: busy is true exactly while the latest request is
  // unfinished. Every way a request ends (early return, fenced or failed
  // response, settled enhancements) goes through finish(); a request that a
  // newer one superseded never touches busy.
  const finish = version => {
    if (version === renderVersion) busy(false);
  };

  async function renderNote() {
    const version = ++renderVersion;
    const { root, title } = getContext();
    if (!title || !root) {
      finish(version);
      return;
    }
    // A response belongs to one request, title and mounted surface only.
    const isCurrent = () => {
      const current = getContext();
      return version === renderVersion && current.root === root && current.title === title;
    };
    busy(true);
    try {
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
      await rendered(isCurrent);
    } finally {
      finish(version);
    }
  }

  const unsubscribers = [
    subscribe(TOPICS.PLUGIN_TOGGLE, renderNote),
    subscribe(TOPICS.PLUGIN_AUTO_ENABLE, renderNote),
    subscribe(TOPICS.THEME_CHANGE, renderNote),
  ];

  function dispose() {
    finish(++renderVersion);
    for (const unsubscribe of unsubscribers) unsubscribe();
  }

  return { renderNote, dispose };
}
