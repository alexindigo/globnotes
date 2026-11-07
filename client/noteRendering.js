// SPDX-License-Identifier: LGPL-3.0-only
import { getPlugins as loadPlugins } from "./api.js";
import { disabledPluginIds as disabledIds } from "./pluginSettings.js";
import DOMPurify from "dompurify";

/** Both saved-note and buffer renders honor the current plugin switches.
 * The consumer owns its render arguments and any surface-lifetime checks. */
export async function renderWithPlugins(render, {
  getPlugins = loadPlugins,
  disabledPluginIds = disabledIds,
  isCurrent = () => true,
} = {}) {
  const plugins = await getPlugins();
  if (!isCurrent()) return;
  // The server preserves inline HTML. This is the single client boundary for
  // rendered note HTML, shared by saved viewing (innerHTML) and buffer preview
  // (v-html): formatting survives, executable note markup never reaches either.
  return DOMPurify.sanitize(await render(disabledPluginIds(plugins)));
}
