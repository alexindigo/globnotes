import { describe, expect, it } from "vitest";
import { operationError } from "../api.js";

describe("operationError", () => {
  it("returns null for plain status errors without a code", () => {
    expect(operationError({ response: { status: 409, data: { detail: "duplicate" } } }))
      .toBeNull();
    expect(operationError({ response: { status: 500 } })).toBeNull();
    expect(operationError(new Error("network"))).toBeNull();
    expect(operationError(undefined)).toBeNull();
  });

  it("maps plugin_cancelled with plugin identity and reason", () => {
    const result = operationError({
      response: {
        status: 409,
        data: {
          code: "plugin_cancelled",
          detail: "fixture protection",
          pluginId: "guard",
          action: "save",
          operationId: "op-1",
        },
      },
    });
    expect(result.code).toBe("plugin_cancelled");
    expect(result.title).toBe("Blocked by plugin");
    expect(result.message).toContain("fixture protection");
    expect(result.message).toContain("guard");
  });

  it("maps plugin_guard_failed, operation_conflict and operation_partial", () => {
    expect(
      operationError({
        response: { status: 503, data: { code: "plugin_guard_failed", detail: "g", pluginId: "p" } },
      }).title,
    ).toBe("Plugin guard failed");
    expect(
      operationError({
        response: { status: 409, data: { code: "operation_conflict", detail: "changed" } },
      }).title,
    ).toBe("Conflict");
    expect(
      operationError({
        response: { status: 500, data: { code: "operation_partial", detail: "stopped" } },
      }).title,
    ).toBe("Partial failure");
  });

  it("ignores unknown codes", () => {
    expect(
      operationError({ response: { status: 409, data: { code: "note_exists" } } }),
    ).toBeNull();
  });
});
