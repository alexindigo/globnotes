<template>
  <Milkdown />
</template>

<script setup>
import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
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

const props = defineProps({
  initialValue: String,
  addImageBlobHook: Function,
});

const emit = defineEmits(["change"]);

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

defineExpose({ getMarkdown, setMarkdown });
</script>
