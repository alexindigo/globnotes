// SPDX-License-Identifier: LGPL-3.0-only
import { identityHttp } from "@server/auth/http_policy.ts";
import { state } from "@server/state.ts";
export const operation = "public";
export default identityHttp(() =>
  Response.json(state.identity!.bootstrap.status())
);
