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

const props = defineProps({
  initialValue: String,
  addImageBlobHook: Function,
});

const emit = defineEmits(["change", "keydown"]);

const editorElement = ref();
let view;

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

// --- Line-link URL fragment (#L123-L345) -------------------------------
// Keep the URL fragment in sync with the current selection so a link to a
// line range is always shareable. Uses replaceState to avoid spamming
// browser history on every caret move.
function lineFragmentOf(doc, selection) {
  const from = doc.lineAt(selection.from).number;
  const to = doc.lineAt(selection.to).number;
  return from === to ? `#L${from}` : `#L${from}-L${to}`;
}

function parseLineFragment(hash) {
  const m = /^#L(\d+)(?:-L?(\d+))?$/.exec(hash || "");
  if (!m) return null;
  const from = parseInt(m[1], 10);
  const to = m[2] !== undefined ? parseInt(m[2], 10) : from;
  return { from: Math.max(1, Math.min(from, to)), to: Math.max(from, to) };
}

const lineLinkExtension = EditorView.updateListener.of((update) => {
  if (!update.selectionSet) return;
  const { state } = update;
  const fragment = lineFragmentOf(state.doc, state.selection.main);
  const next = `${window.location.pathname}${window.location.search}${fragment}`;
  if (window.location.hash !== fragment) {
    window.history.replaceState(window.history.state, "", next);
  }
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
        lineLinkExtension,
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
  restoreLineFragment();
});

// On mount, if the URL has a #Ln[-Lm] fragment, select + scroll to it.
function restoreLineFragment() {
  const frag = parseLineFragment(window.location.hash);
  if (!frag) return;
  const doc = view.state.doc;
  const from = Math.min(frag.from, doc.lines);
  const to = Math.min(frag.to, doc.lines);
  view.dispatch({
    selection: EditorSelection.range(doc.line(from).from, doc.line(to).to),
    scrollIntoView: true,
  });
}

onBeforeUnmount(() => {
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

defineExpose({ getMarkdown, setMarkdown, isWysiwygMode });
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
