// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { storageDriver, StorageError } from "../server/plugins/driver_sdk.ts";
import { readConfiguration } from "../plugins/globnotes-remotely-save/config.js";
import { createCodec } from "../plugins/globnotes-remotely-save/crypto.js";
import {
  createHttp,
  parseXml,
} from "../plugins/globnotes-remotely-save/http.js";
import { createMapping } from "../plugins/globnotes-remotely-save/mapping.js";
import { createS3, signS3 } from "../plugins/globnotes-remotely-save/s3.js";
import {
  createWebdav,
  digestAuthorization,
  digestChallenge,
} from "../plugins/globnotes-remotely-save/webdav.js";
import { remotelySaveRemote } from "./helpers/remotely_save_remote.ts";
import { createHash, createHmac } from "node:crypto";

const encoder = new TextEncoder();
const md5 = (value: string) => createHash("md5").update(value).digest("hex");
const vectors = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/remotely-save/vectors.json", import.meta.url),
  ),
);
const ctx = (
  settings: Record<string, unknown>,
  keys: Record<string, string> = {},
) => ({
  instance: { settings },
  driver: { StorageError },
  secrets: { get: (key: string) => keys[key] ?? null },
  createUuid: () => crypto.randomUUID(),
  timers: { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) },
});
async function setup(
  backend: "s3" | "webdav",
  mode = "none",
  weak: boolean | "missing" = false,
  settings: Record<string, unknown> = {},
) {
  const remote = await remotelySaveRemote(backend);
  remote.weak(weak);
  const context = ctx(
    {
      ...(backend === "s3"
        ? {
          backend,
          encryption: mode,
          s3Endpoint: remote.url,
          s3Bucket: "bucket",
          s3Prefix: "prefix",
          s3PathStyle: true,
        }
        : {
          backend,
          encryption: mode,
          webdavUrl: remote.url + "/dav/",
          webdavBaseDir: "base",
        }),
      ...settings,
    },
    {
      s3_access_key: "test-access",
      s3_secret_key: "test-secret",
      encryption_password: vectors.password,
    },
  );
  const configuration = await readConfiguration(context);
  const http = createHttp(StorageError);
  const codec = await createCodec(
    mode,
    vectors.password,
    () => http.error("unauthorized", "key mismatch"),
  );
  const transport = backend === "s3"
    ? createS3(configuration, http)
    : createWebdav(configuration, http);
  const provider = createMapping(
    configuration,
    transport,
    codec,
    http,
    context,
  );
  const driver = storageDriver(provider);
  await driver.open();
  async function discover() {
    const entries = [];
    let cursor;
    do {
      const page = await driver.discover({
        mode: "snapshot",
        ...(cursor ? { cursor } : {}),
      });
      assert(page.completion !== "incomplete", JSON.stringify(page));
      entries.push(...page.entries);
      cursor = page.cursor;
    } while (cursor);
    return entries;
  }
  return {
    remote,
    codec,
    provider,
    driver,
    discover,
    async close() {
      provider.close();
      await remote.close();
    },
  };
}

Deno.test("remotely-save: selected configuration locks before IO and credential replacement preserves path-free identity", async () => {
  const settings = {
    backend: "s3",
    s3Endpoint: "http://storage.home",
    s3Bucket: "bucket",
    s3Prefix: "/Case/",
  };
  await assertRejects(
    () => readConfiguration(ctx(settings)),
    StorageError,
    "needs S3 access key",
  );
  const one = await readConfiguration(
    ctx(settings, { s3_access_key: "one", s3_secret_key: "secret" }),
  );
  const two = await readConfiguration(
    ctx(settings, { s3_access_key: "two", s3_secret_key: "replacement" }),
  );
  assertEquals(one.endpoint, two.endpoint);
  assertEquals(one.connection.prefix, "Case");
  assert(!JSON.stringify(one.endpoint).includes("Case"));
  const dav = await readConfiguration(
    ctx({ backend: "webdav", webdavUrl: "http://dav.home", webdavBaseDir: "" }),
  );
  assertEquals(dav.connection.baseDir, "");
  for (
    const webdavUrl of [
      "http://user:password@dav.home",
      "http://dav.home/?token=key",
      "http://dav.home/a/../b",
      "http://dav.home/#fragment",
    ]
  ) {
    await assertRejects(
      () => readConfiguration(ctx({ backend: "webdav", webdavUrl })),
      StorageError,
    );
  }
});

Deno.test("remotely-save: XML is bounded, namespace/text preserving and rejects DTD/custom entities", () => {
  const invalid = (message: string) => new Error(message);
  assertEquals(
    parseXml('<d:a xmlns:d="DAV:">0001 &amp; A</d:a>', invalid)["d:a"]["#text"],
    "0001 & A",
  );
  for (
    const xml of [
      '<!DOCTYPE a [<!ENTITY x "bad">]><a>&x;</a>',
      "<a>&custom;</a>",
      "<a>",
      "<a>" + "x".repeat(1024 * 1024) + "</a>",
    ]
  ) assertThrows(() => parseXml(xml, invalid));
});

Deno.test("remotely-save: normalized filters bind scope independently of credentials and endpoint identity", async () => {
  const settings = {
    backend: "webdav",
    webdavUrl: "http://dav.home/",
    webdavBaseDir: "Case",
    excludedPrefixes: "private/\n.DS_Store\nprivate/\n",
  };
  const first = await readConfiguration(ctx(settings));
  const reordered = await readConfiguration(ctx({
    ...settings,
    excludedPrefixes: ".DS_Store\r\nprivate/",
    webdavAuth: "basic",
    webdavUsername: "replacement",
  }, { webdav_password: "new-key" }));
  assertEquals(first.endpoint, reordered.endpoint);
  assertEquals(first.scope, reordered.scope);
  const changed = await readConfiguration(
    ctx({ ...settings, excludedPrefixes: "other/" }),
  );
  assertEquals(first.endpoint, changed.endpoint);
  assert(first.scope !== changed.scope);
});

for (const backend of ["s3", "webdav"] as const) {
  Deno.test(`remotely-save: ${backend} literal exclusions detach without hiding dotfiles or mutating either side`, async () => {
    const fixture = await setup(backend, "rclone-base64", false, {
      excludedPrefixes: "private/",
    });
    try {
      for (const path of ["private/a.md", "Private/a.md", ".hidden.md"]) {
        fixture.remote.set(
          await fixture.codec.encryptName(path),
          await fixture.codec.encrypt(encoder.encode(path)),
        );
      }
      const entries = await fixture.discover();
      assertEquals(
        entries.find((entry) =>
          "path" in entry && entry.path === "private/a.md"
        )?.state,
        "excluded",
      );
      assertEquals(
        entries.filter((entry) => entry.state === "known").map((entry) =>
          "path" in entry ? entry.path : ""
        ).sort(),
        [".hidden.md", "Private/a.md"],
      );
      const [receipt] = await fixture.driver.apply([{
        id: "excluded",
        op: "put",
        path: "private/new.md",
        bytes: encoder.encode("local"),
        base: { absent: true },
        batch: 1,
      }]);
      assertEquals(receipt.state, "excluded");
      assertEquals(
        fixture.remote.requests.filter((request) =>
          ["PUT", "DELETE", "MKCOL"].includes(request.method)
        ),
        [],
      );
      assertEquals(fixture.remote.objects.size, 3);
    } finally {
      await fixture.close();
    }
  });
}

Deno.test("remotely-save: DAV creates only required file parents and validates existing collections before PUT", async () => {
  const fixture = await setup("webdav");
  try {
    const create = (path: string) =>
      fixture.driver.apply([{
        id: path,
        op: "put" as const,
        path,
        bytes: encoder.encode("body"),
        base: { absent: true as const },
        batch: 1,
      }]);
    assertEquals((await create("one/two/percent %25.md"))[0].state, "settled");
    assertEquals(
      fixture.remote.requests.filter((request) => request.method === "MKCOL")
        .map((request) => request.key),
      ["one/", "one/two/"],
    );
    fixture.remote.fault((request, key) => {
      if (request.method === "MKCOL" && key === "one/two/") {
        return new Response(null, { status: 403 });
      }
    });
    const before = fixture.remote.requests.filter((request) =>
      request.method === "PUT"
    ).length;
    assertEquals((await create("one/two/denied.md"))[0].state, "failed");
    assertEquals(
      fixture.remote.requests.filter((request) => request.method === "PUT")
        .length,
      before,
    );
    fixture.remote.fault((request, key) => {
      if (request.method === "MKCOL" && key === "file-parent/") {
        return new Response(null, { status: 405 });
      }
      if (request.method === "PROPFIND" && key === "file-parent/") {
        return new Response(null, { status: 404 });
      }
    });
    // The claimed existing collection disappeared before validation: the SDK
    // classifies this observed not-found before PUT as a no-effect conflict.
    assertEquals((await create("file-parent/blocked.md"))[0].state, "conflict");
    assertEquals(
      fixture.remote.requests.filter((request) => request.method === "PUT")
        .length,
      before,
    );
    fixture.remote.fault(undefined);
    fixture.remote.folders.delete("");
    assertEquals(
      (await fixture.driver.discover({ mode: "snapshot" })).completion,
      "incomplete",
    );
    assertEquals(
      fixture.remote.requests.filter((request) => request.method === "DELETE"),
      [],
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("remotely-save: RFC Digest reference response and signed S3 encoded path/session credentials", async () => {
  const challenge = digestChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    (m: string) => new Error(m),
  );
  const auth = digestAuthorization(
    challenge,
    "GET",
    new URL("http://example.test/dir/index.html"),
    undefined,
    "Mufasa",
    "Circle Of Life",
    1,
    "0a4f113b",
  );
  assert(auth.includes('response="6629fae49393a05397450978507c4ef1"'));
  const url = new URL("http://storage.home/bucket/a%20b/%25file");
  const headers = await signS3(
    url,
    "GET",
    undefined,
    {},
    { accessKey: "test", secretKey: "secret", sessionToken: "session" },
    "us-east-1",
    new Date("2026-11-07T00:00:00Z"),
  );
  assertEquals(headers.get("x-amz-security-token"), "session");
  assertEquals(headers.get("host"), "storage.home");
  assert(
    headers.get("authorization")!.includes(
      "host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    ),
  );
  assertEquals(url.pathname, "/bucket/a%20b/%25file");
});

Deno.test("remotely-save: virtual-host S3 requests reach an independent HTTP SigV4 consumer with exact key escaping", async () => {
  const received: { method: string; path: string; host: string }[] = [];
  const sha = (value: string | Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
  const mac = (key: string | Uint8Array, value: string) =>
    createHmac("sha256", key).update(value).digest();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url),
        body = new Uint8Array(await request.arrayBuffer());
      const auth = request.headers.get("authorization")!;
      const fields =
        /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/
          .exec(auth);
      assert(fields);
      assertEquals(fields[1], "consumer-access");
      assertEquals(request.headers.get("host"), "bucket.storage.test:9000");
      assertEquals(request.headers.get("x-amz-security-token"), "session-only");
      assertEquals(request.headers.get("x-amz-content-sha256"), sha(body));
      const query = [...url.searchParams].map(([key, value]) =>
        [key, value].map((part) =>
          encodeURIComponent(part).replace(
            /[!'()*]/g,
            (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
          )
        )
      ).sort(([a, av], [b, bv]) =>
        a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0
      ).map((pair) => pair.join("=")).join("&");
      const canonical = [
        request.method,
        url.pathname,
        query,
        fields[3].split(";").map((key) =>
          `${key}:${request.headers.get(key)!.trim().replace(/\s+/g, " ")}\n`
        ).join(""),
        fields[3],
        sha(body),
      ].join("\n");
      const [day, region, service, end] = fields[2].split("/");
      assertEquals([region, service, end], ["us-east-1", "s3", "aws4_request"]);
      const key = mac(
        mac(mac(mac("AWS4consumer-secret", day), region), service),
        end,
      );
      const expected = mac(
        key,
        [
          "AWS4-HMAC-SHA256",
          request.headers.get("x-amz-date"),
          fields[2],
          sha(canonical),
        ].join("\n"),
      ).toString("hex");
      assertEquals(fields[4], expected);
      received.push({
        method: request.method,
        path: url.pathname,
        host: url.host,
      });
      const headers = {
        date: "Sun, 08 Nov 2026 09:00:00 GMT",
        etag: '"multipart-opaque-2"',
        "last-modified": "Sun, 08 Nov 2026 09:00:00 GMT",
        "content-length": "4",
      };
      if (request.method === "GET") return new Response("body", { headers });
      return new Response(null, {
        headers: request.method === "HEAD"
          ? headers
          : { date: headers.date, etag: headers.etag },
      });
    },
  );
  const configuration = await readConfiguration(
    ctx({
      backend: "s3",
      s3Endpoint: "http://storage.test:9000",
      s3Bucket: "bucket",
      s3Prefix: "prefix",
      s3PathStyle: false,
    }, {
      s3_access_key: "consumer-access",
      s3_secret_key: "consumer-secret",
      s3_session_token: "session-only",
    }),
  );
  // Deno's documented TCP proxy directs this test's connection to its port-0
  // receiver without rewriting the signed URL. Real alias/DNS proof uses MinIO.
  const client = Deno.createHttpClient({
    proxy: { transport: "tcp", hostname: "127.0.0.1", port: server.addr.port },
    allowHost: true,
  });
  const http = createHttp(
    StorageError,
    (url, options) => fetch(url, { ...options, client }),
  );
  const transport = createS3(configuration, http);
  try {
    const path = "space %25/Case-\u00e9.md";
    assertEquals(
      new TextDecoder().decode((await transport.get(path)).bytes),
      "body",
    );
    await transport.put(path, encoder.encode("body"), {
      ifMatch: '"multipart-opaque-2"',
    }, undefined);
    await transport.delete(path, { ifMatch: '"multipart-opaque-2"' });
    assertEquals(received.map((row) => row.method), [
      "GET",
      "PUT",
      "HEAD",
      "DELETE",
    ]);
    assert(
      received.every((row) =>
        row.path === "/prefix/space%20%2525/Case-%C3%A9.md"
      ),
    );
  } finally {
    transport.close();
    client.close();
    await server.shutdown();
  }
});

for (const backend of ["s3", "webdav"] as const) {
  Deno.test(`remotely-save: ${backend} failed post-upload observation cannot report a known no-effect result`, async () => {
    const fixture = await setup(backend);
    try {
      fixture.remote.set("A.md", "first");
      const first = (await fixture.discover())[0];
      assert(first.state === "known");
      let uploaded = false;
      fixture.remote.fault((request) => {
        if (request.method === "PUT") uploaded = true;
        if (uploaded && ["GET", "HEAD"].includes(request.method)) {
          return new Response(null, { status: 404 });
        }
        return undefined;
      });
      const [receipt] = await fixture.driver.apply([{
        id: "put",
        op: "put",
        path: first.path,
        batch: 1,
        bytes: encoder.encode("different size"),
        base: { revision: first.revision },
      }]);
      assertEquals(receipt.state, "uncertain");
      assertEquals(
        new TextDecoder().decode(fixture.remote.objects.get("A.md")!.bytes),
        "different size",
      );
      assertEquals(
        fixture.remote.requests.filter((r) => r.method === "PUT").length,
        1,
      );
    } finally {
      await fixture.close();
    }
  });

  Deno.test(`remotely-save: ${backend} a concurrent NFC alias prevents canonical create`, async () => {
    const fixture = await setup(backend);
    try {
      await fixture.discover();
      fixture.remote.set("cafe\u0301.md", "other client");
      const [receipt] = await fixture.driver.apply([{
        id: "put",
        op: "put",
        path: "caf\u00e9.md",
        batch: 1,
        bytes: encoder.encode("local bytes"),
        base: { absent: true },
      }]);
      assert(receipt.state !== "settled");
      assertEquals(fixture.remote.objects.size, 1);
      assertEquals(
        fixture.remote.requests.filter((r) => r.method === "PUT"),
        [],
      );
    } finally {
      await fixture.close();
    }
  });

  for (const mode of ["none", "openssl-base64", "rclone-base64"]) {
    Deno.test(`remotely-save: ${backend}/${mode} canonical inventory, exact IO, marker preservation, rapid edits and no replay`, async () => {
      const fixture = await setup(backend, mode);
      try {
        const native = await fixture.codec.encryptName("folder/Case %25.md");
        const metadata = await fixture.codec.encryptName(
          "_remotely-save-metadata-on-remote.json",
        );
        fixture.remote.set(
          native,
          await fixture.codec.encrypt(encoder.encode("first")),
        );
        fixture.remote.set(metadata, encoder.encode(vectors.legacyMetadata));
        const entries = await fixture.discover();
        assertEquals(entries.length, 1);
        const first = entries[0];
        assert(first.state === "known");
        assertEquals(first.path, "folder/Case %25.md");
        assertEquals(first.size, 5);
        assert(!first.revision.includes("folder"));
        const read = await fixture.driver.read({
          path: first.path,
          revision: first.revision,
        });
        assert(read.state === "known");
        assertEquals(new TextDecoder().decode(read.bytes), "first");
        const [receipt] = await fixture.driver.apply([{
          id: "put",
          op: "put",
          path: first.path,
          batch: 1,
          bytes: encoder.encode("other"),
          base: { revision: first.revision },
        }]);
        assertEquals(receipt.state, "settled");
        assertEquals(
          [...fixture.remote.objects.keys()].filter((k) => k !== metadata),
          [native],
        );
        assertEquals(
          new TextDecoder().decode(
            await fixture.codec.decrypt(
              fixture.remote.objects.get(native)!.bytes,
            ),
          ),
          "other",
        );
        const current = (await fixture.discover())[0];
        assert(current.state === "known");
        const [created] = await fixture.driver.apply([{
          id: "new",
          op: "put",
          path: "new/path.md",
          batch: 2,
          bytes: encoder.encode("new"),
          base: { absent: true },
        }]);
        assertEquals(created.state, "settled");
        const [deleted] = await fixture.driver.apply([{
          id: "delete",
          op: "delete",
          path: first.path,
          batch: 3,
          base: { revision: current.revision },
        }]);
        assertEquals(deleted.state, "settled");
        assert(!fixture.remote.objects.has(native));
        assertEquals(
          new TextDecoder().decode(fixture.remote.objects.get(metadata)!.bytes),
          vectors.legacyMetadata,
        );
        const mutations = fixture.remote.requests.filter((r) =>
          ["PUT", "DELETE"].includes(r.method)
        ).length;
        await fixture.discover();
        await fixture.discover();
        assertEquals(
          fixture.remote.requests.filter((r) =>
            ["PUT", "DELETE"].includes(r.method)
          ).length,
          mutations,
        );
        if (backend === "s3") {
          assert(fixture.remote.requests.every((r) =>
            r.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")
          ));
        }
      } finally {
        await fixture.close();
      }
    });
  }
}

for (const auth of ["basic", "digest"]) {
  Deno.test(`remotely-save: actual DAV ${auth} requests authenticate, stale nonces refresh after explicit rejection only`, async () => {
    const remote = remotelySaveRemote("webdav");
    const username = "test-user", password = "auth-only-password";
    let nonce = "initial-nonce", stale = false;
    const counts = new Map<string, number>();
    remote.set("percent %25.md", "first");
    remote.fault((request) => {
      const header = request.headers.get("authorization");
      if (auth === "basic") {
        if (header === "Basic " + btoa(`${username}:${password}`)) return;
      } else if (header?.startsWith("Digest ")) {
        const fields = Object.fromEntries(
          [...header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^, ]+))/g)].map((
            match,
          ) => [match[1], match[2] ?? match[3]]),
        );
        if (fields.nonce !== nonce) {
          stale = true;
        } else {
          const uri = new URL(request.url).pathname;
          const expected = md5(
            `${
              md5(`${username}:test-realm:${password}`)
            }:${nonce}:${fields.nc}:${fields.cnonce}:auth:${
              md5(`${request.method}:${uri}`)
            }`,
          );
          assertEquals(fields.uri, uri);
          assertEquals(fields.response, expected);
          assertEquals(fields.username, username);
          const nc = Number.parseInt(fields.nc, 16);
          assert(nc > (counts.get(nonce) ?? 0));
          counts.set(nonce, nc);
          return;
        }
      }
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": auth === "basic"
            ? 'Basic realm="test-realm"'
            : `Digest realm="test-realm", nonce="${nonce}", qop="auth", algorithm=MD5${
              stale ? ", stale=true" : ""
            }`,
        },
      });
    });
    const context = ctx({
      backend: "webdav",
      webdavUrl: remote.url + "/dav/",
      webdavBaseDir: "base",
      webdavAuth: auth,
      webdavUsername: username,
    }, { webdav_password: password });
    const configuration = await readConfiguration(context);
    const http = createHttp(StorageError),
      codec = await createCodec("none", "");
    const provider = createMapping(
      configuration,
      createWebdav(configuration, http),
      codec,
      http,
      context,
    );
    const driver = storageDriver(provider);
    try {
      assertEquals((await driver.open()).state, "ready");
      const first = await driver.discover({ mode: "snapshot" });
      assertEquals(first.completion, "complete");
      const entry = first.entries[0];
      assert(entry.state === "known");
      if (auth === "digest") nonce = "replacement-nonce";
      const read = await driver.read({
        path: entry.path,
        revision: entry.revision,
      });
      assertEquals(read.state, "known");
      const [receipt] = await driver.apply([{
        id: "auth-put",
        op: "put",
        path: entry.path,
        bytes: encoder.encode("authenticated upload"),
        base: { revision: entry.revision },
        batch: 1,
      }]);
      assertEquals(receipt.state, "settled");
      assertEquals(remote.requests.filter((r) => r.method === "PUT").length, 1);
      assertEquals(remote.requests.at(-1)!.key, "percent %25.md");
      if (auth === "digest") {
        assertEquals(counts.get("replacement-nonce")! > 0, true);
      }
    } finally {
      provider.close();
      await remote.close();
    }
  });
}

for (const backend of ["s3", "webdav"] as const) {
  Deno.test(`remotely-save: ${backend} bases changed during tick waits conflict before effect; nonadvancing accepted timestamps are uncertain`, async () => {
    const fixture = await setup(backend);
    try {
      fixture.remote.set("clock.md", "first");
      const oldTime = fixture.remote.objects.get("clock.md")!.modified;
      fixture.remote.clock(oldTime, 0);
      const entry = (await fixture.discover())[0];
      assert(entry.state === "known");
      let gets = 0;
      fixture.remote.fault((request, key) => {
        if (request.method === "GET" && ++gets === 2) {
          fixture.remote.set(key, "other");
        }
        return undefined;
      });
      await assertRejects(
        () =>
          fixture.provider.put(entry.path, encoder.encode("third"), {
            ifMatch: entry.revision,
          }),
        StorageError,
        "Remote base changed",
      );
      assertEquals(
        fixture.remote.requests.filter((r) => r.method === "PUT"),
        [],
      );
      fixture.remote.fault(undefined);
      const current = (await fixture.discover())[0];
      assert(current.state === "known");
      const baseTime = fixture.remote.objects.get("clock.md")!.modified;
      fixture.remote.clock(oldTime + 10000, 0);
      fixture.remote.fault((request, key) => {
        if (request.method !== "PUT") return;
        fixture.remote.set(key, fixture.remote.requests.at(-1)!.bytes);
        fixture.remote.objects.get(key)!.modified = baseTime;
        return new Response(null, {
          status: 201,
          headers: {
            etag: fixture.remote.objects.get(key)!.etag,
            date: new Date(oldTime + 10000).toUTCString(),
          },
        });
      });
      const [receipt] = await fixture.driver.apply([{
        id: "frozen-after-effect",
        op: "put",
        path: current.path,
        bytes: encoder.encode("third"),
        base: { revision: current.revision },
        batch: 1,
      }]);
      assertEquals(receipt.state, "uncertain");
      assertEquals(
        fixture.remote.requests.filter((r) => r.method === "PUT").length,
        1,
      );
      assertEquals(
        new TextDecoder().decode(fixture.remote.objects.get("clock.md")!.bytes),
        "third",
      );
    } finally {
      await fixture.close();
    }
  });

  Deno.test(`remotely-save: ${backend} frozen/skewed server clocks refuse equal-size replacement before effect and recover`, async () => {
    const fixture = await setup(backend);
    try {
      fixture.remote.set("clock.md", "first");
      const object = fixture.remote.objects.get("clock.md")!;
      fixture.remote.clock(object.modified, 0);
      const entry = (await fixture.discover())[0];
      assert(entry.state === "known");
      const item = {
        id: "clock",
        op: "put" as const,
        path: entry.path,
        bytes: encoder.encode("other"),
        base: { revision: entry.revision },
        batch: 1,
      };
      assertEquals((await fixture.driver.apply([item]))[0].state, "failed");
      assertEquals(
        fixture.remote.requests.filter((r) => r.method === "PUT"),
        [],
      );
      assertEquals(new TextDecoder().decode(object.bytes), "first");
      fixture.remote.clock(object.modified + 1000, 0);
      assertEquals((await fixture.driver.apply([item]))[0].state, "settled");
      assert(
        fixture.remote.objects.get("clock.md")!.modified > object.modified,
      );
    } finally {
      await fixture.close();
    }
  });
}

Deno.test("remotely-save: S3 future legacy client MTime also fences equal-size writes for accurate-mtime RS consumers", async () => {
  const fixture = await setup("s3");
  try {
    fixture.remote.set("clock.md", "first");
    const object = fixture.remote.objects.get("clock.md")!;
    object.mtime = String(object.modified + 24 * 60 * 60 * 1000); // legacy milliseconds
    fixture.remote.clock(object.modified + 1000, 0);
    const entry = (await fixture.discover())[0];
    assert(entry.state === "known");
    const receipt = (await fixture.driver.apply([{
      id: "skew",
      op: "put",
      path: entry.path,
      bytes: encoder.encode("other"),
      base: { revision: entry.revision },
      batch: 1,
    }]))[0];
    assertEquals(receipt.state, "failed");
    assertEquals(fixture.remote.requests.filter((r) => r.method === "PUT"), []);
  } finally {
    await fixture.close();
  }
});

for (const mode of ["none", "openssl-base64", "rclone-base64"]) {
  Deno.test(`remotely-save: DAV ${mode} native segment expansion is admitted before any parent or file mutation`, async () => {
    const fixture = await setup("webdav", mode);
    try {
      const path = "folder/" + "\u00e9".repeat(150) + ".md";
      const [receipt] = await fixture.driver.apply([{
        id: "dav-name",
        op: "put",
        path,
        bytes: encoder.encode("body"),
        base: { absent: true },
        batch: 1,
      }]);
      assertEquals(receipt.state, "unsupported");
      assertEquals(fixture.remote.requests, []);
      assertEquals(fixture.remote.objects.size, 0);
    } finally {
      await fixture.close();
    }
  });

  Deno.test(`remotely-save: S3 ${mode} key-byte bounds include prefix and encryption expansion, typed unsupported before dispatch`, async () => {
    const fixture = await setup("s3", mode);
    try {
      const path = "folder/" + "\u00e9".repeat(510) + ".md";
      const [receipt] = await fixture.driver.apply([{
        id: "name",
        op: "put",
        path,
        bytes: encoder.encode("body"),
        base: { absent: true },
        batch: 1,
      }]);
      assertEquals(receipt.state, "unsupported");
      assertEquals(fixture.remote.requests, []);
      assertEquals(fixture.remote.objects.size, 0);
    } finally {
      await fixture.close();
    }
  });
}

Deno.test("remotely-save: duplicate decoded/NFC names and later-page failure expose no known inventory", async () => {
  for (const backend of ["s3", "webdav"] as const) {
    const fixture = await setup(backend, "openssl-base64");
    try {
      for (const name of ["same.md", "same.md"]) {
        fixture.remote.set(
          await fixture.codec.encryptName(name),
          await fixture.codec.encrypt(encoder.encode("body")),
        );
      }
      const page = await fixture.driver.discover({ mode: "snapshot" });
      assertEquals(page.completion, "incomplete");
      assertEquals(page.entries[0].state, "locked");
      fixture.remote.objects.clear();
      for (const path of ["one.md", "two.md", "three.md"]) {
        fixture.remote.set(
          await fixture.codec.encryptName(path),
          await fixture.codec.encrypt(encoder.encode(path)),
        );
      }
      fixture.remote.fault((request) =>
        request.method === "PROPFIND" ||
          new URL(request.url).searchParams.has("continuation-token")
          ? new Response(null, { status: 500 })
          : undefined
      );
      const first = await fixture.driver.discover({ mode: "snapshot" });
      if (first.completion === "more") {
        assertEquals(first.entries, []);
        const failed = await fixture.driver.discover({
          mode: "snapshot",
          cursor: first.cursor,
        });
        assertEquals(failed.completion, "incomplete");
      } else assertEquals(first.completion, "incomplete");
    } finally {
      await fixture.close();
    }
  }
});

Deno.test("remotely-save: weak WebDAV observations use body digests but never send those as If-Match", async () => {
  const fixture = await setup("webdav", "none", true);
  try {
    fixture.remote.set("A.md", "before");
    const first = (await fixture.discover())[0];
    assert(first.state === "known");
    const [result] = await fixture.driver.apply([{
      id: "put",
      op: "put",
      path: first.path,
      batch: 1,
      bytes: encoder.encode("after!"),
      base: { revision: first.revision },
    }]);
    assertEquals(result.state, "settled");
    assertEquals(
      fixture.remote.requests.filter((r) => r.method === "PUT").at(-1)!.headers
        .get("if-match"),
      null,
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("remotely-save: missing DAV ETag uses body revisions, detects same-metadata edits and sends no invented If-Match", async () => {
  const fixture = await setup("webdav", "none", "missing");
  try {
    fixture.remote.set("no-etag.md", "first");
    const first = (await fixture.discover())[0];
    assert(first.state === "known");
    fixture.remote.objects.get("no-etag.md")!.bytes = encoder.encode("other");
    assertEquals(
      (await fixture.driver.read({
        path: first.path,
        revision: first.revision,
      })).state,
      "unknown",
    );
    const second = (await fixture.discover())[0];
    assert(second.state === "known");
    assert(first.revision !== second.revision);
    const [receipt] = await fixture.driver.apply([{
      id: "missing-etag",
      op: "put",
      path: first.path,
      bytes: encoder.encode("new body"),
      base: { revision: second.revision },
      batch: 1,
    }]);
    assertEquals(receipt.state, "settled");
    assertEquals(
      fixture.remote.requests.find((r) => r.method === "PUT")!.headers.get(
        "if-match",
      ),
      null,
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("remotely-save: S3 missing/repeated/truncated tokens and XML error envelopes never complete inventory", async () => {
  const fixture = await setup("s3");
  try {
    for (
      const xml of [
        "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>",
        "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken></NextContinuationToken></ListBucketResult>",
        "<ListBucketResult><IsTruncated>false</IsTruncated>",
        "<Error><Code>AccessDenied</Code></Error>",
        "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult><Error><Code>Denied</Code></Error>",
        "<ListBucketResult><IsTruncated>false</IsTruncated><IsTruncated>true</IsTruncated></ListBucketResult>",
      ]
    ) {
      fixture.remote.fault(() => new Response(xml));
      const page = await fixture.driver.discover({ mode: "snapshot" });
      assertEquals(page.completion, "incomplete", xml);
      assertEquals(page.entries.map((entry) => entry.state), ["unknown"]);
    }
    const loop =
      "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>opaque-path-bearing-token</NextContinuationToken></ListBucketResult>";
    fixture.remote.fault(() => new Response(loop));
    const first = await fixture.driver.discover({ mode: "snapshot" });
    assertEquals(first.completion, "more");
    assert(!JSON.stringify(first).includes("path-bearing"));
    const next = await fixture.driver.discover({
      mode: "snapshot",
      cursor: first.cursor,
    });
    assertEquals(next.completion, "incomplete");
    assertEquals(next.entries.map((entry) => entry.state), ["unknown"]);
  } finally {
    await fixture.close();
  }
});

Deno.test("remotely-save: DAV child response/propstat errors and hostile hrefs fail the whole snapshot", async () => {
  const fixture = await setup("webdav");
  try {
    const root =
      "<d:response><d:href>/dav/base/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>";
    const file = (href: string, status = "HTTP/1.1 200 OK", extra = "") =>
      `<d:response><d:href>${href}</d:href>${extra}<d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1</d:getcontentlength><d:getlastmodified>Sat, 07 Nov 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>${status}</d:status></d:propstat></d:response>`;
    for (
      const child of [
        file("/dav/base/child.md", "HTTP/1.1 403 Forbidden"),
        file(
          "/dav/base/child.md",
          undefined,
          "<d:status>HTTP/1.1 500 Error</d:status>",
        ),
        ...[
          "http://elsewhere.test/dav/base/child.md",
          "/dav/base-sibling/child.md",
          "/dav/base/%2fescape.md",
          "/dav/base/%5cescape.md",
          "/dav/base/../child.md",
          "/dav/base/%2e%2e/child.md",
          "/dav/base/sub/child.md",
          "/dav/base/child.md?secret=x",
          "/dav/base/%ZZ.md",
        ].map((href) => file(href)),
      ]
    ) {
      fixture.remote.fault((request) =>
        request.method === "PROPFIND"
          ? new Response(
            `<d:multistatus xmlns:d="DAV:">${root}${child}</d:multistatus>`,
            { status: 207 },
          )
          : undefined
      );
      const page = await fixture.driver.discover({ mode: "snapshot" });
      assertEquals(page.completion, "incomplete", child);
      assertEquals(page.entries.map((entry) => entry.state), ["unknown"]);
    }
    fixture.remote.fault((request) =>
      request.method === "PROPFIND"
        ? new Response(null, { status: 404 })
        : undefined
    );
    assertEquals(
      (await fixture.driver.discover({ mode: "snapshot" })).completion,
      "incomplete",
    );
    assertEquals(
      fixture.remote.requests.filter((r) =>
        ["MKCOL", "PUT", "DELETE"].includes(r.method)
      ).length,
      0,
    );
  } finally {
    await fixture.close();
  }
});

for (const backend of ["s3", "webdav"] as const) {
  Deno.test(`remotely-save: ${backend} NFC duplicate inventories and empty legacy encrypted folder markers`, async () => {
    const fixture = await setup(backend, "openssl-base64");
    try {
      // Reference-generated old base32 folder marker, plaintext empty body.
      const folder = vectors.names.find((entry: { path: string }) =>
        entry.path.endsWith("/")
      );
      assert(folder);
      fixture.remote.set(folder.openssl32, new Uint8Array());
      const note = await fixture.codec.encryptName("good.md");
      fixture.remote.set(
        note,
        await fixture.codec.encrypt(encoder.encode("body")),
      );
      assertEquals((await fixture.discover()).length, 1);
      for (const name of ["caf\u00e9.md", "cafe\u0301.md"]) {
        fixture.remote.set(
          await fixture.codec.encryptName(name),
          await fixture.codec.encrypt(encoder.encode("body")),
        );
      }
      let cursor;
      do {
        const page = await fixture.driver.discover({
          mode: "snapshot",
          ...(cursor ? { cursor } : {}),
        });
        assertEquals(
          page.entries.filter((entry) => entry.state === "known"),
          [],
        );
        if (page.completion === "incomplete") {
          assertEquals(page.entries[0].state, "locked");
          break;
        }
        assertEquals(page.completion, "more");
        cursor = page.cursor;
      } while (cursor);
      assert(fixture.remote.objects.has(folder.openssl32));
    } finally {
      await fixture.close();
    }
  });
}

for (const backend of ["s3", "webdav"] as const) {
  Deno.test(`remotely-save: ${backend} changed bases and occupied create destinations conflict before dispatch`, async () => {
    const fixture = await setup(backend);
    try {
      fixture.remote.set("A.md", "first");
      const first = (await fixture.discover())[0];
      assert(first.state === "known");
      fixture.remote.set("A.md", "other");
      const [conflict] = await fixture.driver.apply([{
        id: "changed",
        op: "put",
        path: "A.md",
        bytes: encoder.encode("third"),
        batch: 1,
        base: { revision: first.revision },
      }]);
      assertEquals(conflict.state, "conflict");
      const [occupied] = await fixture.driver.apply([{
        id: "occupied",
        op: "put",
        path: "A.md",
        bytes: encoder.encode("third"),
        batch: 2,
        base: { absent: true },
      }]);
      assertEquals(occupied.state, "conflict");
      assertEquals(
        fixture.remote.requests.filter((r) => r.method === "PUT"),
        [],
      );
      assertEquals(
        new TextDecoder().decode(fixture.remote.objects.get("A.md")!.bytes),
        "other",
      );
    } finally {
      await fixture.close();
    }
  });

  Deno.test(`remotely-save: ${backend} lost replies stay uncertain and denied deletes stay present`, async () => {
    const fixture = await setup(backend);
    try {
      fixture.remote.set("A.md", "first");
      const first = (await fixture.discover())[0];
      assert(first.state === "known");
      fixture.remote.fault((request, key) => {
        if (request.method === "PUT") {
          fixture.remote.set(key, "other");
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(Error("lost reply"));
              },
            }),
          );
        }
        return undefined;
      });
      const [uncertain] = await fixture.driver.apply([{
        id: "lost",
        op: "put",
        path: first.path,
        batch: 1,
        bytes: encoder.encode("other"),
        base: { revision: first.revision },
      }]);
      assertEquals(uncertain.state, "uncertain");
      assertEquals(
        fixture.remote.requests.filter((r) => r.method === "PUT").length,
        1,
      );
      fixture.remote.fault(undefined);
      const current = (await fixture.discover())[0];
      assert(current.state === "known");
      fixture.remote.fault((request) =>
        request.method === "DELETE"
          ? new Response(null, { status: 403 })
          : undefined
      );
      const [denied] = await fixture.driver.apply([{
        id: "denied",
        op: "delete",
        path: first.path,
        batch: 2,
        base: { revision: current.revision },
      }]);
      assertEquals(denied.state, "failed");
      assert(denied.state === "failed");
      assertEquals(denied.error.code, "denied");
      assert(fixture.remote.objects.has("A.md"));
      fixture.remote.fault((request, key) => {
        if (request.method === "DELETE") {
          fixture.remote.objects.delete(key);
          return new Response(null, { status: 500 });
        }
        return undefined;
      });
      const [deleted] = await fixture.driver.apply([{
        id: "lost-delete",
        op: "delete",
        path: first.path,
        batch: 3,
        base: { revision: current.revision },
      }]);
      assertEquals(deleted.state, "uncertain");
      fixture.remote.fault(undefined);
      assertEquals(await fixture.discover(), []);
    } finally {
      await fixture.close();
    }
  });

  Deno.test(`remotely-save: ${backend} mixed/corrupt data locks before known entries and recovery restarts inventory`, async () => {
    const fixture = await setup(backend, "rclone-base64");
    try {
      const native = await fixture.codec.encryptName("good.md");
      fixture.remote.set(
        native,
        await fixture.codec.encrypt(encoder.encode("valid")),
      );
      fixture.remote.set("plaintext.md", "mixed");
      const failed = await fixture.driver.discover({ mode: "snapshot" });
      assertEquals(failed.completion, "incomplete");
      assertEquals(failed.entries[0].state, "locked");
      assertEquals(
        failed.entries.filter((entry) => entry.state === "known"),
        [],
      );
      fixture.remote.objects.delete("plaintext.md");
      assertEquals((await fixture.discover()).length, 1);
      fixture.remote.set(native, encoder.encode("corrupt"));
      const corrupt = await fixture.driver.discover({ mode: "snapshot" });
      assertEquals(corrupt.completion, "incomplete");
      fixture.remote.fault(() =>
        new Response(null, { status: 429, headers: { "retry-after": "2" } })
      );
      const throttled = await fixture.driver.discover({ mode: "snapshot" });
      assertEquals(throttled.error?.code, "rate_limited");
      assertEquals(throttled.error?.retryAfterMs, 2000);
    } finally {
      await fixture.close();
    }
  });
}
