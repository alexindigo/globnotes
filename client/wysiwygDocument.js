// SPDX-License-Identifier: LGPL-3.0-only
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/core";
import { applyDocumentChanges } from "./editorChanges.js";

/** Owns the markdown/document coordinate boundary. A serializer round-trip is
 * not an edit: expose the loaded bytes while the serialized document is equal
 * to its baseline, including after undo. Acknowledgements establish a new base. */
export function createWysiwygDocument(getEditor, initialValue = "") {
  let raw = initialValue, baseline = null, context = null, pending = null;

  function replace(ctx, text) {
    const view = ctx.get(editorViewCtx), doc = ctx.get(parserCtx)(text);
    if (!doc) throw new Error("Cannot parse acknowledged markdown");
    const { state } = view;
    if (!state.doc.eq(doc)) view.dispatch(applyDocumentChanges(state.tr, state.doc, doc).setMeta("addToHistory", false));
    raw = text;
    baseline = ctx.get(serializerCtx)(view.state.doc);
  }

  function mounted(ctx) {
    context = ctx;
    baseline = ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc);
    if (pending !== null) { replace(ctx, pending); pending = null; }
  }
  function getMarkdown() {
    if (!context) return raw;
    const serialized = context.get(serializerCtx)(context.get(editorViewCtx).state.doc);
    return serialized === baseline ? raw : serialized;
  }
  function getSnapshot() { return context ? { ready: true, content: getMarkdown() } : { ready: false }; }
  function applyAcknowledgement(text) {
    if (!context) { raw = text; pending = text; return true; }
    getEditor().action(ctx => replace(ctx, text));
    return true;
  }
  return { mounted, getMarkdown, getSnapshot, applyAcknowledgement };
}
