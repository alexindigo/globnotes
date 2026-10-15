// SPDX-License-Identifier: LGPL-3.0-only
// Same-page anchor handling for rendered markdown surfaces (ServerViewer and
// Note.vue's preview). A browser-native fragment click pushes a history
// entry vue-router never sees, and the next pop reinterprets the stack
// (issue #5: BACK after an anchor "enters edit mode" instead of returning
// to the origin page). Intercept: bare anchors scroll without entering
// history; app fragments stay first-class router entries; cross-page links
// are untouched.
import { parseFragment } from "./fragment.js";

export function classifyAnchorClick(href, currentHref) {
  const url = new URL(href, currentHref);
  const current = new URL(currentHref);
  if (url.pathname !== current.pathname || url.search !== current.search) {
    return "cross-page";
  }
  return parseFragment(url.hash).mode ? "app-fragment" : "same-page-anchor";
}

export async function handleAnchorClick(event) {
  const a = event.target.closest("a[href]");
  if (!a) return;
  const cls = classifyAnchorClick(a.getAttribute("href"), location.href);
  if (cls === "cross-page") return;
  event.preventDefault();
  const url = new URL(a.getAttribute("href"), location.href);
  if (cls === "app-fragment") {
    // Keep router loading lazy: its view imports also consume this module.
    const { default: router } = await import("./router.js");
    router.push(url.pathname + url.search + url.hash);
    return;
  }
  const id = decodeURIComponent(url.hash.slice(1));
  const target = document.getElementById(id) ||
    document.querySelector(`a[name="${CSS.escape(id)}"]`);
  target?.scrollIntoView();
}
