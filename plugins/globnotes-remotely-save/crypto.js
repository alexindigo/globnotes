// SPDX-License-Identifier: LGPL-3.0-only
// Independent OpenSSL format implementation; rclone's published codec is pinned.
import { Cipher, decryptedSize, encryptedSize } from "@fyears/rclone-crypt";

export const MAX_PLAINTEXT = 16 * 1024 * 1024;
export const MAX_WIRE = encryptedSize(MAX_PLAINTEXT) + 32;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const opensslMagic = encoder.encode("Salted__");
const rcloneMagic = encoder.encode("RCLONE\0\0");
const starts = (bytes, prefix) =>
  prefix.every((value, i) => bytes[i] === value);

export function base64url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function parse64(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw Error("invalid base64url");
  }
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (base64url(bytes) !== value) throw Error("noncanonical base64url");
  return bytes;
}

function parse32(value) {
  if (!/^[A-Z2-7]+$/.test(value)) throw Error("invalid base32");
  const bytes = [];
  let bits = 0, accumulator = 0;
  for (const point of value) {
    accumulator = (accumulator << 5) | base32Alphabet.indexOf(point);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
    }
    accumulator &= (1 << bits) - 1;
  }
  if (accumulator !== 0 || Math.ceil(bytes.length * 8 / 5) !== value.length) {
    throw Error("noncanonical base32");
  }
  return new Uint8Array(bytes);
}

/** Preserve spelling and case; comparison belongs to the mapping owner. */
export function validPath(value, folder = false) {
  if (
    typeof value !== "string" || !value || !value.isWellFormed() ||
    encoder.encode(value).length > 4096 || /[\\\x00-\x1f\x7f]/.test(value)
  ) return false;
  if (folder && value.endsWith("/")) value = value.slice(0, -1);
  return value.split("/").every((part) =>
    part && part !== "." && part !== ".." &&
    !part.startsWith(".globnotes-staging-")
  );
}

export function recognizedEncryptedName(value) {
  return value.startsWith("U2FsdGVkX") || value.startsWith("KNQWY5DFMRPV");
}

export function recognizedEncryptedBody(bytes) {
  return starts(bytes, opensslMagic) || starts(bytes, rcloneMagic);
}

async function opensslKey(password, salt) {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 20000, hash: "SHA-256" },
      passwordKey,
      384,
    ),
  );
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      derived.subarray(0, 32),
      "AES-CBC",
      false,
      ["encrypt", "decrypt"],
    );
    return { key, iv: derived.slice(32) };
  } finally {
    derived.fill(0);
  }
}

export async function createCodec(
  mode,
  password,
  failure = () =>
    Error("Remote encryption does not match the configured mode or key"),
) {
  if (!["none", "openssl-base64", "rclone-base64"].includes(mode)) {
    throw Error("Unknown encryption mode");
  }
  let cipher;
  if (mode === "rclone-base64") {
    cipher = new Cipher("base64");
    await cipher.key(password, "");
  }
  let closed = false;
  const check = () => {
    if (closed) throw Error("Codec is closed");
  };
  const safe = async (operation) => {
    check();
    try {
      return await operation();
    } catch {
      throw failure();
    }
  };
  const bounds = (size) => {
    if (!Number.isSafeInteger(size) || size < 0) throw failure();
    if (mode === "none") return { min: size, max: size };
    if (mode === "rclone-base64") {
      try {
        const plain = decryptedSize(size);
        return { min: plain, max: plain };
      } catch {
        throw failure();
      }
    }
    if (size < 32 || size % 16 !== 0) throw failure();
    return { min: size - 32, max: size - 17 };
  };
  const encrypt = (bytes, entropy) =>
    safe(async () => {
      if (mode === "none") return bytes;
      if (cipher) return await cipher.encryptData(bytes, entropy?.slice());
      const salt = entropy?.slice() ??
        crypto.getRandomValues(new Uint8Array(8));
      if (salt.length !== 8) throw Error("salt length");
      const { key, iv } = await opensslKey(password, salt);
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, bytes),
      );
      const wire = new Uint8Array(16 + ciphertext.length);
      wire.set(opensslMagic);
      wire.set(salt, 8);
      wire.set(ciphertext, 16);
      return wire;
    });
  const decrypt = (bytes) =>
    safe(async () => {
      if (mode === "none") {
        if (recognizedEncryptedBody(bytes)) {
          throw Error("encrypted body in plaintext mode");
        }
        return bytes;
      }
      bounds(bytes.length);
      if (cipher) return await cipher.decryptData(bytes);
      if (!starts(bytes, opensslMagic)) throw Error("OpenSSL framing");
      const { key, iv } = await opensslKey(password, bytes.slice(8, 16));
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-CBC", iv },
          key,
          bytes.slice(16),
        ),
      );
    });
  // Native per-segment lengths, shared by total-key and filesystem-backed DAV
  // admission. OpenSSL flattens the complete path; rclone keeps directories.
  const nameLengths = (path) => {
    const size = (text) => encoder.encode(text).length;
    const padded = (length) => (Math.floor(length / 16) + 1) * 16;
    const encoded = (length) => Math.ceil(length * 4 / 3);
    if (mode === "none") return path.split("/").map(size);
    if (mode === "openssl-base64") return [encoded(16 + padded(size(path)))];
    return path.split("/").map((segment) =>
      segment ? encoded(padded(size(segment))) : 0
    );
  };
  return {
    mode,
    bounds,
    // Encoded length is deterministic even when the OpenSSL salt/name is random.
    // Keep this next to the codec so backend name admission needs no async crypto.
    nameLengths,
    nameSize(path) {
      const parts = nameLengths(path);
      return parts.reduce((a, b) => a + b, 0) + parts.length - 1;
    },
    encrypt,
    decrypt,
    encryptName: (path, entropy) =>
      safe(async () => {
        if (!validPath(path, true)) throw Error("invalid path");
        if (mode === "none") {
          if (recognizedEncryptedName(path)) {
            throw Error("reserved encrypted name");
          }
          return path;
        }
        return cipher
          ? await cipher.encryptFileName(path)
          : base64url(await encrypt(encoder.encode(path), entropy));
      }),
    decryptName: (native) =>
      safe(async () => {
        let path;
        if (mode === "none") {
          if (recognizedEncryptedName(native)) {
            throw Error("encrypted name in plaintext mode");
          }
          path = native;
        } else if (cipher) {
          for (const segment of native.replace(/\/$/, "").split("/")) {
            parse64(segment);
          }
          path = await cipher.decryptFileName(native);
          // The dependency's nonfatal TextDecoder must not permit replacement aliases.
          if (await cipher.encryptFileName(path) !== native) {
            throw Error("noncanonical name");
          }
        } else {
          const bytes = native.startsWith("KNQWY5DFMRPV")
            ? parse32(native)
            : parse64(native);
          path = decoder.decode(await decrypt(bytes));
        }
        if (!validPath(path, true)) throw Error("invalid decoded path");
        return path;
      }),
    close() {
      closed = true;
      password = "";
      if (cipher) {
        const keys = cipher.getInternalKey();
        keys.dataKey.fill(0);
        keys.nameKey.fill(0);
        keys.nameTweak.fill(0);
        cipher = undefined;
      }
    },
  };
}
