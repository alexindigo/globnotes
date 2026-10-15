// SPDX-License-Identifier: LGPL-3.0-only
import { getNote, getNotes, updateNote } from "./api.js";
import { rewriteRenamedLinks } from "./links.js";

/** Best-effort vault rewrites after a successful rename. links.js stays pure;
 * live ownership is checked on both sides of each asynchronous read. */
export function createNoteRenameLinks({
  ownsPath,
  updated = () => {},
  failed = error => console.error("link update failed", error),
  search = getNotes,
  read = getNote,
  update = updateNote,
}) {
  async function updateRenamedLinks(oldPath, newPath) {
    try {
      const results = await search(oldPath, undefined, undefined, undefined, true);
      const candidates = results
        .map(result => result.path)
        .filter(path => path !== oldPath && path !== newPath);
      let count = 0;
      for (const path of candidates) {
        if (ownsPath(path)) continue;
        const other = await read(path);
        const content = rewriteRenamedLinks(other.content, oldPath, newPath, path);
        if (content !== other.content) {
          if (ownsPath(path)) continue;
          await update(path, path, content);
          count++;
        }
      }
      if (count > 0) updated(count);
    } catch (error) {
      // The rename already succeeded. Preserve the original best-effort boundary:
      // one failed candidate stops this traversal without failing the save.
      failed(error);
    }
  }

  return { updateRenamedLinks };
}
