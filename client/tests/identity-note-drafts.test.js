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

it("a rejected replacement leaves the prior draft text and base together", () => {
  const quota = new DOMException("Storage is full", "QuotaExceededError");
  let budget = Infinity;
  const local = {
    getItem: key => localStorage.getItem(key),
    removeItem: key => localStorage.removeItem(key),
    setItem(key, value) {
      if (budget-- <= 0) throw quota;
      localStorage.setItem(key, value);
    },
  };
  const store = () => createIdentityNoteDraftStore({ prefix: "/one", local,
    identity: () => ({ principal: { kind: "account" }, accountId: "alice", vaultId: "vault" }),
    tokens: { isCurrentTokenStored: () => true },
  });
  store().save("Note", "first", 1, "first base");
  // Two writes fit but the third does not; either replacement result must be
  // a complete generation even if its order reservation already succeeded.
  budget = 2;
  let rejected = false;
  try { store().save("Note", "second", 2, "second base"); }
  catch (error) { expect(error).toBe(quota); rejected = true; }
  const recovery = store();
  expect([recovery.load("Note", 0), recovery.base("Note")]).toEqual(rejected
    ? ["first", "first base"] : ["second", "second base"]);
  budget = 1;
  expect(() => store().save("Note", "third", 3, "third base")).toThrow(quota);
  expect([recovery.load("Note", 0), recovery.base("Note")]).toEqual(rejected
    ? ["first", "first base"] : ["second", "second base"]);
});
