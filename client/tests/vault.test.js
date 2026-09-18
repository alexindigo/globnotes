import { describe, expect, it } from "vitest";

import { notePath } from "../notePath.js";
import { clearStoredToken, getStoredToken, storeToken } from "../tokenStorage.js";
import { setVault } from "../vault.js";

describe("vault client helpers (empty slug)", () => {
  it("notePath stays root-relative", () => {
    expect(notePath("recipes/soup")).toBe("/recipes/soup");
  });

  it("tokens use the unsuffixed key", () => {
    setVault("");
    storeToken("abc");
    expect(getStoredToken()).toBe("abc");
    expect(sessionStorage.getItem("token")).toBe("abc");
    clearStoredToken();
  });

  it("per-slug tokens do not collide", () => {
    setVault("dad");
    storeToken("dad-tok");
    setVault("mom");
    storeToken("mom-tok");
    setVault("dad");
    expect(getStoredToken()).toBe("dad-tok");
    setVault("mom");
    expect(getStoredToken()).toBe("mom-tok");
    setVault("dad");
    clearStoredToken();
    setVault("mom");
    clearStoredToken();
    setVault("");
  });
});
