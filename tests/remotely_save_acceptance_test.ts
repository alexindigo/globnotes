// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DriverWorker } from "../server/plugins/runtime.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { remotelySaveRemote } from "./helpers/remotely_save_remote.ts";
import { createCodec } from "../plugins/globnotes-remotely-save/crypto.js";
import { remotelySaveServerFixture } from "./helpers/remotely_save_fixture.ts";
import { walkSync } from "@std/fs";
import { hash } from "../plugins/globnotes-remotely-save/config.js";
import { MAX_PLAINTEXT } from "../plugins/globnotes-remotely-save/crypto.js";
import { done, pending, waitUntil } from "./helpers/wait.ts";

const source = new URL("../plugins/globnotes-remotely-save/", import.meta.url);
const password = "acceptance-only-password";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function settingsFor(
  backend: "s3" | "webdav",
  url: string,
  encryption: string,
) {
  return backend === "s3"
    ? {
      backend,
      encryption,
      s3Endpoint: url,
      s3Bucket: "bucket",
      s3Prefix: "prefix",
      s3PathStyle: true,
    }
    : { backend, encryption, webdavUrl: url + "/dav/", webdavBaseDir: "base" };
}

function mutations(remote: ReturnType<typeof remotelySaveRemote>) {
  return remote.requests.filter((request) =>
    ["PUT", "DELETE"].includes(request.method)
  );
}

Deno.test("remotely-save: two production instances keep distinct keys, independent locking and anonymous deletion metadata across restart", async () => {
  const a = remotelySaveRemote("s3"), b = remotelySaveRemote("webdav");
  const keyA = "instance-alpha-passphrase-canary",
    keyB = "instance-beta-passphrase-canary";
  const codecA = await createCodec("rclone-base64", keyA),
    codecB = await createCodec("openssl-base64", keyB);
  const deletedPath = "private-deleted-canary.md";
  a.set(
    await codecA.encryptName("a.md"),
    await codecA.encrypt(encoder.encode("alpha")),
  );
  b.set(
    await codecB.encryptName(deletedPath),
    await codecB.encrypt(encoder.encode("beta")),
  );
  const f = await remotelySaveServerFixture([
    new URL(a.url).host,
    new URL(b.url).host,
  ]);
  try {
    const first = await f.add(settingsFor("s3", a.url, "rclone-base64"), {
      s3_access_key: "access",
      s3_secret_key: "secret",
      encryption_password: keyA,
    }, "Alpha");
    const second = await f.add(settingsFor("webdav", b.url, "openssl-base64"), {
      encryption_password: keyB,
    }, "Beta");
    await f.sync(first);
    assertEquals((await f.one(first)).status, "active");
    assertEquals((await f.one(second)).status, "active");
    const countA = mutations(a).length;
    await f.key(first, "encryption_password");
    // OpenSSL native names must be resolved from the actual inventory, never regenerated.
    let selected: string | undefined;
    for (const name of b.objects.keys()) {
      if (await codecB.decryptName(name) === deletedPath) selected = name;
    }
    assert(selected);
    b.set(
      selected,
      await codecB.encrypt(encoder.encode("beta edit while alpha locked")),
    );
    await f.sync(second);
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/${deletedPath}`),
      "beta edit while alpha locked",
    );
    assertEquals((await f.one(first)).status, "locked");
    assertEquals(mutations(a).length, countA);
    await f.restart();
    assertEquals((await f.sync(first)).status, "locked");
    assertEquals((await f.sync(second)).status, "active");
    await f.key(first, "encryption_password", keyA);
    assertEquals((await f.one(first)).status, "active");
    const nativeA = await codecA.encryptName(deletedPath);
    assertEquals(
      decoder.decode(await codecA.decrypt(a.objects.get(nativeA)!.bytes)),
      "beta edit while alpha locked",
    );
    await f.configure(first, { enabled: false });
    await f.configure(second, { enabled: false });
    await f.call(
      `notes/private-deleted-canary?base_version=${
        (await f.call("notes/private-deleted-canary")).version
      }`,
      "DELETE",
    );
    await f.restart();
    assert(f.metadata("SELECT * FROM peer_files").length > 0);
    for (const entry of walkSync(f.statePath, { includeDirs: false })) {
      if (entry.name === "driver-secrets.sqlite") continue;
      const stored = decoder.decode(Deno.readFileSync(entry.path));
      for (const marker of [keyA, keyB, deletedPath]) {
        assert(
          !stored.includes(marker),
          `${marker} persisted in ${entry.path}`,
        );
      }
    }
    for (const marker of [keyA, keyB]) {
      assert(!f.packets.join("\n").includes(marker));
      assert(!f.logs().includes(marker));
    }
    await f.configure(first, { enabled: true });
    await f.configure(second, { enabled: true });
    assert(!a.objects.has(nativeA));
    assert(!b.objects.has(selected));
    await f.call(`drivers/${first}`, "DELETE", {
      revision: (await f.one(first)).revision,
    });
    const secrets = decoder.decode(
      Deno.readFileSync(`${f.statePath}/driver-secrets.sqlite`),
    );
    assert(!secrets.includes(keyA));
    assert(secrets.includes(keyB));
  } finally {
    await f.close();
    codecA.close();
    codecB.close();
    await a.close();
    await b.close();
  }
});

for (const backend of ["s3", "webdav"] as const) {
  Deno.test(`remotely-save: hub ${backend} uncertain uploads settle by observation without replay and denied deletes recover`, async () => {
    const remote = remotelySaveRemote(backend),
      codec = await createCodec("openssl-base64", password);
    const f = await remotelySaveServerFixture([new URL(remote.url).host]);
    try {
      const id = await f.add(
        settingsFor(backend, remote.url, "openssl-base64"),
        {
          s3_access_key: "access",
          s3_secret_key: "secret",
          encryption_password: password,
        },
      );
      await f.configure(id, { enabled: false });
      await f.call("notes", "POST", {
        path: "uncertain",
        content: "committed upload bytes",
      });
      remote.fault((request, key) => {
        if (request.method !== "PUT") return;
        remote.set(key, remote.requests.at(-1)!.bytes);
        return new Response(null, { status: 500 });
      });
      await f.configure(id, { enabled: true });
      assertEquals(f.metadata("SELECT state FROM peer_files"), [{
        state: "uncertain",
      }]);
      assertEquals(remote.objects.size, 1);
      const native = [...remote.objects.keys()][0];
      assertEquals(
        decoder.decode(await codec.decrypt(remote.objects.get(native)!.bytes)),
        "committed upload bytes",
      );
      const count = mutations(remote).length;
      remote.fault(undefined);
      assertEquals((await f.sync(id)).status, "active");
      assertEquals(f.metadata("SELECT state FROM peer_files"), [{
        state: "synced",
      }]);
      assertEquals(mutations(remote).length, count);
      assertEquals((await f.call("conflicts")).total, 0);
      await f.configure(id, { enabled: false });
      await f.call(
        `notes/uncertain?base_version=${
          (await f.call("notes/uncertain")).version
        }`,
        "DELETE",
      );
      remote.fault((request) =>
        request.method === "DELETE"
          ? new Response(null, { status: 403 })
          : undefined
      );
      await f.configure(id, { enabled: true });
      assertEquals((await f.one(id)).status, "locked");
      assert(remote.objects.has(native));
      assertEquals([...walkSync(f.vault, { includeDirs: false })], []);
      remote.fault(undefined);
      assertEquals((await f.sync(id)).status, "active");
      assertEquals(remote.objects.size, 0);
      assertEquals(f.metadata("SELECT state FROM peer_files"), []);
    } finally {
      await f.close();
      codec.close();
      await remote.close();
    }
  });
}

for (const backend of ["s3", "webdav"] as const) {
  for (const encryption of ["none", "openssl-base64", "rclone-base64"]) {
    Deno.test(`remotely-save: hub/Worker ${backend}/${encryption} exact 16 MiB import/export and oversize visibility`, async () => {
      const remote = remotelySaveRemote(backend);
      const codec = await createCodec(encryption, password);
      const exact = new Uint8Array(MAX_PLAINTEXT).fill(65);
      const native = await codec.encryptName("exact.bin");
      const oversized = await codec.encryptName("oversize.bin");
      remote.set(native, await codec.encrypt(exact));
      remote.set(
        oversized,
        await codec.encrypt(new Uint8Array(MAX_PLAINTEXT + 1)),
      );
      const f = await remotelySaveServerFixture([new URL(remote.url).host]);
      try {
        const id = await f.add(settingsFor(backend, remote.url, encryption), {
          s3_access_key: "access",
          s3_secret_key: "secret",
          encryption_password: password,
        });
        assertEquals((await f.one(id)).status, "active");
        assertEquals(
          await hash(Deno.readFileSync(`${f.vault}/exact.bin`)),
          await hash(exact),
        );
        assertEquals(
          [...walkSync(f.vault, { includeDirs: false })].map((entry) =>
            entry.name
          ),
          ["exact.bin"],
        );
        assert(
          (await f.one(id)).attention.issues.some((
            issue: { path: string; code: string },
          ) => issue.path === "oversize.bin" && issue.code === "unsupported"),
        );
        assertEquals(mutations(remote), []);
        exact[0] = 66;
        const changedHash = await hash(exact);
        Deno.writeFileSync(`${f.vault}/exact.bin`, exact);
        await waitUntil(
          () =>
            f.metadata("SELECT hash FROM files WHERE disk_path='exact.bin'")[0]
                ?.hash === changedHash
              ? done()
              : pending("scanner has not admitted binary edit"),
          { label: "exact-limit file edit enters hub" },
        );
        await f.sync(id);
        assertEquals(
          await hash(await codec.decrypt(remote.objects.get(native)!.bytes)),
          changedHash,
        );
        assertEquals(
          mutations(remote).filter((request) => request.method === "PUT")
            .length,
          1,
        );
        assert(remote.objects.has(oversized));
      } finally {
        await f.close();
        codec.close();
        await remote.close();
      }
    });

    Deno.test(`remotely-save: hub/disk ${backend}/${encryption} imports, editor export, collisions, restart and five-cycle no-echo`, async () => {
      const remote = remotelySaveRemote(backend);
      const codec = await createCodec(encryption, password);
      const native = await codec.encryptName("folder/Imported.md");
      const metadata = await codec.encryptName(
        "_remotely-save-metadata-on-remote.json",
      );
      remote.set(native, await codec.encrypt(encoder.encode("remote first")));
      remote.set(metadata, "legacy bytes must survive even when not parseable");
      const f = await remotelySaveServerFixture([new URL(remote.url).host]);
      try {
        const id = await f.add(settingsFor(backend, remote.url, encryption), {
          s3_access_key: "acceptance-access",
          s3_secret_key: "acceptance-secret-canary",
          encryption_password: password,
        });
        assertEquals((await f.one(id)).status, "active");
        assertEquals(
          Deno.readTextFileSync(`${f.vault}/folder/Imported.md`),
          "remote first",
        );
        assertEquals(
          (await f.call("notes/folder/Imported")).content,
          "remote first",
        );
        assertEquals(mutations(remote), []);
        assertEquals(f.metadata("SELECT state FROM peer_files"), [{
          state: "synced",
        }]);

        await f.call("notes/folder/Imported", "PATCH", {
          baseContent: "remote first",
          newContent: "editor changed the document",
        });
        await f.sync(id);
        assertEquals(
          decoder.decode(
            await codec.decrypt(remote.objects.get(native)!.bytes),
          ),
          "editor changed the document",
        );
        // Disable at the owning scheduling boundary so both edits are admitted
        // from the same base, without racing a background export.
        await f.configure(id, { enabled: false });
        await f.call("notes/folder/Imported", "PATCH", {
          baseContent: "editor changed the document",
          newContent: "hub collision body",
        });
        remote.set(
          native,
          await codec.encrypt(encoder.encode("remote collision body")),
        );
        await f.configure(id, { enabled: true });
        await f.sync(id);
        const conflicts = await f.call("conflicts");
        assertEquals(conflicts.total, 1);
        const conflict = conflicts.conflicts[0];
        assertEquals(conflict.peer, id);
        assertEquals(conflict.reason, "stale-base");
        assertEquals(
          Deno.readTextFileSync(`${f.vault}/${conflict.copyPath}`),
          "remote collision body",
        );
        assertEquals(
          Deno.readTextFileSync(`${f.vault}/folder/Imported.md`),
          "hub collision body",
        );
        const equalTree = async () => {
          const decoded = new Map<string, Uint8Array>();
          for (const [name, object] of remote.objects) {
            if (name === metadata) continue;
            decoded.set(
              await codec.decryptName(name),
              await codec.decrypt(object.bytes),
            );
          }
          const disk = new Map(
            [...walkSync(f.vault, { includeDirs: false })].map((
              entry,
            ) => [
              entry.path.slice(f.vault.length + 1),
              Deno.readFileSync(entry.path),
            ]),
          );
          assertEquals(decoded, disk);
          assertEquals(
            decoder.decode(remote.objects.get(metadata)!.bytes),
            "legacy bytes must survive even when not parseable",
          );
        };
        await equalTree();
        const rows = f.metadata("SELECT * FROM peer_files"),
          sequence = f.metadata("SELECT MAX(seq) AS seq FROM changes");
        const count = mutations(remote).length;
        await f.restart();
        for (let cycle = 0; cycle < 5; cycle++) {
          assertEquals((await f.sync(id)).status, "active");
        }
        await equalTree();
        assertEquals(f.metadata("SELECT * FROM peer_files"), rows);
        assertEquals(
          f.metadata("SELECT MAX(seq) AS seq FROM changes"),
          sequence,
        );
        assertEquals(mutations(remote).length, count);
        assertEquals((await f.call("conflicts")).total, 1);
        for (const key of ["acceptance-secret-canary", password]) {
          assert(!f.packets.join("\n").includes(key));
          assert(!f.logs().includes(key));
          assert(
            !decoder.decode(Deno.readFileSync(`${f.statePath}/hub.sqlite`))
              .includes(key),
          );
        }
      } finally {
        await f.close();
        codec.close();
        await remote.close();
      }
    });
  }

  Deno.test(`remotely-save: hub ${backend} key clear/restart, corruption, incomplete scan, empty review and deleted-here recovery`, async () => {
    const remote = remotelySaveRemote(backend);
    const codec = await createCodec("rclone-base64", password);
    const names = new Map<string, string>();
    for (const path of ["one.md", "folder/two.md", "three.md"]) {
      const native = await codec.encryptName(path);
      names.set(path, native);
      remote.set(native, await codec.encrypt(encoder.encode(path)));
    }
    const f = await remotelySaveServerFixture([new URL(remote.url).host]);
    try {
      const id = await f.add(
        settingsFor(backend, remote.url, "rclone-base64"),
        {
          s3_access_key: "access",
          s3_secret_key: "secret",
          encryption_password: password,
        },
      );
      const rows = f.metadata("SELECT * FROM peer_files"),
        count = mutations(remote).length;
      const disk = () =>
        [...walkSync(f.vault, { includeDirs: false })].map((
          entry,
        ) => [entry.path, Deno.readFileSync(entry.path)]);
      const before = disk();
      await f.key(id, "encryption_password");
      assertEquals((await f.one(id)).status, "locked");
      await f.restart();
      assertEquals((await f.sync(id)).status, "locked");
      assertEquals(disk(), before);
      assertEquals(f.metadata("SELECT * FROM peer_files"), rows);
      assertEquals(mutations(remote).length, count);
      await f.key(id, "encryption_password", "wrong-instance-password");
      assertEquals((await f.one(id)).status, "locked");
      assertEquals(disk(), before);
      assertEquals(f.metadata("SELECT * FROM peer_files"), rows);
      await f.key(id, "encryption_password", password);
      assertEquals((await f.one(id)).status, "active");

      const saved = remote.objects.get(names.get("three.md")!)!.bytes;
      remote.objects.delete(names.get("one.md")!);
      remote.set(names.get("three.md")!, "broken encryption body");
      assertEquals((await f.sync(id)).status, "locked");
      assertEquals(disk(), before);
      assertEquals(f.metadata("SELECT * FROM peer_files"), rows);
      assertEquals(mutations(remote).length, count);
      remote.set(names.get("three.md")!, saved);
      remote.fault((request, key) =>
        request.method === "PROPFIND" && key !== "" ||
          new URL(request.url).searchParams.has("continuation-token")
          ? new Response(null, { status: 500 })
          : undefined
      );
      // S3 needs a third entry to force its second page after one.md disappeared.
      const extra = await codec.encryptName("extra.md");
      remote.set(extra, await codec.encrypt(encoder.encode("extra")));
      assertEquals((await f.sync(id)).status, "failed");
      assertEquals(disk(), before);
      assertEquals(mutations(remote).length, count);
      remote.fault(undefined);
      assertEquals((await f.sync(id)).status, "active");
      assert(!Deno.statSync(`${f.vault}/folder/two.md`).isDirectory);
      assertEquals(
        [...walkSync(f.vault, { includeDirs: false })].some((entry) =>
          entry.name === "one.md"
        ),
        false,
      );

      remote.objects.clear();
      const emptyBefore = disk();
      assert((await f.sync(id)).attention.remoteEmpty);
      assertEquals(disk(), emptyBefore);
      await f.decide(id, "remote_empty_upload");
      assertEquals(remote.objects.size, 3);
      // A deletion remembered only by anonymous metadata must not resurrect after
      // restart when another client changes that still-present remote object.
      await f.configure(id, { enabled: false });
      await f.call(
        `notes/three?base_version=${(await f.call("notes/three")).version}`,
        "DELETE",
      );
      const remoteThree = [...remote.objects.keys()].find((name) =>
        name === names.get("three.md")
      )!;
      remote.set(
        remoteThree,
        await codec.encrypt(encoder.encode("returning offline edit")),
      );
      await f.restart();
      await f.configure(id, { enabled: true });
      const held = await f.one(id);
      assertEquals(
        held.attention.held.map((entry: { path: string }) => entry.path),
        ["three.md"],
      );
      assertEquals(
        [...walkSync(f.vault, { includeDirs: false })].some((entry) =>
          entry.name === "three.md"
        ),
        false,
      );
      await f.decide(id, "held_restore", ["three.md"]);
      assertEquals(
        Deno.readTextFileSync(`${f.vault}/three.md`),
        "returning offline edit",
      );
      remote.objects.clear();
      await f.sync(id);
      await f.decide(id, "remote_empty_delete");
      assertEquals([...walkSync(f.vault, { includeDirs: false })], []);
      assertEquals(remote.objects.size, 0);
    } finally {
      await f.close();
      codec.close();
      await remote.close();
    }
  });
}

for (const backend of ["s3", "webdav"] as const) {
  for (const encryption of ["none", "openssl-base64", "rclone-base64"]) {
    Deno.test(`remotely-save: real plugin Worker/SDK ${backend}/${encryption} reads, exports and rebuilds encoded lookup`, async () => {
      const fixture = await pluginFixture();
      const remote = await remotelySaveRemote(backend);
      const codec = await createCodec(encryption, password);
      const files: Record<string, string> = {};
      for (const entry of Deno.readDirSync(source)) {
        if (entry.isFile && entry.name.endsWith(".js")) {
          files[entry.name] = await Deno.readTextFile(
            new URL(entry.name, source),
          );
        }
      }
      const declaration = JSON.parse(
        await Deno.readTextFile(new URL("manifest.json", source)),
      );
      const dir = await fixture.install(declaration.id, declaration, files);
      const manifest = readManifest(dir);
      const settings = backend === "s3"
        ? {
          backend,
          encryption,
          s3Endpoint: remote.url,
          s3Bucket: "bucket",
          s3Prefix: "prefix",
          s3PathStyle: true,
        }
        : {
          backend,
          encryption,
          webdavUrl: remote.url + "/dav/",
          webdavBaseDir: "base",
        };
      const keys: Record<string, string> = {
        s3_access_key: "access",
        s3_secret_key: "secret",
        encryption_password: password,
      };
      const make = () =>
        new DriverWorker(
          manifest,
          { id: "real-plugin", label: "Real plugin", settings },
          fixture.vault,
          {
            current: () => true,
            secret: (key) => keys[key] ?? null,
            hint() {},
            effective: {
              network: [{ type: "host", authority: new URL(remote.url).host }],
              imports: [],
            },
          },
        );
      let worker = make();
      const native = await codec.encryptName("folder/Imported.md");
      remote.set(native, await codec.encrypt(encoder.encode("remote bytes")));
      try {
        await worker.start();
        assertEquals((await worker.open()).state, "ready");
        const discover = async () => {
          const entries = [];
          let cursor;
          do {
            const page = await worker.discover({
              mode: "snapshot",
              ...(cursor ? { cursor } : {}),
            });
            assert(page.completion !== "incomplete", JSON.stringify(page));
            entries.push(...page.entries);
            cursor = page.cursor;
            assertEquals(page.completion === "more", cursor !== undefined);
          } while (cursor);
          return entries;
        };
        const entries = await discover();
        assertEquals(entries.length, 1);
        const entry = entries[0];
        assert(entry.state === "known");
        const read = await worker.read({
          path: entry.path,
          revision: entry.revision,
        });
        assert(read.state === "known");
        assertEquals(new TextDecoder().decode(read.bytes), "remote bytes");
        const [put] = await worker.apply([{
          id: "put",
          op: "put",
          path: entry.path,
          batch: 1,
          bytes: encoder.encode("editor bytes"),
          base: { revision: entry.revision },
        }]);
        assertEquals(put.state, "settled");
        assertEquals(
          new TextDecoder().decode(
            await codec.decrypt(remote.objects.get(native)!.bytes),
          ),
          "editor bytes",
        );
        assertEquals(remote.objects.size, 1);
        await worker.close();
        worker = make();
        await worker.start();
        await worker.open();
        const restart = await discover();
        const observed = restart[0];
        assert(observed.state === "known");
        const [deleted] = await worker.apply([{
          id: "delete",
          op: "delete",
          path: observed.path,
          batch: 2,
          base: { revision: observed.revision },
        }]);
        assertEquals(deleted.state, "settled");
        assertEquals(remote.objects.size, 0);
        assertEquals([...Deno.readDirSync(fixture.vault)], []);
      } finally {
        await worker.close();
        codec.close();
        await remote.close();
        await fixture.dispose();
      }
    });
  }
}

Deno.test("remotely-save: production plugin's needed optional keys lock in open before endpoint requests", async () => {
  const fixture = await pluginFixture();
  const remote = await remotelySaveRemote("s3");
  let worker: DriverWorker | undefined;
  try {
    const files: Record<string, string> = {};
    for (const entry of Deno.readDirSync(source)) {
      if (entry.isFile && entry.name.endsWith(".js")) {
        files[entry.name] = await Deno.readTextFile(
          new URL(entry.name, source),
        );
      }
    }
    const declaration = JSON.parse(
      await Deno.readTextFile(new URL("manifest.json", source)),
    );
    const dir = await fixture.install(declaration.id, declaration, files);
    worker = new DriverWorker(
      readManifest(dir),
      {
        id: "locked",
        label: "Locked",
        settings: {
          s3Endpoint: remote.url,
          s3Bucket: "bucket",
          s3PathStyle: true,
        },
      },
      fixture.vault,
      { current: () => true, secret: () => null, hint() {} },
    );
    await worker.start();
    assertEquals(await worker.open(), {
      state: "locked",
      reason: "needs S3 access key",
    });
    assertEquals(remote.requests, []);
  } finally {
    await worker?.close();
    await remote.close();
    await fixture.dispose();
  }
});
