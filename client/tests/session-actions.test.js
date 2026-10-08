import { beforeEach, describe, expect, it } from "vitest";
import {
  hasUnsavedWork,
  registerSessionParticipant,
  resolveParticipants,
} from "../sessionActions.js";

describe("sessionActions", () => {
  let dispose;
  beforeEach(() => {
    dispose?.();
    dispose = null;
  });

  it("proceeds immediately with no dirty participants", async () => {
    dispose = registerSessionParticipant("a", {
      hasUnsavedChanges: () => false,
    });
    expect(await resolveParticipants("logout")).toBe("proceed");
    expect(hasUnsavedWork()).toBe(false);
  });

  it("cancel preserves credentials and work (no save, no discard)", async () => {
    const calls = [];
    dispose = registerSessionParticipant("a", {
      hasUnsavedChanges: () => true,
      requestDecision: () => Promise.resolve("cancel"),
      save: () => calls.push("save"),
      discard: () => calls.push("discard"),
    });
    expect(await resolveParticipants("logout")).toBe("cancel");
    expect(calls).toEqual([]);
  });

  it("a failed/guard-blocked save aborts the handoff", async () => {
    dispose = registerSessionParticipant("a", {
      hasUnsavedChanges: () => true,
      requestDecision: () => Promise.resolve("save"),
      save: () => Promise.resolve(false), // plugin-cancelled save
    });
    expect(await resolveParticipants("logout")).toBe("cancel");
  });

  it("save then proceed; discard is explicit", async () => {
    const calls = [];
    dispose = registerSessionParticipant("a", {
      hasUnsavedChanges: () => true,
      requestDecision: () => Promise.resolve("save"),
      save: () => {
        calls.push("save");
        return Promise.resolve(true);
      },
      discard: () => calls.push("discard"),
    });
    expect(await resolveParticipants("logout")).toBe("proceed");
    expect(calls).toEqual(["save"]);

    const calls2 = [];
    dispose();
    dispose = registerSessionParticipant("b", {
      hasUnsavedChanges: () => true,
      requestDecision: () => Promise.resolve("discard"),
      discard: () => calls2.push("discard"),
    });
    expect(await resolveParticipants("logout")).toBe("proceed");
    expect(calls2).toEqual(["discard"]);
  });
});
