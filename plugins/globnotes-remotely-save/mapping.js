// SPDX-License-Identifier: LGPL-3.0-only
import { hash } from "./config.js";
import { MAX_PLAINTEXT, MAX_WIRE, validPath } from "./crypto.js";

const reserved = new Set([
  "_remotely-save-metadata-on-remote.json",
  "_remotely-save-metadata-on-remote.bin",
]);
const encoder = new TextEncoder();

/** This is the only canonical/native-name owner. All state is transient metadata;
 * bodies are decoded for validation and immediately released. No native keys,
 * backend cursors, names or traversal queues escape in persisted cursors. */
export function createMapping(configuration, backend, codec, http, ctx) {
  let active = new Map(), staging, handle;
  let closed = false;
  const locked = () =>
    http.error(
      "unauthorized",
      "Remote inventory is ambiguous or does not match its configured encryption",
    );
  const check = () => {
    if (closed) throw http.invalid("Remote mapping is closed");
  };
  const revision = async (native, observation) => {
    const content = observation.etag
      ? null
      : observation.bytes
      ? await hash(observation.bytes)
      : null;
    if (!observation.etag && content === null) {
      throw http.invalid(
        "A weak or missing ETag requires a complete body observation",
      );
    }
    return await hash(
      JSON.stringify([
        native,
        observation.etag ?? null,
        observation.modified,
        observation.size,
        content,
      ]),
    );
  };
  const observed = async (native, discovery) => {
    const result = await backend.get(native);
    if (
      discovery &&
      (result.etag !== discovery.etag || result.size !== discovery.size ||
        result.modified !== discovery.modified)
    ) {
      throw http.error(
        "precondition_failed",
        "Remote changed during discovery",
      );
    }
    const bytes = await codec.decrypt(result.bytes);
    return { result, bytes, revision: await revision(native, result) };
  };
  const start = () => {
    active.clear();
    staging = {
      map: new Map(),
      aliases: new Set(),
      native: new Set(),
      cursor: undefined,
      tokens: new Set(),
      pending: [],
      more: true,
      output: undefined,
      offset: 0,
    };
  };
  async function scanStep() {
    if (!staging.pending.length && staging.more) {
      const page = await backend.list(staging.cursor);
      if (
        page.entries.length > 1000 ||
        encoder.encode(JSON.stringify(page.entries)).length > 1024 * 1024
      ) throw http.invalid("Oversized remote metadata page");
      if (page.next && configuration.backend !== "webdav") {
        if (staging.tokens.has(page.next)) {
          throw http.invalid("Repeated backend continuation token");
        }
        staging.tokens.add(page.next);
      }
      staging.cursor = page.next;
      staging.more = page.next !== undefined;
      staging.pending = page.entries;
    }
    // Bound per-call network/crypto work as well as returned metadata.
    for (let i = 0; i < 16 && staging.pending.length; i++) {
      const entry = staging.pending.shift();
      if (!entry.key && entry.folder) continue; // A prefix-root marker, not a note.
      if (staging.native.has(entry.key)) throw locked();
      staging.native.add(entry.key);
      const path = await codec.decryptName(entry.key);
      if (entry.folder || path.endsWith("/")) continue;
      if (reserved.has(path)) continue;
      const comparison = path.normalize("NFC");
      if (staging.aliases.has(comparison)) throw locked();
      staging.aliases.add(comparison);
      const bounds = codec.bounds(entry.size);
      let size = bounds.min, token;
      if (entry.size <= MAX_WIRE && bounds.min <= MAX_PLAINTEXT) {
        const value = await observed(entry.key, entry);
        size = value.bytes.length;
        token = value.revision;
        // Never retain the body in either metadata map.
      } else {
        // Oversize remains an observed unsupported file, not omission. No bounded
        // body read can establish a weak revision for it, so bind native metadata.
        size = Math.max(MAX_PLAINTEXT + 1, bounds.min);
        token = await hash(
          JSON.stringify([
            entry.key,
            entry.etag,
            entry.modified,
            entry.size,
            "oversize",
          ]),
        );
      }
      staging.map.set(path, {
        native: entry.key,
        revision: token,
        size,
        metadata: entry,
      });
    }
    if (!staging.more && !staging.pending.length) {
      active = staging.map;
      staging.output = [...active].map(([key, value]) => ({
        key,
        size: value.size,
        etag: value.revision,
      }));
    }
  }
  async function fullLookup() {
    start();
    try {
      do {
        await scanStep();
      } while (!staging.output);
    } catch (error) {
      active.clear();
      staging = undefined;
      handle = undefined;
      throw error;
    }
    staging = undefined;
    handle = undefined;
  }
  const resolve = (path) => {
    check();
    if (!validPath(path) || reserved.has(path)) {
      throw http.invalid("Unsupported remote path");
    }
    for (const spelling of active.keys()) {
      if (
        spelling !== path && spelling.normalize("NFC") === path.normalize("NFC")
      ) {
        throw http.error(
          "precondition_failed",
          "Remote canonical name already exists with a different spelling",
        );
      }
    }
    return active.get(path);
  };
  const compare = (value, condition) => {
    if (
      condition.ifNoneMatch && value ||
      condition.ifMatch && value?.revision !== condition.ifMatch
    ) throw http.error("precondition_failed", "Remote base changed");
  };
  // RS's ordinary S3 walk sees LastModified; accurate-mtime mode also sees the
  // client metadata (legacy milliseconds included). Both must advance. DAV only
  // exposes Last-Modified. Server skew cannot authorize an undetectable write.
  const rsTime = (metadata) =>
    Math.max(metadata.modified, metadata.clientModified ?? 0);
  return {
    // SDK captures support before open. Send strong ETag conditions opportunistically,
    // but make no universal native-condition promise across DAV servers/codecs.
    conditions: { create: false, update: false, delete: false },
    identity: async () => configuration.endpoint,
    scope: () => configuration.scope,
    exclude: (path) =>
      configuration.excluded.some((prefix) => path.startsWith(prefix)),
    /** @returns {{ok:true,key:string}|{ok:false,reason:string}} */
    name(path) {
      if (!validPath(path) || reserved.has(path)) {
        return { ok: false, reason: "unsupported_remote_name" };
      }
      const nativeSize = active.has(path)
        ? encoder.encode(active.get(path).native).length
        : codec.nameSize(path);
      const lengths = active.has(path)
        ? active.get(path).native.split("/").map((part) =>
          encoder.encode(part).length
        )
        : codec.nameLengths(path);
      return nativeSize <= (backend.maxKeyBytes ?? Infinity) &&
          lengths.every((length) =>
            length <= (backend.maxSegmentBytes ?? Infinity)
          )
        ? { ok: true, key: path }
        : { ok: false, reason: "unsupported_remote_name" };
    },
    async list(cursor) {
      check();
      try {
        if (cursor === undefined) start();
        else if (!staging || cursor !== handle) {
          throw http.invalid("Expired inventory page handle");
        }
        if (!staging.output) await scanStep();
        let entries = [];
        if (staging.output) {
          let bytes = 0;
          while (
            entries.length < 1000 && staging.offset < staging.output.length
          ) {
            const entry = staging.output[staging.offset];
            const size = encoder.encode(JSON.stringify(entry)).length + 96;
            if (entries.length && bytes + size > 1024 * 1024 - 1024) break;
            entries.push(entry);
            staging.offset++;
            bytes += size;
          }
          if (staging.offset === staging.output.length) {
            staging = undefined;
            handle = undefined;
            return { entries };
          }
        }
        handle = ctx.createUuid();
        return { entries, next: handle };
      } catch (error) {
        active.clear();
        staging = undefined;
        handle = undefined;
        throw error;
      }
    },
    async get(path) {
      let value = resolve(path);
      if (!value) {
        await fullLookup();
        value = resolve(path);
      }
      if (!value) throw http.error("not_found", "Remote object is absent");
      const current = await observed(value.native);
      return { bytes: current.bytes, etag: current.revision };
    },
    async put(path, bytes, condition) {
      check();
      if (
        !validPath(path) || reserved.has(path) || bytes.length > MAX_PLAINTEXT
      ) throw http.invalid("Unsupported remote write");
      // Always refresh the complete canonical lookup before create. Salted OpenSSL
      // names have no atomic canonical absence condition; the disclosed race remains.
      if (condition.ifNoneMatch) await fullLookup();
      let value = resolve(path);
      if (value) {
        const fresh = await observed(value.native);
        value = {
          ...value,
          revision: fresh.revision,
          size: fresh.bytes.length,
          metadata: fresh.result,
        };
      }
      compare(value, condition);
      if (value && value.size === bytes.length) {
        let advance = false;
        for (let tries = 0; tries < 6; tries++) {
          const fresh = await observed(value.native);
          compare({ revision: fresh.revision }, condition);
          if (
            fresh.result.serverTime !== null &&
            fresh.result.serverTime > rsTime(value.metadata)
          ) {
            advance = true;
            break;
          }
          await new Promise((resolve) => ctx.timers.setTimeout(resolve, 250));
        }
        if (!advance) {
          throw http.error(
            "unavailable",
            "Cannot establish a later Remotely Save server-time tick",
          );
        }
      }
      const native = value?.native ?? await codec.encryptName(path);
      const wire = await codec.encrypt(bytes);
      const accepted = await backend.put(native, wire, {
        ...(value?.metadata.etag ? { ifMatch: value.metadata.etag } : {}),
        ...(!value ? { ifNoneMatch: "*" } : {}),
      }, value?.metadata);
      if (
        value && value.size === bytes.length &&
        (accepted.modified <= value.metadata.modified ||
          (accepted.clientModified ?? accepted.modified) <=
            rsTime(value.metadata))
      ) {
        throw http.error(
          "unavailable",
          "Remotely Save modification time did not advance",
          "unknown",
        );
      }
      // Missing/weak ETag requires bytes to compute the returned observation.
      const token = await revision(native, { ...accepted, bytes: wire });
      active.set(path, {
        native,
        revision: token,
        size: bytes.length,
        metadata: accepted,
      });
      return { etag: token };
    },
    async delete(path, condition) {
      const value = resolve(path);
      if (!value) throw http.error("not_found", "Remote object is absent");
      const current = await observed(value.native);
      compare({ revision: current.revision }, condition);
      await backend.delete(
        value.native,
        current.result.etag ? { ifMatch: current.result.etag } : {},
      );
      active.delete(path);
    },
    close() {
      closed = true;
      active.clear();
      staging = undefined;
      handle = undefined;
      codec.close();
      backend.close();
      configuration.password = "";
      configuration.credentials = {};
    },
  };
}
