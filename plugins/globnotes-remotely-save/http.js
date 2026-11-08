// SPDX-License-Identifier: LGPL-3.0-only
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const METADATA_LIMIT = 1024 * 1024;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  // Enables numeric decoding in fast-xml-parser. parseXml's allowlist still
  // rejects every named entity except the five predefined XML entities.
  htmlEntities: true,
  removeNSPrefix: false,
});

export function parseXml(text, invalid) {
  if (
    new TextEncoder().encode(text).length > METADATA_LIMIT ||
    /<!\s*(?:DOCTYPE|ENTITY)/i.test(text) ||
    /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)
  ) throw invalid("Invalid or oversized remote XML");
  // XML 1.0 Char, not merely a JavaScript code point. Check both attributes and
  // content before parser entity expansion (which may throw or leave it raw).
  for (const [, reference] of text.matchAll(/&#(x[0-9a-fA-F]+|\d+);/g)) {
    const value = reference.startsWith("x")
      ? Number.parseInt(reference.slice(1), 16)
      : Number(reference);
    if (
      !(value === 9 || value === 10 || value === 13 ||
        value >= 0x20 && value <= 0xD7FF ||
        value >= 0xE000 && value <= 0xFFFD ||
        value >= 0x10000 && value <= 0x10FFFF)
    ) {
      throw invalid("Invalid remote XML character reference");
    }
  }
  try {
    if (XMLValidator.validate(text) !== true) {
      throw invalid("Invalid remote XML");
    }
    return xmlParser.parse(text);
  } catch {
    throw invalid("Invalid remote XML");
  }
}

export const array = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
export const text = (value) =>
  typeof value === "string"
    ? value
    : typeof value?.["#text"] === "string"
    ? value["#text"]
    : "";
/** Namespace prefixes remain in the parsed representation. Never depend on a
 * server choosing one particular prefix; reject duplicate local-name aliases. */
export function child(node, name, invalid) {
  const keys = Object.keys(node ?? {}).filter((key) =>
    !key.startsWith("@_") && key.split(":").at(-1) === name
  );
  if (keys.length > 1) throw invalid("Ambiguous XML namespace aliases");
  return keys.length ? node[keys[0]] : undefined;
}

export function createHttp(StorageError, fetchRemote = fetch) {
  const error = (code, message, effect = "none", retryAfterMs) =>
    new StorageError(code, { effect, message, retryAfterMs });
  const invalid = (message) => error("invalid", message);
  async function body(response, maximum, mutation) {
    const chunks = [];
    let length = 0;
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > maximum) {
          throw error(
            "invalid",
            "Remote response is too large",
            mutation ? "unknown" : "none",
          );
        }
        chunks.push(part.value);
      }
    } catch (cause) {
      reader.cancel().catch(() => {});
      if (cause instanceof StorageError) throw cause;
      throw error(
        "network",
        "Remote response was interrupted",
        mutation ? "unknown" : "none",
      );
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  async function request(url, options = {}) {
    const {
      method = "GET",
      headers,
      bytes,
      maximum = METADATA_LIMIT,
      accept = [],
      raw401 = false,
    } = options;
    const mutation = ["PUT", "DELETE", "MKCOL"].includes(method);
    let response;
    try {
      response = await fetchRemote(url, {
        method,
        headers,
        body: bytes,
        redirect: "manual",
      });
    } catch (cause) {
      if (cause?.name === "NotCapable" || cause?.name === "PermissionDenied") {
        throw cause;
      }
      throw error(
        "network",
        "Remote connection failed",
        mutation ? "unknown" : "none",
      );
    }
    const discard = () => response.body?.cancel().catch(() => {});
    const status = response.status;
    if (status === 401 && raw401) {
      discard();
      return { status, headers: response.headers, bytes: new Uint8Array() };
    }
    if (!response.ok && !accept.includes(status)) {
      discard();
      if (status === 401 || status === 403) {
        throw error(
          status === 401 ? "unauthorized" : "forbidden",
          "Remote credentials were rejected",
        );
      }
      if (status === 404) throw error("not_found", "Remote object is absent");
      if (status === 412 || status === 409 && method === "PUT") {
        throw error("precondition_failed", "Remote version changed");
      }
      if (status === 429 || status === 503) {
        const advice = response.headers.get("retry-after");
        const ms = advice === null
          ? undefined
          : /^\d+$/.test(advice)
          ? Number(advice) * 1000
          : Math.max(0, Date.parse(advice) - Date.now());
        throw error(
          "rate_limited",
          "Remote requested a retry",
          mutation ? "unknown" : "none",
          ms,
        );
      }
      throw error(
        status >= 500 ? "unavailable" : "invalid",
        status >= 300 && status < 400
          ? "Remote redirects are not followed"
          : "Remote request failed",
        mutation ? "unknown" : "none",
      );
    }
    return {
      status,
      headers: response.headers,
      bytes: await body(response, maximum, mutation),
    };
  }
  return {
    request,
    error,
    invalid,
    // Once a mutation has been accepted, a subsequent read/metadata failure says
    // nothing about whether that mutation happened. Both backends share this fence.
    async afterMutation(observe) {
      try {
        return await observe();
      } catch (cause) {
        throw error(
          cause instanceof StorageError ? cause.code : "network",
          "Post-mutation observation failed",
          "unknown",
          cause.retryAfterMs,
        );
      }
    },
    xml: (bytes) =>
      parseXml(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        invalid,
      ),
  };
}
