import { afterEach, expect, it } from "vitest";
import { createIdentityNoteDraftStore } from "../noteDrafts.js";

afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

function fixture() {
  let remembered = true;
  const store = (accountId = "alice") => createIdentityNoteDraftStore({ prefix: "/one",
    identity: () => ({ principal: { kind: "account" }, accountId, vaultId: "vault" }),
    tokens: { isCurrentTokenStored: () => remembered },
  });
  const first = store();
  first.save("Note", "A", 8);
  first.release();
  remembered = false;
  store().save("Note", "B", 1);
  return store;
}

it.each(["acknowledge", "discard", "tab closed"])("recovers the newest surviving draft after %s", action => {
  const store = fixture();
  const recovery = store();
  const offered = recovery.load("Note", 0);
  expect(store("bob").load("Note", 0)).toBeNull();
  if (action === "acknowledge") recovery.clearAcknowledged(0);
  if (action === "discard") recovery.clear();
  if (action === "tab closed") sessionStorage.clear();
  expect([offered, store().load("Note", 0)]).toEqual(["B", action === "tab closed" ? "A" : null]);
});

it("an acknowledgement for A cannot erase a newer copy B with identical text", () => {
  const store = fixture();
  sessionStorage.clear();
  const recovery = store();
  expect(recovery.load("Note", 0)).toBe("A");
  store().save("Note", "A", 1);
  recovery.clearAcknowledged(0);
  const surviving = store().load("Note", 0);
  sessionStorage.clear();
  expect([surviving, store().load("Note", 0)]).toEqual(["A", null]);
});
