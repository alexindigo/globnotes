// SPDX-License-Identifier: LGPL-3.0-only
// Observe production HTTP requests, forwarding them unchanged to real services.
import { assert, assertEquals } from "@std/assert";
import {
  storageDriver,
  StorageError,
} from "../../server/plugins/driver_sdk.ts";
import { readConfiguration } from "../../plugins/globnotes-remotely-save/config.js";
import { createCodec } from "../../plugins/globnotes-remotely-save/crypto.js";
import { createHttp } from "../../plugins/globnotes-remotely-save/http.js";
import { createMapping } from "../../plugins/globnotes-remotely-save/mapping.js";
import { createS3 } from "../../plugins/globnotes-remotely-save/s3.js";
import { createWebdav } from "../../plugins/globnotes-remotely-save/webdav.js";
import { referenceCodecs, referenceStore } from "./remotely_save_reference.mjs";
import { done, pending, waitUntil } from "../helpers/wait.ts";

export async function incrementalTraffic(
  s3Endpoint: string,
  davEndpoint: string,
) {
  const factory = await referenceCodecs();
  const encoder = new TextEncoder();
  const reports = [];
  for (const backend of ["s3", "webdav"] as const) {
    for (const mode of ["none", "openssl-base64", "rclone-base64"]) {
      const label = `${backend}-${mode}`;
      const root = `traffic-${label}-${crypto.randomUUID()}`;
      const endpoint = backend === "s3" ? s3Endpoint : davEndpoint;
      const reference = referenceStore(
        backend,
        endpoint,
        backend === "s3" ? root : `anonymous/${root}`,
      );
      await reference.initialize();
      const password = "traffic-only-password";
      const independent = await factory(mode, password);
      const expected = new Map<string, Uint8Array>();
      const natives = new Map<string, string>();
      for (const path of ["a b.md", "a+b.md", "folder/C.md"]) {
        const native = await independent.name(path);
        natives.set(path, native);
        const bytes = encoder.encode(`initial:${path}`);
        expected.set(path, bytes);
        await reference.put(native, await independent.encode(bytes));
      }
      const stable = async () => {
        await waitUntil(async () => {
          const rows = await reference.list();
          for (const row of rows) {
            const head = await reference.request("HEAD", row.key);
            if (
              head.status !== 200 || !row.etag || row.etag.startsWith("W/") ||
              head.headers.get("etag") !== row.etag
            ) {
              return pending(
                "real listing/HEAD validators are not yet strong and equal",
              );
            }
          }
          return done();
        }, { label: `${label} stable strong validators` });
      };
      await stable();
      const context = {
        instance: {
          settings: backend === "s3"
            ? {
              backend,
              encryption: mode,
              s3Endpoint: endpoint,
              s3Bucket: "bucket",
              s3Prefix: root,
              s3PathStyle: true,
            }
            : {
              backend,
              encryption: mode,
              webdavUrl: `${endpoint}/anonymous/`,
              webdavBaseDir: root,
            },
        },
        driver: { StorageError },
        secrets: {
          get: (key: string) =>
            ({
              s3_access_key: "interop-access",
              s3_secret_key: "interop-secret",
              encryption_password: password,
            })[key] ?? null,
        },
        createUuid: () => crypto.randomUUID(),
        timers: { setTimeout },
      };
      const requests: {
        method: string;
        url: string;
        status: number;
        etag: string | null;
      }[] = [];
      const http = createHttp(
        StorageError,
        async (url, options) => {
          const response = await fetch(url, {
            ...options,
            signal: AbortSignal.timeout(15000),
          });
          requests.push({
            method: options?.method ?? "GET",
            url: String(url),
            status: response.status,
            etag: response.headers.get("etag"),
          });
          return response;
        },
      );
      const config = await readConfiguration(context);
      const codec = await createCodec(
        mode,
        password,
        () => http.invalid("Invalid body"),
      );
      const transport = backend === "s3"
        ? createS3(config, http)
        : createWebdav(config, http);
      const provider = createMapping(config, transport, codec, http, context);
      const driver = storageDriver(provider);
      const bodyGets = () =>
        requests.filter((row) =>
          row.method === "GET" &&
          !new URL(row.url).searchParams.has("list-type")
        );
      const discover = async () => {
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
      };
      try {
        assertEquals((await driver.open()).state, "ready");
        assertEquals((await discover()).length, 3);
        const cold = bodyGets().length;
        assertEquals(cold, 3);
        await discover();
        const warm = bodyGets().length - cold;
        assertEquals(warm, 0);
        const changedPath = "a b.md";
        expected.set(changedPath, encoder.encode("changed remotely"));
        await reference.put(
          natives.get(changedPath),
          await independent.encode(expected.get(changedPath)),
        );
        await stable();
        let before = bodyGets().length;
        const changed = (await discover()).find((row) =>
          "path" in row && row.path === changedPath
        );
        assert(changed?.state === "known");
        const changedGets = bodyGets().length - before;
        assertEquals(changedGets, 1);
        before = bodyGets().length;
        const read = await driver.read({
          path: changed.path,
          revision: changed.revision,
        });
        assert(read.state === "known");
        assertEquals(read.bytes, expected.get(changedPath));
        assertEquals(bodyGets().length - before, 1);
        const oldUrls = new Set(bodyGets().map((row) => row.url));
        before = bodyGets().length;
        const beforeRequests = requests.length;
        for (let i = 0; i < 16; i++) {
          const path = `New-${i}.md`, bytes = encoder.encode(`new ${i}`);
          assertEquals(
            (await driver.apply([{
              id: `create-${i}`,
              op: "put",
              path,
              bytes,
              base: { absent: true },
              batch: i + 1,
            }]))[0].state,
            "settled",
          );
          expected.set(path, bytes);
        }
        const createGets = bodyGets().slice(before);
        const oldBodyGets = createGets.filter((row) =>
          oldUrls.has(row.url)
        ).length;
        assertEquals(oldBodyGets, 0);
        const puts = requests.slice(beforeRequests).filter((row) =>
          row.method === "PUT"
        );
        assertEquals(puts.length, 16);
        for (const put of puts) {
          const ownGets = createGets.filter((row) =>
            row.url === put.url
          ).length;
          if (backend === "s3") assertEquals(ownGets, 0);
          else {assert(
              ownGets >= 1,
              "DAV must independently verify each upload",
            );}
        }
        const listingRequests = requests.slice(beforeRequests).filter((row) =>
          row.method === "PROPFIND" ||
          new URL(row.url).searchParams.has("list-type")
        ).length;
        assert(
          listingRequests >= 16,
          "Fresh canonical lookup must remain per create",
        );
        await stable();
        await discover(); // Validate any just-written weak->strong transitions.
        before = bodyGets().length;
        assertEquals((await discover()).length, 19);
        assertEquals(bodyGets().length - before, 0);
        const decoded = new Map<string, Uint8Array>();
        for (const row of await reference.list()) {
          decoded.set(
            await independent.decodeName(row.key),
            await independent.decode((await reference.get(row.key)).bytes),
          );
        }
        assertEquals(
          decoded,
          expected,
          "Independent client must see the complete output tree",
        );
        reports.push({
          label,
          cold,
          warm,
          changedGets,
          explicitReadGets: 1,
          creates: 16,
          oldBodyGets,
          createBodyGets: createGets.length,
          requiredUploadVerificationGets: backend === "webdav" ? 16 : 0,
          weakTransitionGets: createGets.length -
            (backend === "webdav" ? 16 : 0),
          listingRequests,
          requests,
        });
        await Deno.writeTextFile(
          "/artifacts/incremental-traffic.json",
          JSON.stringify(reports, null, 2),
        );
        console.log(
          `TRAFFIC ${label}: cold=${cold} warm=${warm} changed=${changedGets} old-create=${oldBodyGets} total-create=${createGets.length}`,
        );
      } finally {
        await driver.close();
      }
    }
  }
  assertEquals(reports.length, 6);
}
