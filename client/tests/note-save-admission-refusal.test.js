import { describe, expect, it } from "vitest";
import { classifyNoteSaveFailure } from "../noteSaveQueue.js";

describe("Save admission certainty", () => {
  it.each([
    [401, "credentials_refused"],
    [403, "operation_not_permitted"],
    [503, "setup_required"],
    [401, "mutation_authority_required"],
  ])("uses the %s refusal code %s, not the wording", (status, code) => {
    expect(classifyNoteSaveFailure({ response: { status, data: { code, detail: "Display text can change" } } }, "sending")).toBe("known-no-write");
  });
  it.each([
    [401, "Invalid authentication credentials"],
    [401, "Invalid authentication credentials."],
    [403, "read-only mode"],
    [403, "This account cannot perform that operation."],
    [503, "setup_required"],
  ])("leaves an uncoded %s unknown even with familiar wording", (status, detail) => {
    expect(classifyNoteSaveFailure({ response: { status, data: { detail } } }, "sending")).toBe("unknown");
    expect(classifyNoteSaveFailure({ response: { status } }, "sending")).toBe("unknown");
  });
});
