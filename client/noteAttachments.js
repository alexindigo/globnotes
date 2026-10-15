// SPDX-License-Identifier: LGPL-3.0-only
import { uploadFile } from "./api.js";
import { publish, TOPICS } from "./bus/index.js";
import { directoryFromPath } from "./helpers.js";
import { noteAttachmentError } from "./noteErrors.js";
import { attachmentNameError } from "./validators.js";

/** Per-note uploads with injected live paths and presentation effects. */
export function createNoteAttachments({
  getState,
  notify,
  failed,
  upload = uploadFile,
  publish: publishFact = publish,
}) {
  function postAttachment(file) {
    const nameError = attachmentNameError(file.name);
    if (nameError) {
      notify({ title: "Invalid Title", message: nameError, severity: "error" });
      return;
    }
    notify({ message: "Uploading attachment..." });
    const { requestedPath, path } = getState();
    return upload(file, directoryFromPath(requestedPath || path || ""))
      .then(data => {
        publishFact(TOPICS.FILE_UPLOAD, { name: file.name });
        notify({ title: "Success", message: "Attachment uploaded successfully ✓", severity: "success" });
        return data;
      })
      .catch(error => {
        const mapped = noteAttachmentError(error);
        if (mapped) notify({ ...mapped, severity: "error" });
        else failed(error);
      });
  }

  function addImageBlobHook(file, callback) {
    // The callback inserts the canonical uploaded URL/name into the editor.
    // Retain the hook's existing return behavior and validation boundary.
    postAttachment(file).then(data => {
      if (data) callback(data.url, data.filename);
    });
  }

  return { postAttachment, addImageBlobHook };
}
