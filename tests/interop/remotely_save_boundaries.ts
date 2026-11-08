// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { remotelySaveServerFixture } from "../helpers/remotely_save_fixture.ts";
import { referenceCodecs, referenceStore } from "./remotely_save_reference.mjs";
import { activate } from "../../plugins/globnotes-remotely-save/driver.js";
import {
  storageDriver,
  StorageError,
} from "../../server/plugins/driver_sdk.ts";
import type { Driver } from "../../server/plugins/driver_contract.ts";

export async function nativeNameBoundaries(endpoint: string) {
  const factory = await referenceCodecs();
  const encoder = new TextEncoder();
  const raw = referenceStore("webdav", endpoint, "anonymous/native-boundary");
  await raw.initialize();
  const fitting = "n".repeat(255), tooLong = "n".repeat(256);
  await raw.put(fitting, encoder.encode("fits the actual filesystem"));
  assertEquals(
    (await raw.get(fitting)).bytes,
    encoder.encode("fits the actual filesystem"),
  );
  const rejected = await raw.request(
    "PUT",
    tooLong,
    encoder.encode("must not be renamed"),
  );
  assert(
    rejected.status >= 400,
    "Apache unexpectedly accepted a 256-byte native segment",
  );
  assertEquals((await raw.list()).map((row) => row.key), [fitting]);
  await raw.remove(fitting);
  const results: unknown[] = [{
    native255: "stored/read exactly",
    native256: rejected.status,
  }];
  for (const mode of ["none", "openssl-base64", "rclone-base64"]) {
    const password = "boundary-only-password";
    const codec = await factory(mode, password);
    // Compute the largest supported plaintext length using the independent
    // upstream encoder, not the product's synchronous estimator under test.
    let low = 1, high = 256;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (
        encoder.encode(await codec.name("a".repeat(middle) + ".md")).length <=
          255
      ) low = middle;
      else high = middle;
    }
    const supported = "a".repeat(low) + ".md",
      unsupported = "a".repeat(high) + ".md";
    const remote = referenceStore(
      "webdav",
      endpoint,
      `anonymous/boundary-${mode}`,
    );
    await remote.initialize();
    if (mode === "none") {
      // A 256-byte plaintext segment cannot exist in this vault filesystem
      // either. Exercise admission at the actual driver/SDK boundary instead.
      let driver!: Driver;
      activate({
        instance: {
          settings: {
            backend: "webdav",
            encryption: mode,
            webdavUrl: `${endpoint}/anonymous/`,
            webdavBaseDir: `boundary-${mode}`,
          },
        },
        driver: {
          StorageError,
          storage: storageDriver,
          serve(value: Driver) {
            driver = value;
          },
        },
        secrets: { get: () => null },
        timers: { setTimeout },
        register() {},
      });
      try {
        assertEquals((await driver.open()).state, "ready");
        const receipts = await driver.apply([
          {
            id: "supported",
            op: "put",
            path: supported,
            batch: 1,
            base: { absent: true },
            bytes: encoder.encode("exact supported output"),
          },
          {
            id: "unsupported",
            op: "put",
            path: unsupported,
            batch: 2,
            base: { absent: true },
            bytes: encoder.encode("must not be sent"),
          },
        ]);
        assertEquals(receipts.map((row) => row.state), [
          "settled",
          "unsupported",
        ]);
        assertEquals((await remote.list()).map((row) => row.key), [supported]);
        assertEquals(
          (await remote.get(supported)).bytes,
          encoder.encode("exact supported output"),
        );
        results.push({
          mode,
          supportedPlaintextBytes: 255,
          supportedNativeBytes: 255,
          unsupportedPlaintextBytes: 256,
          unsupportedNativeBytes: 256,
          receipts,
        });
      } finally {
        await driver.close();
      }
      continue;
    }
    const f = await remotelySaveServerFixture([new URL(endpoint).host]);
    try {
      const id = await f.add({
        backend: "webdav",
        encryption: mode,
        webdavUrl: `${endpoint}/anonymous/`,
        webdavBaseDir: `boundary-${mode}`,
      }, { encryption_password: password });
      assertEquals((await f.one(id)).status, "active");
      await f.call("notes", "POST", {
        path: supported.slice(0, -3),
        content: "exact supported output",
      });
      await f.call("notes", "POST", {
        path: unsupported.slice(0, -3),
        content: "unsupported output remains here",
      });
      await f.sync(id);
      const listing = await remote.list();
      assertEquals(listing.length, 1);
      assertEquals(await codec.decodeName(listing[0].key), supported);
      assertEquals(
        await codec.decode((await remote.get(listing[0].key)).bytes),
        encoder.encode("exact supported output"),
      );
      assertEquals(
        Deno.readTextFileSync(`${f.vault}/${unsupported}`),
        "unsupported output remains here",
      );
      assert(
        (await f.one(id)).attention.issues.some((
          issue: { path: string; code: string },
        ) => issue.path === unsupported && issue.code === "unsupported"),
      );
      const traffic = Deno.readTextFileSync(
        "/artifacts/services/dav/requests.log",
      );
      const writes = traffic.split("\n").filter((line) =>
        line.includes(`/boundary-${mode}/`) && / PUT /.test(line)
      );
      assertEquals(
        writes.length,
        1,
        "unsupported native name dispatched to Apache",
      );
      results.push({
        mode,
        supportedPlaintextBytes: encoder.encode(supported).length,
        supportedNativeBytes: encoder.encode(listing[0].key).length,
        unsupportedPlaintextBytes: encoder.encode(unsupported).length,
        unsupportedNativeBytes:
          encoder.encode(await codec.name(unsupported)).length,
        serverWrites: writes,
      });
    } finally {
      await f.close();
    }
  }
  await Deno.writeTextFile(
    "/artifacts/apache-name-boundaries.json",
    JSON.stringify(results, null, 2),
  );
}

if (import.meta.main) {
  const endpoint = Deno.env.get("RS_DAV_ENDPOINT");
  assert(endpoint, "Use the feature-owned interop wrapper");
  await nativeNameBoundaries(endpoint);
}
