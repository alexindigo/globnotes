// SPDX-License-Identifier: LGPL-3.0-only

import type { RequestCtx } from "@server/router.ts";
import { state } from "@server/state.ts";

/** Concatenated stylesheets shipped by enabled plugins — Obsidian-style
 * `styles.css` files, served globally. Plugins namespace their own selectors.
 * Read fresh from disk each request so an edit shows without a restart. */
export default function (_ctx: RequestCtx): Response {
  const styles = state.plugins?.getStyleContents() ?? [];
  const body = styles.map(({ id, css }) => `/* ${id} */\n${css}`).join("\n\n");
  return new Response(body, {
    headers: { "content-type": "text/css; charset=utf-8" },
  });
}
