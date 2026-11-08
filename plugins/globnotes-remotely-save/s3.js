// SPDX-License-Identifier: LGPL-3.0-only
import { hash } from "./config.js";
import { array, child, text } from "./http.js";
import { MAX_WIRE } from "./crypto.js";

export const encodeSegment = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export const encodePath = (value) =>
  value.split("/").map(encodeSegment).join("/");
const utf8 = new TextEncoder();
const hex = (bytes) =>
  Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
async function hmac(key, value) {
  const imported = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? utf8.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, utf8.encode(value)),
  );
}

/** Independent AWS SigV4, explicit credentials only. URL.pathname is already
 * segment-encoded once; S3 does not normalize/double-encode the object path. */
export async function signS3(
  url,
  method,
  bytes,
  headers,
  credentials,
  region,
  now = new Date(),
) {
  const signed = new Headers(headers);
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const payloadHash = await hash(bytes ?? new Uint8Array());
  signed.set("host", url.host);
  signed.set("x-amz-date", date);
  signed.set("x-amz-content-sha256", payloadHash);
  if (credentials.sessionToken) {
    signed.set("x-amz-security-token", credentials.sessionToken);
  }
  const names = [...signed.keys()].sort();
  const canonicalHeaders = names.map((name) =>
    `${name}:${signed.get(name).trim().replace(/\s+/g, " ")}\n`
  ).join("");
  const query = [...url.searchParams].map((
    [key, value],
  ) => [encodeSegment(key), encodeSegment(value)]).sort(([ak, av], [bk, bv]) =>
    ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0
  ).map(([key, value]) => `${key}=${value}`).join("&");
  const canonical = [
    method,
    url.pathname,
    query,
    canonicalHeaders,
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${await hash(
    canonical,
  )}`;
  const key = await hmac(
    await hmac(
      await hmac(await hmac("AWS4" + credentials.secretKey, day), region),
      "s3",
    ),
    "aws4_request",
  );
  signed.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope}, SignedHeaders=${
      names.join(";")
    }, Signature=${hex(await hmac(key, stringToSign))}`,
  );
  key.fill(0);
  return signed;
}

export function strongEtag(value) {
  return typeof value === "string" &&
      /^"[\x21\x23-\x7e\x80-\uffff]+"$/.test(value)
    ? value
    : null;
}
export function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) * 1000 : null;
}
export function legacyTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? number >= 1e12 ? number : number * 1000
    : null;
}

export function createS3(configuration, http) {
  const { endpoint, bucket, prefix, region, pathStyle } =
    configuration.connection;
  const root = new URL(endpoint);
  if (pathStyle) root.pathname += encodeSegment(bucket) + "/";
  else root.hostname = bucket + "." + root.hostname;
  const nativePrefix = prefix ? prefix + "/" : "";
  let serverTime = null;
  const objectUrl = (key = "") => {
    const url = new URL(root);
    url.pathname += encodePath(nativePrefix + key);
    return url;
  };
  const request = async (url, method = "GET", bytes, headers = {}, maximum) => {
    const signed = await signS3(
      url,
      method,
      bytes,
      headers,
      configuration.credentials,
      region,
    );
    const result = await http.request(url, {
      method,
      bytes,
      headers: signed,
      maximum,
    });
    serverTime = timestamp(result.headers.get("date"));
    return result;
  };
  const metadata = (headers) => {
    const etag = strongEtag(headers.get("etag"));
    const modified = timestamp(headers.get("last-modified"));
    const size = Number(headers.get("content-length"));
    if (!etag || modified === null || !Number.isSafeInteger(size) || size < 0) {
      throw http.invalid("Incomplete S3 object metadata");
    }
    return {
      etag,
      modified,
      size,
      serverTime,
      created: legacyTime(headers.get("x-amz-meta-ctime")),
      clientModified: legacyTime(headers.get("x-amz-meta-mtime")),
    };
  };
  return {
    maxKeyBytes: 1024 - utf8.encode(nativePrefix).length,
    async list(cursor) {
      const url = new URL(root);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("max-keys", "1000");
      url.searchParams.set("encoding-type", "url");
      url.searchParams.set("prefix", nativePrefix);
      if (cursor) url.searchParams.set("continuation-token", cursor);
      const response = await request(url);
      const document = http.xml(response.bytes);
      const listing = child(document, "ListBucketResult", http.invalid);
      if (!listing || child(document, "Error", http.invalid)) {
        throw http.invalid("Invalid S3 listing response");
      }
      const c = (node, name) => child(node, name, http.invalid);
      const truncated = text(c(listing, "IsTruncated"));
      if (!["true", "false"].includes(truncated)) {
        throw http.invalid("Missing S3 completion flag");
      }
      const encoded = text(c(listing, "EncodingType"));
      if (encoded && encoded !== "url") {
        throw http.invalid("Unknown S3 name encoding");
      }
      const entries = array(c(listing, "Contents")).map((item) => {
        let key = text(c(item, "Key"));
        if (encoded === "url") {
          try {
            // ListObjects URL encoding also uses form-style '+' for spaces;
            // literal plus is %2B. Decode once, only for encoded responses.
            key = decodeURIComponent(key.replaceAll("+", " "));
          } catch {
            throw http.invalid("Invalid S3 key encoding");
          }
        }
        if (!key.startsWith(nativePrefix)) {
          throw http.invalid("S3 listing escaped its prefix");
        }
        key = key.slice(nativePrefix.length);
        const rawSize = text(c(item, "Size"));
        const size = Number(rawSize);
        const etag = strongEtag(text(c(item, "ETag")));
        const modified = timestamp(text(c(item, "LastModified")));
        if (
          !/^\d+$/.test(rawSize) || !Number.isSafeInteger(size) || !etag ||
          modified === null
        ) throw http.invalid("Incomplete S3 listing entry");
        return {
          key,
          size,
          etag,
          modified,
          folder: key.endsWith("/"),
          serverTime,
        };
      });
      if (entries.length > 1000) {
        throw http.invalid("Oversized S3 listing page");
      }
      const next = text(c(listing, "NextContinuationToken"));
      if (truncated === "true" && (!next || next === cursor)) {
        throw http.invalid("Missing or repeated S3 continuation token");
      }
      return { entries, ...(truncated === "true" ? { next } : {}) };
    },
    async get(key) {
      const response = await request(
        objectUrl(key),
        "GET",
        undefined,
        {},
        MAX_WIRE,
      );
      const meta = metadata(response.headers);
      if (response.bytes.length !== meta.size) {
        throw http.invalid("Truncated S3 object");
      }
      return { ...meta, bytes: response.bytes };
    },
    async head(key) {
      return metadata((await request(objectUrl(key), "HEAD")).headers);
    },
    async put(key, bytes, condition, previous) {
      const stamp = serverTime === null ? null : Math.floor(serverTime / 1000);
      if (stamp === null) {
        throw http.invalid("S3 did not supply a server clock");
      }
      const headers = {
        "content-type": "application/octet-stream",
        "x-amz-meta-mtime": String(stamp),
        "x-amz-meta-ctime": String(
          previous?.created ? previous.created / 1000 : stamp,
        ),
      };
      if (condition.ifMatch) headers["if-match"] = condition.ifMatch;
      if (condition.ifNoneMatch) headers["if-none-match"] = "*";
      const response = await request(objectUrl(key), "PUT", bytes, headers);
      return await http.afterMutation(async () => {
        const etag = strongEtag(response.headers.get("etag"));
        if (!etag) {
          throw http.error(
            "invalid",
            "S3 write revision is missing",
            "unknown",
          );
        }
        const actual = metadata(
          (await request(objectUrl(key), "HEAD")).headers,
        );
        if (actual.etag !== etag) {
          throw http.error(
            "precondition_failed",
            "S3 changed after upload",
            "unknown",
          );
        }
        return actual;
      });
    },
    async delete(key, condition) {
      await request(
        objectUrl(key),
        "DELETE",
        undefined,
        condition.ifMatch ? { "if-match": condition.ifMatch } : {},
      );
    },
    close() {
      configuration.credentials = {};
      serverTime = null;
    },
  };
}
