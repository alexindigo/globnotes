// SPDX-License-Identifier: LGPL-3.0-only
// Read at the caller's existing lifetime boundary (module, mount or operation).
export function readPathPrefix() {
  return document.querySelector('meta[name="globnotes-prefix"]')?.content || "";
}
