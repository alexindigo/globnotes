// SPDX-License-Identifier: LGPL-3.0-only
import { uploadFile } from "./api.js";
import { publish, TOPICS } from "./bus/index.js";
import { directoryFromPath } from "./helpers.js";
import { noteAttachmentError } from "./noteErrors.js";
import { attachmentNameError } from "./validators.js";
import { createOperationOwner } from "./operationOwner.js";

/** Per-note uploads with injected live paths and presentation effects. */
export function createNoteAttachments({
  getState,
  notify,
  failed,
  upload = uploadFile,
  publish: publishFact = publish,
}) {
  function postAttachment(file, inserted) {
    const { requestedPath, path, identity, canEdit } = getState();
    if (canEdit === false) return Promise.resolve();
    const nameError = attachmentNameError(file.name);
    if (nameError) {
      notify({ title: "Invalid Title", message: nameError, severity: "error" });
      return;
    }
    notify({ message: "Uploading attachment..." });
    let owner;
    const guarded = deliver => ({ prepare(value) {
      const prepared = value && { ...value };
      if (identity !== getState().identity || getState().canEdit === false) owner.revoke();
      return { value: prepared };
    }, deliver });
    owner = createOperationOwner({ owner: Object.freeze({ identity }),
      prepare(value) { if (identity !== getState().identity || getState().canEdit === false) owner.revoke(); return { value }; },
      dispatch: () => upload(file, directoryFromPath(requestedPath || path || "")),
      channels: {
        fact: guarded(value => publishFact(TOPICS.FILE_UPLOAD, value)),
        notify: guarded(value => notify(value)),
        insert: guarded(data => inserted?.(data.url, data.filename)),
        failed: {
          prepare(error) { const mapped = noteAttachmentError(error); if (identity !== getState().identity) owner.revoke(); return { value: { error, mapped } }; },
          deliver({ error, mapped }) { if (mapped) notify({ ...mapped, severity: "error" }); else failed(error); },
        },
      },
    });
    const operation = owner.operation("retained");
    return owner.dispatch(operation, null)
      .then(({ value: data }) => {
        if (!owner.deliver(operation, "fact", { name: file.name })) return;
        if (!owner.deliver(operation, "notify", { title: "Success", message: "Attachment uploaded successfully ✓", severity: "success" })) return;
        if (inserted) owner.deliver(operation, "insert", data);
        if (identity === getState().identity && getState().canEdit !== false) return data;
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
