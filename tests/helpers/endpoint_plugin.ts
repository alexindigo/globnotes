// SPDX-License-Identifier: LGPL-3.0-only

/** The sandbox endpoint plugin the plugin API tests install: an on-save
 * observer, an `echo` command and a few routes. */

import { fixturePage } from "./plugin_fixture.ts";

export const ENDPOINT_PLUGIN = {
  manifest: {
    runtime: { server: "service.js" },
    hooks: ["on-save"],
    settings: [fixturePage],
  },
  files: {
    "service.js": `export function activate(ctx) {
      ctx.hooks.on('on-save', () => {});
      ctx.commands.register({ id: 'echo', label: 'Echo', target: 'server' }, (payload) => ({ echoed: payload }));
    }`,
    "endpoints/get.js":
      `export default (req) => ({ route: 'root', query: req.query, headers: req.headers });`,
    "endpoints/post.js":
      `export default async (req) => ({ route: 'root-post', bytes: req.body.length });`,
    "endpoints/item/#name/get.js":
      `export default (req) => ({ route: 'item', name: req.params.name, query: req.query });`,
    "endpoints/echo/post.js": `export default (req) => ({
      status: 201,
      headers: [['x-plugin', 'yes'], ['set-cookie', 'nope=1']],
      body: new TextDecoder().decode(req.body),
    });`,
    "endpoints/tree/#...route/get.js":
      `export default (req) => ({ route: 'tree', rest: req.params.route });`,
  },
};
