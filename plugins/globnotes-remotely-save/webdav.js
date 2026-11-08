// SPDX-License-Identifier: LGPL-3.0-only
import { createHash } from "node:crypto";
import { array, child, text } from "./http.js";
import { MAX_WIRE, validPath } from "./crypto.js";
import { encodePath, strongEtag, timestamp } from "./s3.js";

const utf8 = new TextEncoder();
const quote = (value) =>
  '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const digest = (algorithm, value) =>
  createHash(algorithm).update(value).digest("hex");

export function digestChallenge(header, invalid) {
  if (!header?.startsWith("Digest ")) {
    throw invalid("WebDAV did not offer Digest authentication");
  }
  const values = {};
  let remainder = header.slice(7);
  while (remainder.trim()) {
    const match =
      /^\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))\s*(?:,|$)/
        .exec(remainder);
    if (!match || values[match[1].toLowerCase()] !== undefined) {
      throw invalid("Invalid Digest challenge");
    }
    values[match[1].toLowerCase()] = match[2] === undefined
      ? match[3]
      : match[2].replace(/\\(.)/g, "$1");
    remainder = remainder.slice(match[0].length);
  }
  const algorithm = (values.algorithm ?? "MD5").toUpperCase();
  if (
    !values.realm || !values.nonce ||
    ![
      "MD5",
      "MD5-SESS",
      "SHA-256",
      "SHA-256-SESS",
      "SHA-512-256",
      "SHA-512-256-SESS",
    ].includes(algorithm)
  ) throw invalid("Unsupported Digest challenge");
  const qops = values.qop?.split(",").map((value) => value.trim());
  const qop = qops?.includes("auth")
    ? "auth"
    : qops?.includes("auth-int")
    ? "auth-int"
    : null;
  if (qops && !qop) throw invalid("Unsupported Digest quality of protection");
  return { ...values, algorithm, qop };
}

export function digestAuthorization(
  challenge,
  method,
  url,
  bytes,
  username,
  password,
  count,
  cnonce,
) {
  const algorithm = challenge.algorithm.startsWith("MD5")
    ? "md5"
    : challenge.algorithm.startsWith("SHA-512")
    ? "sha512-256"
    : "sha256";
  const h = (value) => digest(algorithm, value);
  const uri = url.pathname + url.search;
  let ha1 = h(`${username}:${challenge.realm}:${password}`);
  if (challenge.algorithm.endsWith("-SESS")) {
    ha1 = h(`${ha1}:${challenge.nonce}:${cnonce}`);
  }
  const ha2 = h(
    `${method}:${uri}${
      challenge.qop === "auth-int" ? ":" + h(bytes ?? new Uint8Array()) : ""
    }`,
  );
  const nc = count.toString(16).padStart(8, "0");
  const response = challenge.qop
    ? h(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`)
    : h(`${ha1}:${challenge.nonce}:${ha2}`);
  const fields = {
    username: quote(username),
    realm: quote(challenge.realm),
    nonce: quote(challenge.nonce),
    uri: quote(uri),
    response: quote(response),
    algorithm: challenge.algorithm,
  };
  if (challenge.opaque) fields.opaque = quote(challenge.opaque);
  if (challenge.qop) {
    fields.qop = challenge.qop;
    fields.nc = nc;
    fields.cnonce = quote(cnonce);
  } else if (challenge.algorithm.endsWith("-SESS")) {
    fields.cnonce = quote(cnonce);
  }
  return "Digest " +
    Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(", ");
}

export function createWebdav(configuration, http) {
  const { url, baseDir, auth, username } = configuration.connection;
  const root = new URL(url);
  root.pathname += baseDir ? encodePath(baseDir) + "/" : "";
  const decodedRoot = decodeURIComponent(root.pathname);
  let challenge, count = 0, serverTime = null;
  let queue = [], visited = new Set();
  const target = (key) => {
    const result = new URL(root);
    result.pathname += encodePath(key);
    return result;
  };
  const request = async (address, options = {}) => {
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers);
    headers.set("cache-control", "no-cache");
    if (auth === "basic") {
      let binary = "";
      for (
        const byte of utf8.encode(
          `${username}:${configuration.credentials.password}`,
        )
      ) binary += String.fromCharCode(byte);
      headers.set("authorization", "Basic " + btoa(binary));
    } else if (auth === "digest") {
      if (!challenge) {
        const probe = await http.request(root, {
          method: "HEAD",
          raw401: true,
        });
        if (probe.status === 401) {
          challenge = digestChallenge(
            probe.headers.get("www-authenticate"),
            http.invalid,
          );
        }
      }
    }
    // A 401 is explicit rejection, so refreshing a stale nonce is safe even for
    // mutations. Never retry a lost/ambiguous response or an arbitrary auth failure.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (auth === "digest" && challenge) {
        headers.set(
          "authorization",
          digestAuthorization(
            challenge,
            method,
            address,
            options.bytes,
            username,
            configuration.credentials.password,
            ++count,
            crypto.randomUUID(),
          ),
        );
      }
      const response = await http.request(address, {
        ...options,
        headers,
        raw401: auth === "digest",
      });
      if (response.status !== 401) {
        serverTime = timestamp(response.headers.get("date"));
        return response;
      }
      const offered = digestChallenge(
        response.headers.get("www-authenticate"),
        http.invalid,
      );
      if (
        attempt || !challenge || offered.stale?.toLowerCase() !== "true" ||
        offered.nonce === challenge.nonce || offered.realm !== challenge.realm
      ) {
        throw http.error("unauthorized", "Remote credentials were rejected");
      }
      challenge = offered;
      count = 0;
    }
  };
  const c = (node, name) => child(node, name, http.invalid);
  function hrefKey(href) {
    let parsed;
    try {
      parsed = new URL(href, root);
    } catch {
      throw http.invalid("Invalid WebDAV href");
    }
    if (
      parsed.origin !== root.origin || parsed.username || parsed.password ||
      parsed.search || parsed.hash
    ) throw http.invalid("WebDAV href escaped its origin");
    // Decode each component once; encoded separators cannot manufacture hierarchy.
    let components;
    try {
      components = parsed.pathname.split("/").map(decodeURIComponent);
    } catch {
      throw http.invalid("Invalid WebDAV href encoding");
    }
    if (
      components.some((part) =>
        part.includes("/") || part.includes("\\") || part === "." ||
        part === ".."
      )
    ) throw http.invalid("Invalid WebDAV href path");
    const path = components.join("/");
    if (path === decodedRoot.slice(0, -1)) return "";
    if (!path.startsWith(decodedRoot)) {
      throw http.invalid("WebDAV href escaped its root");
    }
    const key = path.slice(decodedRoot.length);
    if (key && !validPath(key, true)) {
      throw http.invalid("Invalid WebDAV child name");
    }
    return key;
  }
  const metadata = (headers, length) => {
    const modified = timestamp(headers.get("last-modified"));
    if (modified === null) {
      throw http.invalid("WebDAV modification time is missing");
    }
    return {
      etag: strongEtag(headers.get("etag")),
      rawEtag: headers.get("etag"),
      modified,
      size: length,
      serverTime,
    };
  };
  async function propfind(key) {
    const response = await request(target(key), {
      method: "PROPFIND",
      headers: { depth: "1", "content-type": "application/xml; charset=utf-8" },
      bytes: utf8.encode(
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>',
      ),
    });
    if (response.status !== 207) {
      throw http.invalid("WebDAV did not return multistatus");
    }
    const multistatus = c(http.xml(response.bytes), "multistatus");
    if (!multistatus) throw http.invalid("Invalid WebDAV multistatus");
    const entries = [], seen = new Set();
    let self = false;
    for (const item of array(c(multistatus, "response"))) {
      const status = text(c(item, "status"));
      if (status && !/^HTTP\/\d(?:\.\d)? 2\d\d(?: |$)/.test(status)) {
        throw http.invalid("WebDAV child response failed");
      }
      let native = hrefKey(text(c(item, "href")));
      const stats = array(c(item, "propstat"));
      if (!stats.length) {
        throw http.invalid("WebDAV child properties are missing");
      }
      let properties = {};
      for (const stat of stats) {
        if (!/^HTTP\/\d(?:\.\d)? 2\d\d(?: |$)/.test(text(c(stat, "status")))) {
          throw http.invalid("WebDAV child property failed");
        }
        properties = { ...properties, ...c(stat, "prop") };
      }
      const folder =
        c(c(properties, "resourcetype"), "collection") !== undefined;
      if (folder && native && !native.endsWith("/")) native += "/";
      if (native.replace(/\/$/, "") === key.replace(/\/$/, "")) {
        if (self || !folder) {
          throw http.invalid("Invalid WebDAV self collection");
        }
        self = true;
        continue;
      }
      if (
        !native.startsWith(key) ||
        native.slice(key.length).replace(/\/$/, "").includes("/")
      ) throw http.invalid("WebDAV Depth:1 escaped its collection");
      if (seen.has(native)) throw http.invalid("Duplicate WebDAV href");
      seen.add(native);
      const rawSize = text(c(properties, "getcontentlength"));
      const size = folder ? 0 : Number(rawSize);
      const modified = folder
        ? 0
        : timestamp(text(c(properties, "getlastmodified")));
      if (
        !folder &&
        (!/^\d+$/.test(rawSize) || !Number.isSafeInteger(size) ||
          modified === null)
      ) throw http.invalid("Incomplete WebDAV file metadata");
      entries.push({
        key: native,
        folder,
        size,
        modified,
        etag: strongEtag(text(c(properties, "getetag"))),
        serverTime,
      });
    }
    if (!self) throw http.invalid("WebDAV omitted the requested collection");
    return entries;
  }
  return {
    // Portable native segment bound for filesystem-backed DAV (including Apache).
    // Apply to encoded native names, not the shorter canonical plaintext path.
    maxSegmentBytes: 255,
    async list(cursor) {
      if (!cursor) {
        queue = [""];
        visited = new Set();
      }
      if (cursor && cursor !== "continue") {
        throw http.invalid("Invalid WebDAV traversal state");
      }
      const collection = queue.shift();
      if (collection === undefined || visited.has(collection)) {
        throw http.invalid("Repeated WebDAV collection");
      }
      visited.add(collection);
      const entries = await propfind(collection);
      for (const entry of entries) if (entry.folder) queue.push(entry.key);
      return { entries, ...(queue.length ? { next: "continue" } : {}) };
    },
    async get(key) {
      const response = await request(target(key), { maximum: MAX_WIRE });
      return {
        ...metadata(response.headers, response.bytes.length),
        bytes: response.bytes,
      };
    },
    async put(key, bytes, condition) {
      const pieces = key.split("/");
      // Only create parents of this actual file. Never remove collections.
      for (let i = 1; i < pieces.length; i++) {
        const parent = pieces.slice(0, i).join("/") + "/";
        const result = await request(target(parent), {
          method: "MKCOL",
          accept: [405],
        });
        if (result.status === 405) await propfind(parent);
      }
      const headers = { "content-type": "application/octet-stream" };
      if (condition.ifMatch) headers["if-match"] = condition.ifMatch;
      if (condition.ifNoneMatch) headers["if-none-match"] = "*";
      const result = await request(target(key), {
        method: "PUT",
        bytes,
        headers,
      });
      return await http.afterMutation(async () => {
        // A GET independently observes the accepted bytes and actual current revision.
        const after = await request(target(key), { maximum: MAX_WIRE });
        if (
          after.bytes.length !== bytes.length ||
          after.bytes.some((value, i) => value !== bytes[i])
        ) throw http.error("invalid", "WebDAV changed after upload", "unknown");
        const meta = metadata(after.headers, after.bytes.length);
        const returnedEtag = strongEtag(result.headers.get("etag"));
        if (returnedEtag && meta.etag !== returnedEtag) {
          throw http.error(
            "invalid",
            "WebDAV revision changed after upload",
            "unknown",
          );
        }
        return { ...meta, bytes: after.bytes };
      });
    },
    async delete(key, condition) {
      if (key.endsWith("/")) {
        throw http.invalid("Collection deletion is unsupported");
      }
      await request(target(key), {
        method: "DELETE",
        headers: condition.ifMatch ? { "if-match": condition.ifMatch } : {},
      });
    },
    close() {
      challenge = undefined;
      queue = [];
      visited.clear();
      configuration.credentials = {};
    },
  };
}
