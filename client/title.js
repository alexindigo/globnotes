// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The one owner of document.title. The router's afterEach sets the base
 * (the brand); an open note publishes its live title through
 * NOTE_TITLE_CHANGED — the note knows its own title (frontmatter → first
 * H1 → basename), and the buffer version tracks typing.
 */

import { watch } from "vue";
import { brandVersion, currentBrandName } from "./brand.js";
import { subscribe, TOPICS } from "./bus/index.js";

let noteTitle = null;
let stopBrand, stopNote;

function compose() {
  document.title = noteTitle
    ? `${noteTitle} - ${currentBrandName()}`
    : currentBrandName();
}

/** Router-level reset on navigation: non-note pages carry the bare base;
 * note pages get their title from the note itself (NOTE_TITLE_CHANGED
 * fires right after open). */
export function setDocTitleBase() {
  noteTitle = null;
  compose();
}

export function initDocTitle() {
  stopBrand?.(); stopNote?.();
  stopNote = subscribe(TOPICS.NOTE_TITLE_CHANGED, ({ title }) => {
    noteTitle = title ?? null;
    compose();
  });
  stopBrand = watch(brandVersion, compose, { flush: "sync" });
  compose();
}
