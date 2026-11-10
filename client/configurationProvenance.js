// SPDX-License-Identifier: LGPL-3.0-only
export const isDeploymentSource = source => source === "environment" || source === "toml";
export const pinExplanation = origin => origin?.readonly && isDeploymentSource(origin.source) ? "Set by the server configuration" : "";
