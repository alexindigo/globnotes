// SPDX-License-Identifier: LGPL-3.0-only
import { getPlugins as loadPlugins } from "./api.js";
import { disabledPluginIds as disabledIds } from "./pluginSettings.js";

/** Both saved-note and buffer renders honor the current plugin switches.
 * The consumer owns its render arguments and any surface-lifetime checks. */
export async function renderWithPlugins(render, {
  getPlugins = loadPlugins,
  disabledPluginIds = disabledIds,
  isCurrent = () => true,
} = {}) {
  const plugins = await getPlugins();
  if (!isCurrent()) return;
  return render(disabledPluginIds(plugins));
}
