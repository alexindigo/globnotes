import { describe, expect, it } from "vitest";
import { commandPaletteEntries, filterCommandEntries, commandGroups, commandGroupEntries } from "../commandPalette.js";

const commands = [
  { id: "save", label: "Save note", group: "Note" },
  { id: "plugin:one:run", label: "Inspect", group: "Tools" },
  { id: "close", label: "Close note", group: "Note" },
];
const entries = commandPaletteEntries(commands, id => id === "save" ? "Ctrl+S" : "");

describe("command palette policy", () => {
  it("projects registry commands with current hints without mutating the registry", () => {
    expect(entries).toEqual([
      { topic: "save", label: "Save note", group: "Note", hint: "Ctrl+S" },
      { topic: "plugin:one:run", label: "Inspect", group: "Tools", hint: "" },
      { topic: "close", label: "Close note", group: "Note", hint: "" },
    ]);
    expect(commands[0]).not.toHaveProperty("topic");
    expect(commandPaletteEntries(commands, () => "new")[0].hint).toBe("new");
  });
  it.each(["", "   "])("keeps registry order for an empty query '%s'", query => {
    expect(filterCommandEntries(entries, query)).toEqual(entries);
  });
  it.each([
    ["  SAVE  ", ["save"]], ["NOTE", ["save", "close"]],
    ["tools ins", ["plugin:one:run"]], ["Ctrl+S", []], ["missing", []],
  ])("filters group and label for %s without matching shortcut hints", (query, ids) => {
    expect(filterCommandEntries(entries, query).map(entry => entry.topic)).toEqual(ids);
  });
  it("groups in first-appearance order while retaining each group's registry order", () => {
    expect(commandGroups(entries)).toEqual(["Note", "Tools"]);
    expect(commandGroupEntries(entries, "Note").map(entry => entry.topic)).toEqual(["save", "close"]);
    expect(commandGroupEntries(entries, "missing")).toEqual([]);
    expect(commandGroups([])).toEqual([]);
  });
});
