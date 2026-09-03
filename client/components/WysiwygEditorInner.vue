<template>
  <Milkdown />
</template>

<script setup>
import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  prosePluginsCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/core";
import { history } from "@milkdown/plugin-history";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { upload, uploadConfig } from "@milkdown/plugin-upload";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { replaceAll } from "@milkdown/utils";
import { Milkdown, useEditor } from "@milkdown/vue";
import { onBeforeUnmount, onMounted } from "vue";
import { Plugin } from "prosemirror-state";

import { subscribe, TOPICS } from "../bus/index.js";
import { milkdownLayerKeymap } from "../keybindings/editor-keymap.js";
import { callCommand, readActive, readLink, removeLinkCommand } from "./milkdown-commands.js";

const props = defineProps({
  initialValue: String,
  addImageBlobHook: Function,
});

const emit = defineEmits(["change", "activeChange"]);

// Milkdown is markdown-native: the document round-trips through the
// remark parser/serializer, so saving emits source, not lossy HTML→md.
const { get: getEditor } = useEditor((root) =>
  Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, props.initialValue ?? "");
      ctx.get(listenerCtx).markdownUpdated(() => {
        emit("change");
      });
      ctx.update(uploadConfig.key, (prev) => ({
        ...prev,
        uploader: async (files, schema) => {
          const nodes = [];
          for (const file of files) {
            if (!file.type.startsWith("image/") || !props.addImageBlobHook) {
              continue;
            }
            const node = await new Promise((resolve) => {
              props.addImageBlobHook(file, (url, altText) => {
                resolve(
                  schema.nodes.image.createAndFill({ src: url, alt: altText }),
                );
              });
            });
            if (node) nodes.push(node);
          }
          return nodes;
        },
      }));
      // ProseMirror plugin: push the active formatting state to the toolbar
      // whenever the selection moves (live highlighting in WYSIWYG).
      // The layer keymap is PREPENDED so it wins over the preset keymaps
      // (the priority tie breaks by registration order); the host
      // recreates the editor on layer switch.
      ctx.update(prosePluginsCtx, (plugins) => [
        milkdownLayerKeymap(),
        ...plugins,
        new Plugin({
          view: () => ({
            update: (view, prevState) => {
              if (!prevState) return;
              // Emit on every state change (doc edit, selection move, mark
              // toggle). readActive inspects formatting at the cursor so the
              // toolbar reflects bold/italic/etc as the cursor moves.
              try {
                const editor = getEditor();
                if (editor) emit("activeChange", readActive(editor));
              } catch {
                /* never break a ProseMirror update */
              }
            },
          }),
        }),
      ]);
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .use(history)
    .use(upload)
);

function getMarkdown() {
  const editor = getEditor();
  if (!editor) return "";
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    return ctx.get(serializerCtx)(view.state.doc);
  });
}

function setMarkdown(markdownText) {
  getEditor()?.action(replaceAll(markdownText));
}

// Toolbar-facing API: commands + active-state + link insertion.
function command(name) {
  return callCommand(getEditor(), name);
}
function active() {
  return readActive(getEditor());
}
function getLinkAtSelection() {
  return readLink(getEditor());
}
function removeLink() {
  removeLinkCommand(getEditor());
}
// Refocus the editor (toolbar interactions should keep the native selection
// highlight alive; focus moves off the contenteditable when a real click
// hits a button or the link popover input).
function focus() {
  const editor = getEditor();
  editor?.action((ctx) => ctx.get(editorViewCtx).focus());
}
// Insert (or convert the selection into) a link. Wraps selected text, or
// inserts placeholder text when the selection is empty.
function insertLink(href, text) {
  const editor = getEditor();
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state, dispatch } = view;
    const { from, to, empty } = state.selection;
    const schema = state.schema;
    const linkMark = schema.marks.link.create({ href });
    const label = text && !empty ? state.doc.textBetween(from, to) : text;
    if (empty || !text) {
      const node = schema.text(label || "", [linkMark]);
      dispatch(state.tr.insert(from, node));
    } else {
      dispatch(state.tr.addMark(from, to, linkMark));
    }
    view.focus();
  });
}

defineExpose({
  getMarkdown,
  setMarkdown,
  command,
  active,
  insertLink,
  getLinkAtSelection,
  removeLink,
  focus,
});

// Editor action channel: handle the actions this WYSIWYG editor supports
// via the shared command map and decline the rest (no subscriber → silent
// no-op). Save/exit/toggle-edit belong to Note.vue; insert-link belongs to
// the wrapper, which owns the toolbar popover.
const wysiwygCommandMap = {
  [TOPICS.EDITOR_TOGGLE_BOLD]: "bold",
  [TOPICS.EDITOR_TOGGLE_ITALIC]: "italic",
  [TOPICS.EDITOR_TOGGLE_STRIKETHROUGH]: "strike",
  [TOPICS.EDITOR_TOGGLE_INLINE_CODE]: "inlineCode",
  [TOPICS.EDITOR_HEADING_1]: "h1",
  [TOPICS.EDITOR_HEADING_2]: "h2",
  [TOPICS.EDITOR_HEADING_3]: "h3",
  [TOPICS.EDITOR_HEADING_4]: "h4",
  [TOPICS.EDITOR_HEADING_5]: "h5",
  [TOPICS.EDITOR_HEADING_6]: "h6",
  [TOPICS.EDITOR_PARAGRAPH]: "paragraph",
  [TOPICS.EDITOR_BULLET_LIST]: "bulletList",
  [TOPICS.EDITOR_ORDERED_LIST]: "orderedList",
  [TOPICS.EDITOR_CHECKLIST_TOGGLE]: "checklist",
  [TOPICS.EDITOR_CODE_BLOCK]: "codeBlock",
  [TOPICS.EDITOR_BLOCKQUOTE]: "blockquote",
  [TOPICS.EDITOR_UNDO]: "undo",
  [TOPICS.EDITOR_REDO]: "redo",
  [TOPICS.EDITOR_HARD_BREAK]: "hardBreak",
  [TOPICS.EDITOR_LIST_INDENT]: "listIndent",
  [TOPICS.EDITOR_LIST_OUTDENT]: "listOutdent",
};

let actionUnsubs = [];

onMounted(() => {
  actionUnsubs = Object.entries(wysiwygCommandMap).map(([topic, name]) =>
    subscribe(topic, () => callCommand(getEditor(), name)));
});

onBeforeUnmount(() => {
  actionUnsubs.forEach((fn) => fn());
  actionUnsubs = [];
});
</script>
