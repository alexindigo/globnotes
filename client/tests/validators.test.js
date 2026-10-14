import { describe, expect, it } from "vitest";
import { attachmentNameError, notePathError } from "../validators.js";

describe("attachmentNameError", () => {
  it.each([...'<>:"\\|?*'])(
    "rejects reserved character %s in both attachments and note paths",
    (character) => {
      const name = `a${character}b.png`;
      expect(attachmentNameError(name)).toBe(
        'Due to filename restrictions, the following characters are not allowed: <>:"\\|?*',
      );
      expect(notePathError(`folder/${name}`)).toBe(
        'Path cannot include any of the following characters: <>:"\\|?*',
      );
      // Validation must stay repeatable; a shared regex cannot retain a cursor.
      expect(attachmentNameError(name)).not.toBeNull();
      expect(notePathError(name)).not.toBeNull();
    },
  );

  it.each(["image.png", "two words.png", "笔记.png", "100%.png", "a#b.png", "a'b.png"])(
    "accepts ordinary attachment and note filename %s",
    (name) => {
      expect(attachmentNameError(name)).toBeNull();
      expect(notePathError(`folder/${name}`)).toBeNull();
    },
  );

  it.each(["", ".hidden", "..", "a/b.png", "x".repeat(256)])(
    "preserves attachment-only validation without adding note-path rules for %j",
    (name) => {
      expect(attachmentNameError(name)).toBeNull();
    },
  );
});
