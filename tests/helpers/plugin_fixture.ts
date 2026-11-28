// SPDX-License-Identifier: LGPL-3.0-only
/** Public entries cannot expose the private partially constructed fixture. */
export {
  fixtureApiOrigin,
  fixturePage,
  pluginFixture,
  preparePluginFixture,
  withPluginFixture,
} from "./plugin_fixture_engine.ts";
