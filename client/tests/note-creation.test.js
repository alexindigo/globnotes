import { describe, expect, it } from "vitest";
import { canCreateNote } from "../noteCreation.js";
import { authTypes } from "../constants.js";

describe("note creation policy", () => {
  it.each([
    [authTypes.none, true], [authTypes.password, true], [authTypes.totp, true],
    [authTypes.readOnly, false], [undefined, true],
  ])("keeps note creation eligibility for %s", (type, allowed) => {
    expect(canCreateNote(type)).toBe(allowed);
  });
});
