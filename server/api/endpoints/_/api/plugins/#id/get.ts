// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "readVault";
import { proxyActivePluginEndpoint } from "@server/plugins/proxy.ts";
import { PLUGIN_LIMITS } from "@server/plugins/contracts.ts";

export const bodyLimit = PLUGIN_LIMITS.httpBytes;

export default proxyActivePluginEndpoint;
