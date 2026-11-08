// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DriverWorker } from "../server/plugins/runtime.ts";
import { driverFixture } from "./helpers/driver_fixture.ts";
import { workerCommandDenialProbeSource } from "./helpers/process.ts";
import {
  base64url,
  createCodec,
  MAX_PLAINTEXT,
  validPath,
} from "../plugins/globnotes-remotely-save/crypto.js";

const vectors = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/remotely-save/vectors.json", import.meta.url),
  ),
);
const from64 = (value: string) =>
  Uint8Array.from(atob(value), (point) => point.charCodeAt(0));
const digest = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");

Deno.test("remotely-save: source-generated OpenSSL, old base32 and rclone vectors are byte-exact in both directions", async () => {
  for (const mode of ["openssl-base64", "rclone-base64"]) {
    const codec = await createCodec(mode, vectors.password);
    const entropy = mode === "openssl-base64"
      ? Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])
      : new Uint8Array(vectors.nonce);
    try {
      for (const entry of vectors.names) {
        const native = mode === "openssl-base64"
          ? entry.openssl64
          : entry.rclone;
        assertEquals(await codec.decryptName(native), entry.path);
        assertEquals(await codec.encryptName(entry.path, entropy), native);
        assertEquals(
          codec.nameSize(entry.path),
          new TextEncoder().encode(native).length,
        );
        if (mode === "openssl-base64") {
          assertEquals(await codec.decryptName(entry.openssl32), entry.path);
        }
      }
      for (const entry of vectors.bodies) {
        const wire = from64(
          mode === "openssl-base64" ? entry.openssl : entry.rclone,
        );
        const plain = Uint8Array.from(
          { length: entry.length },
          (_, i) => i % 251,
        );
        assertEquals(
          await digest(await codec.decrypt(wire)),
          entry.plainSha256,
        );
        assertEquals(await codec.encrypt(plain, entropy), wire);
        const bound = codec.bounds(wire.length);
        assert(bound.min <= plain.length && bound.max >= plain.length);
      }
    } finally {
      codec.close();
    }
  }
});

Deno.test("remotely-save: invalid framing, wrong keys, noncanonical and unsafe names fail closed", async () => {
  for (const mode of ["openssl-base64", "rclone-base64"]) {
    const codec = await createCodec(mode, vectors.password);
    const wrong = await createCodec(mode, "wrong-password");
    try {
      const entry = vectors.names[0];
      const native = mode === "openssl-base64" ? entry.openssl64 : entry.rclone;
      await assertRejects(() => wrong.decryptName(native));
      for (const bad of ["", "!", native + "=", "../" + native]) {
        await assertRejects(() => codec.decryptName(bad));
      }
      for (
        const path of [
          "../escape.md",
          "a//b.md",
          "a/./b.md",
          "/root.md",
          "a\\b.md",
          "a\0.md",
          "a/\ud800.md",
        ]
      ) {
        // Lone surrogates are not losslessly representable in UTF-8.
        assertEquals(validPath(path), false, path);
        await assertRejects(() => codec.encryptName(path));
      }
      const wire = from64(
        mode === "openssl-base64"
          ? vectors.bodies[4].openssl
          : vectors.bodies[4].rclone,
      );
      await assertRejects(() => codec.decrypt(wire.slice(0, -1)));
      const damaged = wire.slice();
      damaged[0] ^= 1;
      await assertRejects(() => codec.decrypt(damaged));
      if (mode === "rclone-base64") {
        const corrupt = wire.slice();
        corrupt[corrupt.length - 1] ^= 1;
        await assertRejects(() => codec.decrypt(corrupt));
      } else {
        const invalidText = await codec.encrypt(new Uint8Array([255]));
        await assertRejects(() => codec.decryptName(base64url(invalidText)));
      }
      assertThrows(() => codec.bounds(-1));
      assertThrows(() => codec.bounds(31));
    } finally {
      codec.close();
      wrong.close();
    }
    await assertRejects(() => codec.encrypt(new Uint8Array()));
  }
});

Deno.test("remotely-save: plaintext refuses recognized encrypted inventory and body framing", async () => {
  const codec = await createCodec("none", "");
  assertEquals(
    await codec.decryptName("folder/Case-\u00e9.md"),
    "folder/Case-\u00e9.md",
  );
  for (const name of [vectors.names[0].openssl64, vectors.names[0].openssl32]) {
    await assertRejects(() => codec.decryptName(name));
  }
  for (const wire of [vectors.bodies[0].openssl, vectors.bodies[0].rclone]) {
    await assertRejects(() => codec.decrypt(from64(wire)));
  }
  const binary = new Uint8Array([0, 255, 1]);
  assertEquals(await codec.decrypt(binary), binary);
  codec.close();
});

Deno.test("remotely-save: plaintext size bounds include the exact 16 MiB edge without labeling wire bytes as plaintext", async () => {
  const plain = new Uint8Array(MAX_PLAINTEXT);
  for (const mode of ["none", "openssl-base64", "rclone-base64"]) {
    const codec = await createCodec(mode, vectors.password);
    try {
      const wire = await codec.encrypt(plain);
      const bound = codec.bounds(wire.length);
      assert(bound.min <= MAX_PLAINTEXT && bound.max >= MAX_PLAINTEXT);
      assertEquals((await codec.decrypt(wire)).length, MAX_PLAINTEXT);
      if (mode !== "none") assert(wire.length > MAX_PLAINTEXT);
      if (mode === "openssl-base64") {
        assertEquals(bound, { min: MAX_PLAINTEXT, max: MAX_PLAINTEXT + 15 });
      }
    } finally {
      codec.close();
    }
  }
});

Deno.test("remotely-save: published crypto and XML execute inside the restricted driver Worker", async () => {
  const modules = `/${crypto.randomUUID()}`;
  let requests = 0;
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      requests++;
      return new Response("export const forbidden = true", {
        headers: { "content-type": "application/javascript" },
      });
    },
  );
  const authority = `127.0.0.1:${receiver.addr.port}`;
  const fixture = await driverFixture(`
    import { Cipher } from "@fyears/rclone-crypt";
    import { XMLParser } from "fast-xml-parser";
    export function activate(ctx) {
      ctx.driver.serve({
        async open() {
          const probes = [
            () => Deno.env.get('REMOTELY_SAVE_SANDBOX_PROBE'),
            ${workerCommandDenialProbeSource},
            () => Deno.writeTextFile(ctx.instance.settings.probeFile, 'must not write'),
            () => import('http://${authority}${modules}/remotely-save-probe.js'),
          ];
          for (const [index, probe] of probes.entries()) {
            let denied = false;
            try { await probe(); } catch(error) {
              denied = error.name === 'NotCapable' || error.name === 'PermissionDenied';
              if (index === 3) denied = error instanceof TypeError && error.message.includes('Requires import access');
              if (!denied) throw error;
            }
            if (!denied) throw Error('sandbox probe was not denied');
          }
          const cipher = new Cipher('base64');
          await cipher.key('fixture-password', '');
          const path = 'folder/Unicode-\u00e9.md';
          if (await cipher.decryptFileName(await cipher.encryptFileName(path)) !== path) throw Error('name');
          const bytes = new Uint8Array(65537).map((_, i) => i % 251);
          const encrypted = await cipher.encryptData(bytes, new Uint8Array(24));
          const decoded = await cipher.decryptData(encrypted);
          if (decoded.length !== bytes.length || decoded.some((v,i) => v !== bytes[i])) throw Error('body');
          const xml = new XMLParser({ignoreAttributes:false, parseTagValue:false});
          if (xml.parse('<s3:Key xmlns:s3="urn:s3">0001 &amp; A</s3:Key>')['s3:Key']['#text'] !== '0001 & A') throw Error('XML');
          return {state:'ready', endpoint:{id:'restricted-dependencies',epoch:'1'},scope:'all'};
        },
        discover:()=>({endpoint:{id:'restricted-dependencies',epoch:'1'},scope:'all',mode:'snapshot',entries:[],completion:'complete'}),
        read:()=>({state:'absent'}),
        apply:items=>items.map(item=>({id:item.id,state:'unsupported',reason:'probe only'})),
        close(){},
      });
    }
  `);
  const worker = new DriverWorker(
    fixture.manifest,
    {
      id: "dependencies",
      label: "Dependencies",
      settings: { probeFile: `${fixture.vault}/must-not-write` },
    },
    fixture.vault,
    { current: () => true, secret: () => null, hint() {} },
  );
  try {
    await worker.start();
    assertEquals(await worker.open(), {
      state: "ready",
      endpoint: { id: "restricted-dependencies", epoch: "1" },
      scope: "all",
    });
    assertEquals(
      requests,
      0,
      "denied imports must not reach the HTTP receiver",
    );
  } finally {
    await worker.close();
    await fixture.dispose();
    await receiver.shutdown();
  }
});
