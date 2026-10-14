// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { PluginHost } from "../server/plugins/host.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { servicePluginRpc } from "../server/plugins/rpc.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { AuxiliaryFilesystem } from "../server/plugins/auxiliary_fs.ts";
import { PluginDataStore } from "../server/plugins/data.ts";
import {
  effectiveSourceKey,
  installedSettingsFingerprint,
} from "../server/plugins/settings_environment.ts";
import { assertFsCode, auxiliaryFixture } from "./helpers/auxiliary_fixture.ts";
import type { FsStat } from "../server/plugins/contracts.ts";

Deno.test("backup FS: actual service Worker can await auxiliary publication", async () => {
  const fixture = await pluginFixture();
  const dir = await fixture.install("auxiliary", {
    runtime: { server: "service.js" },
    capabilities: {
      read: ["vault"],
      write: [],
      filesystem: { read: ["vault"], write: ["vault"] },
      network: false,
      imports: false,
    },
  }, {
    "service.js":
      `export function activate(ctx){ctx.commands.register({id:'publish',label:'Publish auxiliary bytes',target:'server'},async()=>{
      if(!ctx.fs)return {supported:false};
      await ctx.fs.writeFile('auxiliary.bin',new Uint8Array([0,128,255]),{expect:{kind:'absent'}});
      return {supported:true,bytes:[...await ctx.fs.readFile('auxiliary.bin')]};
    });}`,
  });
  const manifest = readManifest(dir);
  const fingerprint = installedSettingsFingerprint(dir),
    key = effectiveSourceKey(manifest.id, fingerprint, 0);
  const store = new PluginDataStore(fixture.statePath, {
    commit: (effect) => effect(),
    settingsContext: () => ({
      codeFingerprint: fingerprint,
      key: (revision) => effectiveSourceKey(manifest.id, fingerprint, revision),
      assertCurrent() {
        assertEquals(installedSettingsFingerprint(dir), fingerprint);
      },
    }),
  });
  const filesystem = new AuxiliaryFilesystem({
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    operational: () => true,
    writable: () => true,
    settings: (manifest) =>
      store.forPlugin(manifest.id).settingsLease(manifest.settings),
    commit: async (effect) => await effect(),
  });
  const rpc = servicePluginRpc({
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    actions: () => null,
    filesystem,
  });
  const host = new PluginHost(
    manifest,
    fixture.vault,
    (method, args, authority) => rpc(manifest, method, args, authority!),
    1,
    {
      role: "service",
      source: {
        key,
        codeFingerprint: fingerprint,
        settingsRevision: 0,
        revision: 0,
      },
    },
  );
  try {
    await host.start();
    const handler = [...host.registrations].find(([, value]) =>
      value.id === "publish"
    )![0];
    const consumer = await host.invoke(handler, []);
    assertEquals(
      consumer,
      { supported: true, bytes: [0, 128, 255] },
      "completion filesystem consumer must read published bytes before returning",
    );
    assertEquals([...await Deno.readFile(`${fixture.vault}/auxiliary.bin`)], [
      0,
      128,
      255,
    ]);
  } finally {
    host.stop();
    console.log(JSON.stringify({ retainedAuxiliaryFixture: fixture.root }));
  }
});

Deno.test("backup FS: conditional bytes, collisions, file-only removal and live-note denial", async () => {
  const b = await auxiliaryFixture();
  try {
    assertEquals(await b.call("stat", "absent"), { value: null });
    await assertFsCode(b.call("readFile", "absent"), "fs_not_found");
    await assertFsCode(b.call("stat", b.statePath), "fs_denied");
    const published = await b.call(
      "writeFile",
      "aux",
      new Uint8Array([0, 255]),
      { expect: { kind: "absent" } },
    );
    assert(published.value);
    const stat = (await b.call("stat", "aux")).value as FsStat;
    assertEquals(
      await b.call("readFile", "aux", {
        expect: { kind: "exact", token: stat.token },
      }),
      { value: new Uint8Array([0, 255]) },
    );
    await assertFsCode(
      b.call("writeFile", "aux", new Uint8Array([1]), {
        expect: { kind: "absent" },
      }),
      "fs_conflict",
    );
    await Deno.writeTextFile(`${b.vault}/alien`, "alien");
    await assertFsCode(
      b.call("rename", "aux", "alien", {
        sourceToken: stat.token,
        destination: { kind: "absent" },
      }),
      "fs_conflict",
    );
    assertEquals(await Deno.readTextFile(`${b.vault}/alien`), "alien");
    await b.call("mkdir", "directory", { expect: { kind: "absent" } });
    const directory = (await b.call("stat", "directory")).value as FsStat;
    await assertFsCode(
      b.call("remove", "directory", { token: directory.token }),
      "fs_denied",
    );
    await assertFsCode(
      b.call("remove", "absent", { token: stat.token }),
      "fs_conflict",
    );
    await assertFsCode(
      b.call("writeFile", "Live.md", new Uint8Array([1]), {
        expect: { kind: "absent" },
      }),
      "fs_denied",
    );
    await assertFsCode(
      b.call("rename", "aux", "Live.md", {
        sourceToken: stat.token,
        destination: { kind: "absent" },
      }),
      "fs_denied",
    );
    await b.call("remove", "aux", { token: stat.token });
    assertEquals(await b.call("stat", "aux"), { value: null });
  } finally {
    await b.close();
  }
});

Deno.test("backup canonical root: authorized aliases, exact observations and undisclosed denied roots", async () => {
  const b = await auxiliaryFixture({ stateInVault: true });
  try {
    await Deno.symlink(b.vault, `${b.vault}/alias`);
    const observed = (await b.call("stat", "alias")).value as FsStat;
    assertEquals(
      await b.call("realPath", "alias", {
        expect: { kind: "exact", token: observed.token },
      }),
      { value: b.vault },
    );
    assertEquals(await b.call("realPath", "."), { value: b.vault });
    await assertFsCode(b.call("realPath", "absent"), "fs_not_found");
    await assertFsCode(b.call("realPath", b.root), "fs_denied");
    await assertFsCode(b.call("realPath", b.statePath), "fs_denied");
    await Deno.remove(`${b.vault}/alias`);
    await Deno.symlink(b.statePath, `${b.vault}/alias`);
    await assertFsCode(
      b.call("realPath", "alias", {
        expect: { kind: "exact", token: observed.token },
      }),
      "fs_denied",
    );
    await assertFsCode(b.call("stat", "x".repeat(4097)), "fs_invalid_path");
  } finally {
    await b.close();
  }
});

Deno.test("backup FS: post-hook completion has no self-release deadlock; pre-hook mutations denied", async () => {
  const b = await auxiliaryFixture();
  try {
    b.runtime.post("on-save", {});
    assertEquals(await b.last(), "post-completed");
    assertEquals(
      await Deno.readFile(`${b.vault}/post.bin`),
      new Uint8Array([7]),
    );
    await b.runtime.guard("pre-save", {});
    assertEquals(await b.last(), { code: "fs_denied", root: b.vault });
    assertEquals(await b.call("stat", "pre"), { value: null });
  } finally {
    await b.close();
  }
});

for (const mode of ["source", "generation", "deadline"] as const) {
  Deno.test(`backup canonical root: held observation rejects ${mode} without stale disclosure`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let hold = false;
    const b = await auxiliaryFixture({
      prepare: async () => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const now = Date.now;
    let pending: Promise<unknown> | undefined;
    try {
      hold = true;
      pending = b.call("realPath", ".");
      const settled = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await entered.promise;
      if (mode === "source") {
        await b.data.forPlugin(b.id).savePage(
          b.page,
          { base: "", count: 3 },
          0,
        );
      }
      if (mode === "generation") await b.runtime.retireOwner(b.id, false, true);
      if (mode === "deadline") Date.now = () => now() + 11_000;
      release.resolve();
      const result = await settled;
      if (mode === "generation") assert("error" in result);
      else {assertEquals(
          (result as { value: { error: { code: string; effect: string } } })
            .value.error,
          {
            code: mode === "source" ? "fs_source_changed" : "fs_deadline",
            effect: "none",
          },
        );}
    } finally {
      release.resolve();
      Date.now = now;
      if (pending) await pending.catch(() => undefined);
      await b.close();
    }
  });
}

Deno.test("backup FS review: fresh settings cannot lend old executing code replacement grants", async () => {
  const b = await auxiliaryFixture();
  try {
    const file = `${b.dir}/manifest.json`,
      manifest = JSON.parse(await Deno.readTextFile(file));
    manifest.capabilities.filesystem.write = [];
    await Deno.writeTextFile(file, JSON.stringify(manifest));
    const current = await b.settings();
    await assertFsCode(
      b.call("writeFile", "obsolete-grant", new Uint8Array([1]), {
        sourceKey: current.sourceKey,
        expect: { kind: "absent" },
      }),
      "fs_source_changed",
    );
    await assertRejects(
      () => Deno.stat(`${b.vault}/obsolete-grant`),
      Deno.errors.NotFound,
    );
  } finally {
    await b.close();
  }
});

Deno.test("backup FS review: exact realPath validates the observation after held preparation", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let hold = false;
  const b = await auxiliaryFixture({
    prepare: async () => {
      if (hold) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  let pending: Promise<unknown> | undefined;
  try {
    await Deno.writeTextFile(`${b.vault}/held`, "A");
    const stat = (await b.call("stat", "held")).value as FsStat;
    hold = true;
    pending = b.call("realPath", "held", {
      expect: { kind: "exact", token: stat.token },
    });
    await entered.promise;
    await Deno.writeTextFile(`${b.vault}/held`, "B");
    release.resolve();
    assertEquals((await pending as { error: unknown }).error, {
      code: "fs_conflict",
      effect: "none",
    });
  } finally {
    release.resolve();
    if (pending) await pending.catch(() => undefined);
    await b.close();
  }
});

Deno.test("backup FS review: oversized read rejects before token content allocation or hashing", async () => {
  const b = await auxiliaryFixture(), original = Deno.openSync;
  const file = `${b.vault}/large`;
  let opened = 0;
  try {
    await Deno.writeFile(file, new Uint8Array(16 * 1024 * 1024 + 1));
    Deno.openSync = (...args: Parameters<typeof Deno.openSync>) => {
      if (String(args[0]) === file) opened++;
      return original(...args);
    };
    await assertFsCode(b.call("readFile", "large"), "fs_too_large");
    assertEquals(opened, 0, "body bound must precede content preparation");
  } finally {
    Deno.openSync = original;
    await b.close();
  }
});

Deno.test("backup FS review: SDK captures bounded selected bytes before shared-buffer mutation or transport allocation", async () => {
  const lengths: number[] = [];
  const b = await auxiliaryFixture({
    observe: (method, args) => {
      if (method === "fs.writeFile") {
        lengths.push((args[1] as Uint8Array).buffer.byteLength);
      }
    },
  });
  try {
    assertEquals(await b.call("capture", false), { value: [7] });
    assertEquals(await b.call("capture", true), { value: [7] });
    assertEquals(
      lengths,
      [1, 1],
      "selected byte buffers, not the large backing storage, cross RPC",
    );
  } finally {
    await b.close();
  }
});

Deno.test("backup FS: setup and read-only policy reject with typed no-effect errors while authorized reads survive read-only", async () => {
  const b = await auxiliaryFixture();
  try {
    b.writable(false);
    await assertFsCode(b.call("mkdir", "denied"), "fs_denied");
    assertEquals(await b.call("realPath", "."), { value: b.vault });
    b.operational(false);
    await assertFsCode(b.call("stat", "."), "fs_denied");
  } finally {
    b.operational(true);
    await b.close();
  }
});

Deno.test("backup FS: exactly64 outstanding consumers remain admitted and excess is explicit busy", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let holding = false, observed = 0;
  const b = await auxiliaryFixture({
    prepare: async () => {
      if (holding) {
        entered.resolve();
        await release.promise;
      }
    },
    observe: (method) => {
      if (holding && method === "fs.stat") observed++;
    },
  });
  let pending: Promise<unknown> | undefined;
  try {
    holding = true;
    pending = b.call("capacity");
    await entered.promise;
    release.resolve();
    assertEquals(await pending, { value: { completed: 64, busy: 1 } });
    assertEquals(
      observed,
      64,
      "SDK rejects capacity overflow before transport",
    );
  } finally {
    release.resolve();
    if (pending) await pending.catch(() => undefined);
    await b.close();
  }
});

Deno.test("backup FS review: temporary substitution before reopening cannot write a live note", async () => {
  const b = await auxiliaryFixture(), original = Deno.open;
  const victim = `${b.vault}/Victim.md`;
  let injected = false;
  try {
    await Deno.writeTextFile(victim, "protected note");
    Deno.open = async (...args: Parameters<typeof Deno.open>) => {
      const file = String(args[0]);
      if (
        !injected && file.includes("/.auxiliary-") && args[1]?.write &&
        !args[1]?.createNew
      ) {
        injected = true;
        await Deno.remove(file);
        await Deno.symlink(victim, file);
      }
      return await original(...args);
    };
    await b.call("writeFile", "safe.bin", new Uint8Array([65, 66, 67]), {
      expect: { kind: "absent" },
    });
    assertEquals(
      await Deno.readTextFile(victim),
      "protected note",
      "preparation has no pathname-following write opportunity",
    );
  } finally {
    Deno.open = original;
    await b.close();
  }
});

Deno.test("backup FS review: prepared temporary replacement cannot be published or deleted as owned", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let held = false;
  const b = await auxiliaryFixture({
    commit: async <T>(effect: () => T | Promise<T>) => {
      if (held) {
        entered.resolve();
        await release.promise;
      }
      return await effect();
    },
  });
  let pending: Promise<unknown> | undefined;
  try {
    held = true;
    pending = b.call("writeFile", "safe.bin", new Uint8Array([1, 2, 3]), {
      expect: { kind: "absent" },
    });
    await entered.promise;
    const name = [...Deno.readDirSync(b.vault)].find((entry) =>
        entry.name.startsWith(".auxiliary-")
      )!.name,
      file = `${b.vault}/${name}`;
    await Deno.remove(file);
    await Deno.writeTextFile(file, "alien replacement");
    release.resolve();
    assertEquals((await pending as { error: unknown }).error, {
      code: "fs_conflict",
      effect: "none",
    });
    await assertRejects(
      () =>
        Deno.stat(`${b.vault}/safe.bin`),
      Deno.errors.NotFound,
    );
    assertEquals(await Deno.readTextFile(file), "alien replacement");
  } finally {
    held = false;
    release.resolve();
    if (pending) await pending.catch(() => undefined);
    await b.close();
  }
});

Deno.test("backup canonical root: missing-component collapse and file trailing slash never manufacture an existing target", async () => {
  const b = await auxiliaryFixture();
  try {
    await Deno.writeTextFile(`${b.vault}/existing`, "bytes");
    await assertFsCode(b.call("realPath", "missing/.."), "fs_not_found");
    const collapsed = await b.call("stat", "missing/../existing");
    assert(collapsed.error || collapsed.value === null);
    const trailing = await b.call("realPath", "existing/");
    assert(trailing.error, "a trailing slash requires an existing directory");
    await assertFsCode(
      b.call("writeFile", "missing/../existing", new Uint8Array([1]), {
        expect: { kind: "absent" },
      }),
      "fs_not_found",
    );
    assertEquals(await Deno.readTextFile(`${b.vault}/existing`), "bytes");
  } finally {
    await b.close();
  }
});

Deno.test("backup canonical root: symlink-target directory traversal rejects files before disclosure or mutation", async () => {
  const b = await auxiliaryFixture();
  try {
    await Deno.writeTextFile(`${b.vault}/file.bin`, "literal bytes");
    const observed = (await b.call("stat", "file.bin")).value as FsStat;
    for (
      const [name, target] of [
        ["relative", "file.bin/"],
        ["absolute", `${b.vault}/file.bin/`],
        ["nested", "relative/"],
        ["dot", "file.bin/./"],
      ]
    ) {
      await Deno.symlink(target, `${b.vault}/${name}`);
      await assertRejects(() => Deno.realPath(`${b.vault}/${name}`));
      for (const method of ["stat", "realPath", "readFile", "mkdir"]) {
        const result = await b.call(method, name);
        assert(
          result.error,
          `${method}: link traversal cannot discard a directory requirement`,
        );
        assertEquals(result.error.effect, "none");
      }
      await assertFsCode(
        b.call("writeFile", name, new Uint8Array([1]), {
          expect: { kind: "absent" },
        }),
        "fs_denied",
      );
      await assertFsCode(
        b.call("remove", name, { token: observed.token }),
        "fs_denied",
      );
      await assertFsCode(
        b.call("rename", name, "moved.bin", {
          sourceToken: observed.token,
          destination: { kind: "absent" },
        }),
        "fs_denied",
      );
      await assertFsCode(
        b.call("rename", "file.bin", name, {
          sourceToken: observed.token,
          destination: { kind: "absent" },
        }),
        "fs_denied",
      );
      assertEquals(
        await Deno.readTextFile(`${b.vault}/file.bin`),
        "literal bytes",
      );
      await assertRejects(
        () => Deno.stat(`${b.vault}/moved.bin`),
        Deno.errors.NotFound,
      );
    }
  } finally {
    await b.close();
  }
});

Deno.test("backup canonical root: nested directory symlinks with trailing separators retain valid descendants", async () => {
  const b = await auxiliaryFixture();
  try {
    await Deno.mkdir(`${b.vault}/directory`);
    await Deno.symlink("directory/", `${b.vault}/relative`);
    await Deno.symlink(`${b.vault}/relative/`, `${b.vault}/nested`);
    for (const name of ["relative", "nested", "nested/./"]) {
      const observed = (await b.call("stat", name)).value as FsStat;
      assertEquals(observed.kind, "directory");
      assertEquals(
        await b.call("realPath", name, {
          expect: { kind: "exact", token: observed.token },
        }),
        { value: `${b.vault}/directory` },
      );
    }
    await b.call("writeFile", "nested/child.bin", new Uint8Array([7]), {
      expect: { kind: "absent" },
    });
    assertEquals(await b.call("readFile", "relative/child.bin"), {
      value: new Uint8Array([7]),
    });
    assertEquals(
      await Deno.readFile(`${b.vault}/directory/child.bin`),
      new Uint8Array([7]),
    );
  } finally {
    await b.close();
  }
});

Deno.test("backup canonical root: absent directory traversal never becomes committed file publication", async () => {
  const b = await auxiliaryFixture();
  try {
    await Deno.writeTextFile(`${b.vault}/source.bin`, "source bytes");
    const source = (await b.call("stat", "source.bin")).value as FsStat;
    for (
      const [name, target] of [
        ["relative-absent", "missing-relative/"],
        ["absolute-absent", `${b.vault}/missing-absolute/`],
        ["nested-absent", "relative-absent/"],
        ["dot-absent", "missing-dot/."],
      ]
    ) {
      await Deno.symlink(target, `${b.vault}/${name}`);
      const write = await b.call("writeFile", name, new Uint8Array([1]), {
        expect: { kind: "absent" },
      });
      assert(
        write.error,
        "a missing directory traversal cannot authorize a file",
      );
      assertEquals(
        write.error.effect,
        "none",
        "reject before publication, not after committing it",
      );
      const rename = await b.call("rename", "source.bin", name, {
        sourceToken: source.token,
        destination: { kind: "absent" },
      });
      assert(rename.error);
      assertEquals(rename.error.effect, "none");
      assertEquals(
        await Deno.readTextFile(`${b.vault}/source.bin`),
        "source bytes",
      );
    }
    const direct = await b.call(
      "writeFile",
      "missing-direct/.",
      new Uint8Array([1]),
      {
        expect: { kind: "absent" },
      },
    );
    assert(direct.error);
    assertEquals(direct.error.effect, "none");
    for (
      const name of [
        "missing-relative",
        "missing-absolute",
        "missing-dot",
        "missing-direct",
      ]
    ) {
      await assertRejects(
        () => Deno.stat(`${b.vault}/${name}`),
        Deno.errors.NotFound,
      );
    }
    const directory = (await b.call("mkdir", "nested-absent", {
      expect: { kind: "absent" },
    })).value as FsStat;
    assertEquals(directory.kind, "directory");
    assertEquals(
      await b.call("realPath", "nested-absent", {
        expect: { kind: "exact", token: directory.token },
      }),
      { value: `${b.vault}/missing-relative` },
    );
  } finally {
    await b.close();
  }
});
