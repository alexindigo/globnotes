// SPDX-License-Identifier: LGPL-3.0-only
import { uploadFile } from "./api.js";
import { publish, TOPICS } from "./bus/index.js";
import { directoryFromPath } from "./helpers.js";
import { noteAttachmentError } from "./noteErrors.js";
import { attachmentNameError } from "./validators.js";
import { createOperationOwner } from "./operationOwner.js";
import { bindContext } from "./sessionContext.js";

/** Per-note uploads with injected live paths and presentation effects. */
export function createNoteAttachments({
  getState,
  notify,
  failed,
  capture = () => bindContext(() => true, () => getState().identity),
  upload = uploadFile,
  publish: publishFact = publish,
}) {
  function postAttachment(file, inserted) {
    const { requestedPath, path, canEdit } = getState();
    if (canEdit === false) return Promise.resolve();
    const nameError = attachmentNameError(file.name);
    if (nameError) {
      notify({ title: "Invalid Title", message: nameError, severity: "error" });
      return;
    }
    const current = capture().bind(() => getState().path, () => getState().canEdit !== false);
    notify({ message: "Uploading attachment..." });
    const owner = createOperationOwner({ owner: Object.freeze({}),
      dispatch: () => upload(file, directoryFromPath(requestedPath || path || "")),
      channels: {
        fact: { deliver: value => publishFact(TOPICS.FILE_UPLOAD, value) },
        notify: { deliver: notify },
        insert: { prepare: data => ({ value: { url: data.url, filename: data.filename } }), deliver: data => inserted?.(data.url, data.filename) },
        failed: {
          prepare: error => ({ value: { error, mapped: noteAttachmentError(error) } }),
          deliver({ error, mapped }) { if (mapped) notify({ ...mapped, severity: "error" }); else failed(error); },
        },
      },
    });
    const operation = owner.operation("retained", current);
    return owner.dispatch(operation, null)
      .then(({ value: data }) => {
        if (!owner.deliver(operation, "fact", { name: file.name })) return;
        if (!owner.deliver(operation, "notify", { title: "Success", message: "Attachment uploaded successfully ✓", severity: "success" })) return;
        if (inserted) owner.deliver(operation, "insert", data);
        if (current()) return data;
      })
      .catch(error => {
        owner.deliver(operation, "failed", error);
      }).finally(async () => { (await owner.dispose()).throwIfFailed(); });
  }

  function addImageBlobHook(file, callback) {
    // The callback inserts the canonical uploaded URL/name into the editor.
    // Retain the hook's existing return behavior and validation boundary.
    const pending = postAttachment(file, callback);
    if (pending === undefined) throw new TypeError("Invalid image attachment.");
  }

  return { postAttachment, addImageBlobHook };
}
