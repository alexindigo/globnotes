<template>
  <div ref="editorElement" class="cm-host cm-frame min-h-0 flex-1"></div>
</template>

<script setup>
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { onBeforeUnmount, onMounted, ref } from "vue";

import { subscribe, TOPICS } from "../bus/index.js";
import * as sourceActions from "../keybindings/source-actions.js";

const props = defineProps({
  initialValue: String,
  addImageBlobHook: Function,
  initialLine: Object,
});

const emit = defineEmits(["change", "keydown", "selection"]);

const editorElement = ref();
let view;
let actionUnsubs = [];

// Wired to the globnotes theme vars (RGB triplets) so the editor follows
// theme changes without a remount.
const theme = EditorView.theme({
  "&": {
    backgroundColor: "rgb(var(--theme-background))",
    color: "rgb(var(--theme-text))",
    height: "100%",
    fontSize: "0.95rem",
  },
  ".cm-content": {
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    caretColor: "rgb(var(--theme-text))",
    padding: "12px 16px",
    minHeight: "100%",
    boxSizing: "border-box",
  },
  ".cm-cursor": { borderLeftColor: "rgb(var(--theme-text))" },
  ".cm-gutters": {
    backgroundColor: "rgb(var(--theme-background))",
    color: "rgb(var(--theme-text-very-muted))",
    border: "none",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgb(var(--theme-shadow)) !important",
  },
  // Current-line highlight (edit mode).
  "&.cm-focused .cm-activeLine": {
    backgroundColor: "rgb(var(--theme-shadow) / 0.5)",
  },
  ".cm-activeLine": {
    backgroundColor: "rgb(var(--theme-shadow) / 0.35)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgb(var(--theme-shadow) / 0.5)",
    color: "rgb(var(--theme-text))",
  },
});

const highlight = HighlightStyle.define([
  {
    tag: tags.keyword,
    color: "rgb(var(--theme-code-keyword))",
    fontWeight: "600",
  },
  {
    tag: [tags.controlKeyword, tags.moduleKeyword],
    color: "rgb(var(--theme-code-keyword))",
    fontWeight: "600",
  },
  { tag: tags.string, color: "rgb(var(--theme-code-string))" },
  {
    tag: [tags.special(tags.string), tags.regexp],
    color: "rgb(var(--theme-code-string))",
  },
  { tag: tags.character, color: "rgb(var(--theme-code-string))" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "rgb(var(--theme-code-function))",
  },
  {
    tag: tags.comment,
    color: "rgb(var(--theme-code-comment))",
    fontStyle: "italic",
  },
  {
    tag: [tags.blockComment, tags.lineComment],
    color: "rgb(var(--theme-code-comment))",
    fontStyle: "italic",
  },
  { tag: tags.number, color: "rgb(var(--theme-code-number))" },
  { tag: [tags.integer, tags.float], color: "rgb(var(--theme-code-number))" },
  { tag: tags.bool, color: "rgb(var(--theme-code-number))", fontWeight: "600" },
  { tag: tags.operator, color: "rgb(var(--theme-code-operator))" },
  { tag: tags.tagName, color: "rgb(var(--theme-code-tag))" },
  { tag: tags.attributeName, color: "rgb(var(--theme-code-attr))" },
  { tag: tags.attributeValue, color: "rgb(var(--theme-code-string))" },
  { tag: tags.punctuation, color: "rgb(var(--theme-code-punctuation))" },
  { tag: tags.bracket, color: "rgb(var(--theme-code-punctuation))" },
  { tag: tags.typeName, color: "rgb(var(--theme-code-function))" },
  { tag: tags.className, color: "rgb(var(--theme-code-function))" },
  { tag: tags.variableName, color: "rgb(var(--theme-text))" },
  { tag: tags.propertyName, color: "rgb(var(--theme-code-attr))" },
  { tag: tags.heading, color: "rgb(var(--theme-brand))", fontWeight: "bold" },
  { tag: tags.link, color: "rgb(var(--theme-brand))" },
  {
    tag: tags.url,
    color: "rgb(var(--theme-brand))",
    textDecoration: "underline",
  },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.monospace, color: "rgb(var(--theme-code-string))" },
  {
    tag: tags.quote,
    color: "rgb(var(--theme-text-muted))",
    fontStyle: "italic",
  },
]);

function insertAtCursor(text) {
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: text } });
  view.focus();
}

// --- Selection reporting -------------------------------------------------
// The caret/selection is reported to the parent, which owns the URL
// fragment (via fragment.js — the sole writer). This component never
// reads from or writes to the URL itself.
const selectionExtension = EditorView.updateListener.of((update) => {
  if (!update.selectionSet) return;
  const { doc, selection } = update.state;
  emit("selection", {
    from: doc.lineAt(selection.main.from).number,
    to: doc.lineAt(selection.main.to).number,
  });
});

// Image paste/drop → upload via the host-provided hook, insert the
// returned markdown at the cursor.
function handleFiles(files) {
  const file = [...(files ?? [])].find((f) => f.type.startsWith("image/"));
  if (!file || !props.addImageBlobHook) {
    return false;
  }
  props.addImageBlobHook(file, (url, altText) => {
    insertAtCursor(`![${altText}](${url})`);
  });
  return true;
}

// Editor action channel: handle the formatting/structure actions this
// source editor supports (as markdown-syntax edits) and decline the rest
// (no subscriber → silent no-op). Save/exit/toggle-edit belong to Note.vue.
const sourceActionMap = {
  [TOPICS.EDITOR_TOGGLE_BOLD]: (v) => sourceActions.toggleWrap(v, "**"),
  [TOPICS.EDITOR_TOGGLE_ITALIC]: (v) => sourceActions.toggleWrap(v, "*"),
  [TOPICS.EDITOR_TOGGLE_STRIKETHROUGH]: (v) => sourceActions.toggleWrap(v, "~~"),
  [TOPICS.EDITOR_TOGGLE_INLINE_CODE]: (v) => sourceActions.toggleWrap(v, "`"),
  [TOPICS.EDITOR_INSERT_LINK]: sourceActions.insertLink,
  [TOPICS.EDITOR_HEADING_1]: (v) => sourceActions.setHeading(v, 1),
  [TOPICS.EDITOR_HEADING_2]: (v) => sourceActions.setHeading(v, 2),
  [TOPICS.EDITOR_HEADING_3]: (v) => sourceActions.setHeading(v, 3),
  [TOPICS.EDITOR_HEADING_4]: (v) => sourceActions.setHeading(v, 4),
  [TOPICS.EDITOR_HEADING_5]: (v) => sourceActions.setHeading(v, 5),
  [TOPICS.EDITOR_HEADING_6]: (v) => sourceActions.setHeading(v, 6),
  [TOPICS.EDITOR_PARAGRAPH]: (v) => sourceActions.setHeading(v, 0),
  [TOPICS.EDITOR_BULLET_LIST]: sourceActions.toggleBulletList,
  [TOPICS.EDITOR_ORDERED_LIST]: sourceActions.toggleOrderedList,
  [TOPICS.EDITOR_CHECKLIST_TOGGLE]: sourceActions.toggleChecklist,
  [TOPICS.EDITOR_CODE_BLOCK]: sourceActions.toggleCodeBlock,
  [TOPICS.EDITOR_BLOCKQUOTE]: sourceActions.toggleBlockquote,
  [TOPICS.EDITOR_UNDO]: sourceActions.undoAction,
  [TOPICS.EDITOR_REDO]: sourceActions.redoAction,
  [TOPICS.EDITOR_HARD_BREAK]: sourceActions.insertHardBreak,
  [TOPICS.EDITOR_LIST_INDENT]: sourceActions.indentLines,
  [TOPICS.EDITOR_LIST_OUTDENT]: sourceActions.outdentLines,
};

onMounted(() => {
  view = new EditorView({
    parent: editorElement.value,
    state: EditorState.create({
      doc: props.initialValue ?? "",
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(highlight),
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        selectionExtension,
        theme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            emit("change");
          }
        }),
        EditorView.domEventHandlers({
          keydown: (event) => {
            emit("keydown", event);
          },
          paste: (event) => {
            if (handleFiles(event.clipboardData?.files)) {
              event.preventDefault();
            }
          },
          drop: (event) => {
            if (handleFiles(event.dataTransfer?.files)) {
              event.preventDefault();
            }
          },
        }),
      ],
    }),
  });
  restoreInitialLine();

  // Subscribe to the editor action channel; unsubscribed on teardown below.
  actionUnsubs = Object.entries(sourceActionMap).map(([topic, run]) =>
    subscribe(topic, () => {
      if (view) run(view);
    }));
});

// Select + scroll to a line range (clamped to the doc). Also used by the
// host to re-apply a line aspect arriving through an external URL change.
function selectLine(line) {
  if (!view) return;
  const doc = view.state.doc;
  const from = Math.min(line.from, doc.lines);
  const to = Math.min(line.to, doc.lines);
  view.dispatch({
    selection: EditorSelection.range(doc.line(from).from, doc.line(to).to),
    scrollIntoView: true,
  });
}

// On mount, if a line range was passed in, select + scroll to it. The
// dispatch fires selectionSet, so the parent hears the selection back.
function restoreInitialLine() {
  if (!props.initialLine) return;
  selectLine(props.initialLine);
}

onBeforeUnmount(() => {
  actionUnsubs.forEach((fn) => fn());
  actionUnsubs = [];
  view?.destroy();
});

function getMarkdown() {
  return view.state.doc.toString();
}

function setMarkdown(markdownText) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: markdownText },
  });
}

function isWysiwygMode() {
  return false;
}

defineExpose({ getMarkdown, setMarkdown, isWysiwygMode, selectLine });
</script>

<style>
/* Visible editor frame so the edit surface reads as a bounded box. */
.cm-frame {
  border: 1px solid rgb(var(--theme-border));
  border-radius: 8px;
  overflow: hidden;
  background-color: rgb(var(--theme-background));
}
.cm-host .cm-editor {
  height: 100%;
}
.cm-host .cm-scroller {
  overflow: auto;
}
</style>
