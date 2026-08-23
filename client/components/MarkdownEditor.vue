<template>
  <div ref="editorElement" class="cm-host min-h-0 flex-1"></div>
</template>

<script setup>
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
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
});

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "rgb(var(--theme-code-keyword))" },
  { tag: tags.string, color: "rgb(var(--theme-code-string))" },
  { tag: tags.function(tags.variableName), color: "rgb(var(--theme-code-function))" },
  { tag: tags.comment, color: "rgb(var(--theme-code-comment))" },
  { tag: tags.number, color: "rgb(var(--theme-code-number))" },
  { tag: tags.operator, color: "rgb(var(--theme-code-operator))" },
  { tag: tags.tagName, color: "rgb(var(--theme-code-tag))" },
  { tag: tags.attributeName, color: "rgb(var(--theme-code-attr))" },
  { tag: tags.punctuation, color: "rgb(var(--theme-code-punctuation))" },
  { tag: tags.heading, color: "rgb(var(--theme-brand))", fontWeight: "bold" },
  { tag: tags.link, color: "rgb(var(--theme-brand))" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.monospace, color: "rgb(var(--theme-code-string))" },
]);

function insertAtCursor(text) {
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: text } });
  view.focus();
}

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
});

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
.cm-host .cm-editor {
  height: 100%;
}
.cm-host .cm-scroller {
  overflow: auto;
}
</style>
