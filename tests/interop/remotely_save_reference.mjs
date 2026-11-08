// SPDX-License-Identifier: LGPL-3.0-only
// Independent test client: no production transport, mapping, signer or codec imports.
import { createHash, createHmac } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { assert } from "@std/assert";
export const revision = "34db181af002f8d71ea0a87e7965abc57b294914";
const rcloneRevision = "fe7ce657bcf92566986ed1572f90e1cbb4683464";
const text = new TextDecoder();
const hex = (algorithm, value) =>
  createHash(algorithm).update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const escape = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const path = (value) => value.split("/").map(escape).join("/");
const xml = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  htmlEntities: true,
});
const array = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export async function referenceCodecs() {
  const directory = await Deno.makeTempDir({
    dir: "/artifacts",
    prefix: "upstream-",
  });
  const sources = [];
  async function download(url, name) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    assert(response.ok, `reference source ${response.status}`);
    const original = await response.text();
    await Deno.writeTextFile(`${directory}/${name}.original`, original);
    sources.push({ url, sha256: hex("sha256", original) });
    return original;
  }
  const imports = {
    "rfc4648": "npm:rfc4648@1.5.4",
    "@noble/hashes/scrypt": "npm:@noble/hashes@1.8.0/scrypt",
    "@noble/ciphers/salsa": "npm:@noble/ciphers@0.5.3/salsa",
    "@noble/ciphers/webcrypto": "npm:@noble/ciphers@0.5.3/webcrypto",
    "pkcs7-padding": "npm:pkcs7-padding@0.1.1",
    "@fyears/eme": "npm:@fyears/eme@0.0.3",
    "base32768": "npm:base32768@3.0.1",
  };
  const shim = (source) =>
    Object.entries(imports).reduce(
      (s, [name, target]) => s.replaceAll(`from "${name}"`, `from "${target}"`),
      source,
    );
  const original = await download(
    `https://raw.githubusercontent.com/remotely-save/remotely-save/${revision}/src/encryptOpenSSL.ts`,
    "openssl.ts",
  );
  await Deno.writeTextFile(
    `${directory}/openssl.ts`,
    shim(original).replace('from "./misc"', 'from "./misc.ts"'),
  );
  await Deno.writeTextFile(
    `${directory}/misc.ts`,
    `export const bufferToArrayBuffer=(b:Uint8Array)=>b.slice().buffer; export const hexStringToTypedArray=(h:string)=>Uint8Array.from(h.match(/../g)!,x=>parseInt(x,16));`,
  );
  await Deno.writeTextFile(
    `${directory}/rclone.ts`,
    shim(
      await download(
        `https://raw.githubusercontent.com/fyears/rclone-crypt/${rcloneRevision}/src/index.ts`,
        "rclone.ts",
      ),
    ),
  );
  globalThis.window = { crypto: globalThis.crypto };
  const openssl = await import(`file://${directory}/openssl.ts`);
  const { Cipher } = await import(`file://${directory}/rclone.ts`);
  await Deno.writeTextFile(
    `${directory}/provenance.json`,
    JSON.stringify(sources, null, 2),
  );
  return async (mode, password) => {
    const cipher = mode === "rclone-base64" ? new Cipher("base64") : null;
    if (cipher) await cipher.key(password, "");
    return {
      name: async (name, old = false) =>
        mode === "none"
          ? name
          : cipher
          ? await cipher.encryptFileName(name)
          : await openssl
            [old ? "encryptStringToBase32" : "encryptStringToBase64url"](
              name,
              password,
              20000,
            ),
      decodeName: async (name) =>
        mode === "none"
          ? name
          : cipher
          ? await cipher.decryptFileName(name)
          : name.startsWith("KNQ")
          ? await openssl.decryptBase32ToString(name, password)
          : await openssl.decryptBase64urlToString(name, password),
      encode: async (bytes) =>
        mode === "none"
          ? bytes
          : cipher
          ? await cipher.encryptData(bytes)
          : new Uint8Array(
            await openssl.encryptArrayBuffer(bytes.slice().buffer, password),
          ),
      decode: async (bytes) =>
        mode === "none"
          ? bytes
          : cipher
          ? await cipher.decryptData(bytes)
          : new Uint8Array(
            await openssl.decryptArrayBuffer(bytes.slice().buffer, password),
          ),
    };
  };
}

export function referenceStore(
  backend,
  endpoint,
  prefix,
  auth = "anonymous",
  pathStyle = true,
) {
  const base = new URL(endpoint + "/");
  if (backend === "s3") {
    if (pathStyle) base.pathname = "/bucket/";
    else base.hostname = "bucket." + base.hostname;
  } else base.pathname = "/" + prefix + "/";
  const log = [];
  let challenge, count = 0;
  async function request(method, key = "", bytes, extra = {}, query = {}) {
    const url = new URL(base);
    const native = backend === "s3" ? (prefix ? prefix + "/" : "") + key : key;
    url.pathname += path(native);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }
    const headers = new Headers(extra);
    if (backend === "s3") {
      const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
      const scope = `${date.slice(0, 8)}/us-east-1/s3/aws4_request`;
      headers.set("host", url.host);
      headers.set("x-amz-date", date);
      headers.set(
        "x-amz-content-sha256",
        hex("sha256", bytes ?? new Uint8Array()),
      );
      const names = [...headers.keys()].sort();
      const qs = [...url.searchParams].map(([k, v]) => [escape(k), escape(v)])
        .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
        .map(([k, v]) => `${k}=${v}`).join("&");
      const canonical = [
        method,
        url.pathname,
        qs,
        names.map((k) => `${k}:${headers.get(k).trim().replace(/\s+/g, " ")}\n`)
          .join(""),
        names.join(";"),
        headers.get("x-amz-content-sha256"),
      ].join("\n");
      const key = hmac(
        hmac(
          hmac(hmac("AWS4interop-secret", date.slice(0, 8)), "us-east-1"),
          "s3",
        ),
        "aws4_request",
      );
      headers.set(
        "authorization",
        `AWS4-HMAC-SHA256 Credential=interop-access/${scope}, SignedHeaders=${
          names.join(";")
        }, Signature=${
          hmac(
            key,
            `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hex("sha256", canonical)}`,
          ).toString("hex")
        }`,
      );
    } else if (auth === "basic") {
      headers.set("authorization", "Basic " + btoa("interop:interop-password"));
    } else if (auth === "digest") {
      if (!challenge) {
        const probe = await fetch(base, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
        });
        await probe.arrayBuffer();
        assert(probe.status === 401, "reference Digest challenge missing");
        const offered = probe.headers.get("www-authenticate");
        challenge = Object.fromEntries(
          [...offered.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
        );
        assert(
          challenge.qop.split(",").includes("auth"),
          "reference Digest auth not offered",
        );
      }
      const nc = (++count).toString(16).padStart(8, "0"),
        cnonce = crypto.randomUUID();
      const uri = url.pathname + url.search;
      const ha1 = hex("md5", `interop:${challenge.realm}:interop-password`),
        ha2 = hex("md5", `${method}:${uri}`);
      headers.set(
        "authorization",
        `Digest username="interop", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${
          hex("md5", `${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`)
        }"${challenge.opaque ? `, opaque="${challenge.opaque}"` : ""}`,
      );
    }
    const response = await fetch(url, {
      method,
      headers,
      body: bytes,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    log.push({ method, url: String(url), status: response.status });
    return { status: response.status, headers: response.headers, bytes: body };
  }
  const ok = (response) => {
    assert(
      response.status >= 200 && response.status < 300,
      `reference HTTP ${response.status}: ${text.decode(response.bytes)}`,
    );
    return response;
  };
  return {
    log,
    request,
    async initialize() {
      if (backend === "s3") {
        // Bucket setup always uses an independent path-style client without a prefix.
        const client = referenceStore("s3", endpoint, "");
        const result = await client.request("PUT");
        assert(
          [200, 409].includes(result.status),
          `bucket create ${result.status}`,
        );
      } else {
        const parts = prefix.split("/");
        // Auth roots exist in the Apache fixture, create only this run's child.
        for (let i = 1; i < parts.length; i++) {
          const parent = referenceStore(
            "webdav",
            endpoint,
            parts.slice(0, i).join("/"),
            auth,
          );
          const result = await parent.request("MKCOL", parts[i] + "/");
          assert(
            [201, 405].includes(result.status),
            `reference MKCOL ${result.status}`,
          );
        }
      }
    },
    async put(key, bytes, headers = {}) {
      if (backend === "webdav") {
        for (let i = 1; i < key.split("/").length; i++) {
          const result = await request(
            "MKCOL",
            key.split("/").slice(0, i).join("/") + "/",
          );
          assert(
            [201, 405].includes(result.status),
            `parent MKCOL ${result.status}`,
          );
        }
      }
      return ok(await request("PUT", key, bytes, headers));
    },
    async get(key) {
      return ok(await request("GET", key));
    },
    async remove(key) {
      return ok(await request("DELETE", key));
    },
    async list() {
      const entries = [];
      if (backend === "s3") {
        let token;
        do {
          // S3 list targets bucket root; request's key prefix must not enter URL path.
          const listClient = referenceStore(
            "s3",
            endpoint,
            "",
            auth,
            pathStyle,
          );
          const result = ok(
            await listClient.request("GET", "", undefined, {}, {
              "list-type": "2",
              "max-keys": "2",
              "encoding-type": "url",
              prefix: prefix + "/",
              ...(token ? { "continuation-token": token } : {}),
            }),
          );
          log.push(...listClient.log);
          const value = xml.parse(text.decode(result.bytes)).ListBucketResult;
          for (const item of array(value.Contents)) {
            const native = value.EncodingType === "url"
              ? new URLSearchParams(`key=${item.Key}`).get("key")
              : item.Key;
            assert(
              native.startsWith(prefix + "/"),
              "reference listing escaped prefix",
            );
            entries.push({
              key: native.slice(prefix.length + 1),
              etag: item.ETag,
              size: Number(item.Size),
              modified: Date.parse(item.LastModified),
            });
          }
          assert(
            ["true", "false"].includes(value.IsTruncated),
            "reference completion missing",
          );
          const next = value.IsTruncated === "true"
            ? value.NextContinuationToken
            : undefined;
          assert(!next || next !== token, "reference token repeated");
          assert(
            value.IsTruncated !== "true" || next,
            "reference token missing",
          );
          token = next;
        } while (token);
      } else {
        const queue = [""];
        for (const collection of queue) {
          const result = ok(
            await request("PROPFIND", collection, undefined, { depth: "1" }),
          );
          for (
            const item of array(
              xml.parse(text.decode(result.bytes)).multistatus.response,
            )
          ) {
            const stat = array(item.propstat).find((s) =>
              s.status.includes(" 200 ")
            );
            assert(stat, "reference child failed");
            const key = decodeURIComponent(new URL(item.href, base).pathname)
              .slice(base.pathname.length);
            if (key === collection || !key) continue;
            if (
              typeof stat.prop.resourcetype === "object" &&
              "collection" in stat.prop.resourcetype
            ) queue.push(key.endsWith("/") ? key : key + "/");
            else {entries.push({
                key,
                etag: stat.prop.getetag,
                size: Number(stat.prop.getcontentlength),
                modified: Date.parse(stat.prop.getlastmodified),
              });}
          }
        }
      }
      return entries;
    },
  };
}
