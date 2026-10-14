import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "../../shared/uuid.ts";
import { createUuid as sdkUuid } from "../plugin-sdk.js";

const systemCrypto = globalThis.crypto;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("HTTP-compatible UUID contract", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", {
      getRandomValues: systemCrypto.getRandomValues.bind(systemCrypto),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the HTTP-available crypto surface without native UUID or subtle", () => {
    expect(crypto.randomUUID).toBeUndefined();
    expect(crypto.subtle).toBeUndefined();
    expect(createUuid()).toMatch(uuidV4);
    expect(sdkUuid()).toMatch(uuidV4);
  });

  it("preserves standard UUID-v4 version, variant and byte ordering", () => {
    crypto.getRandomValues = (bytes) => {
      bytes.set([0x91, 0x91, 0x08, 0xf7, 0x52, 0xd1, 0x83, 0x20,
        0x5b, 0xac, 0xf8, 0x47, 0xdb, 0x41, 0x48, 0xa8]);
      return bytes;
    };
    expect(createUuid()).toBe("919108f7-52d1-4320-9bac-f847db4148a8");
  });

  it("creates distinct standard identifiers across consumers", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => (i % 2 ? sdkUuid : createUuid)());
    expect(ids.every((id) => uuidV4.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("propagates a CSPRNG failure instead of weakening the random source", () => {
    crypto.getRandomValues = () => { throw Error("CSPRNG unavailable"); };
    expect(() => createUuid()).toThrow("CSPRNG unavailable");
  });
});
