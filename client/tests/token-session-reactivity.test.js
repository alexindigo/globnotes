import { afterEach, expect, it } from "vitest";
import { watch, nextTick } from "vue";
import { storeToken, getStoredToken, clearStoredToken } from "../tokenStorage.js";
afterEach(() => clearStoredToken());
it("in-place token acknowledgements update credential-scoped consumers without a route change", async () => {
  clearStoredToken(); const observed = [];
  const stop = watch(getStoredToken, value => observed.push(value));
  try {
    storeToken("first"); await nextTick(); storeToken("fresh"); await nextTick(); clearStoredToken(); await nextTick();
    expect(observed).toEqual(["first", "fresh", null]);
  } finally { stop(); }
});
