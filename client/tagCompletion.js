// SPDX-License-Identifier: LGPL-3.0-only
import { ref } from "vue";
import { apiErrorHandler, getTags } from "./api.js";
import { publish, TOPICS } from "./bus/index.js";

export function wordOnCursorPosition(text, cursorPosition) {
  const start = Math.max(text.lastIndexOf(" ", cursorPosition - 1) + 1, 0);
  let end = text.indexOf(" ", cursorPosition);
  if (end === -1) end = text.length;
  return { start, end };
}

export function wordOnCursor(text, cursorPosition) {
  const { start, end } = wordOnCursorPosition(text, cursorPosition);
  return text.substring(start, end);
}

export function searchTermChanged(term) {
  publish(TOPICS.SEARCH_CHANGE, { term });
}

/** One input's lazy tag cache and completion state. DOM/caret reads stay in the view. */
export function createTagCompletion({
  toast,
  loadTags = getTags,
  reportError = apiErrorHandler,
  clearOnNonTag = false,
} = {}) {
  let tags = null;
  const matches = ref([]);
  const index = ref(0);
  const visible = ref(false);

  async function filter(input) {
    if (tags === null) {
      try {
        tags = await loadTags();
      } catch (error) {
        tags = [];
        reportError(error, toast);
      }
      tags = tags.map(tag => `#${tag}`);
    }
    const before = matches.value.length;
    matches.value = tags.filter(tag => tag.startsWith(input) && tag !== input);
    if (before !== matches.value.length && matches.value.length > 0) {
      index.value = 0;
      visible.value = true;
    } else if (matches.value.length === 0) {
      visible.value = false;
    }
  }

  function hide() {
    visible.value = false;
  }

  function update(text, cursorPosition) {
    const word = wordOnCursor(text, cursorPosition);
    if (word.charAt(0) !== "#") {
      hide();
      if (clearOnNonTag) matches.value = [];
    } else {
      // Stored tags are lowercase; preserve case-insensitive input matching.
      return filter(word.toLowerCase());
    }
  }

  function choose(text, cursorPosition, tag) {
    const { start, end } = wordOnCursorPosition(text, cursorPosition);
    const completed = text.substring(0, start) + tag + text.substring(end);
    hide();
    return completed;
  }

  function move(delta) {
    index.value = Math.max(0, Math.min(index.value + delta, matches.value.length - 1));
    return index.value;
  }

  function snapshot() {
    return { matches: matches.value, index: index.value, visible: visible.value };
  }

  return { snapshot, update, choose, move, hide };
}
