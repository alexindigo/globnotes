// SPDX-License-Identifier: LGPL-3.0-only
import { Buffer } from "node:buffer";
import { pbkdf2Sync } from "node:crypto";

const hashes = new Map<string, string>();

/** Deterministic test credentials; importing this module does not load config. */
export function fixturePasswordHash(password: string): string {
  let hash = hashes.get(password);
  if (!hash) {
    const salt = "00112233445566778899aabbccddeeff";
    hash = `pbkdf2_sha256$100000$${salt}$${
      pbkdf2Sync(password, Buffer.from(salt, "hex"), 100000, 32, "sha256")
        .toString("hex")
    }`;
    hashes.set(password, hash);
  }
  return hash;
}
