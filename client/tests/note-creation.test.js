import { describe, expect, it } from "vitest";
import { canCreateNote } from "../noteCreation.js";
import { accountProjection } from "./helpers/account-projection.js";

describe("note creation policy", () => {
  it.each([
    [accountProjection({ guest: true, level: "edit" }), true],
    [accountProjection({ guest: true, level: "view" }), false],
    [accountProjection({ level: "none" }), false],
    [accountProjection({ level: "edit" }), true],
    [undefined, false], ["none", false],
  ])("uses only the projected edit capability: %j", (config, allowed) => {
    expect(canCreateNote(config)).toBe(allowed);
  });
});
