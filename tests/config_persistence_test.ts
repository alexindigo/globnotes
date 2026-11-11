// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertThrows } from "@std/assert";
import { GlobalConfig, StoredConfigConflict } from "./helpers/config.ts";
import { bootServer } from "./helpers/boot.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { loadInstanceConfig } from "../server/config/loader.ts";
import { VaultConfigStore } from "../server/config/vault.ts";

/** The fixture deployment: vault and (by default) state under `root`. */
function deployment(root: string, statePath = `${root}/globnotes`) {
  return testEnvironment({
    GLOBNOTES_GLOBNOTES_PATH: `${root}/vault`,
    fixtureStatePath: statePath,
  });
}

for (const absolute of [false, true]) {
  Deno.test(`review repairs: R07 ${absolute ? "absolute" : "relative"} config file link retains identity and persists into real target`, async () => {
    const root = await Deno.makeTempDir({ prefix: "review-config-link-" });
    try {
      await Deno.mkdir(`${root}/vault`);
      await Deno.mkdir(`${root}/globnotes`);
      await Deno.mkdir(`${root}/deployment`);
      const target = `${root}/deployment/config.json`,
        link = `${root}/globnotes/config.json`;
      await Deno.writeTextFile(
        target,
        JSON.stringify({
          auth_type: "none",
          read_only_settings: false,
          brand_name: "original target",
          unknown: { keep: true },
        }),
      );
      const text = absolute ? target : "../deployment/config.json";
      await Deno.symlink(text, link);
      const before = Deno.lstatSync(link),
        config = new GlobalConfig(deployment(root));
      config.saveStoredConfig({
        ...config.storedConfig,
        brand_name: "persisted target consumer",
      });
      const after = Deno.lstatSync(link);
      console.log(
        JSON.stringify({
          absolute,
          linkRetained: after.isSymlink,
          actualTargetBrand:
            JSON.parse(await Deno.readTextFile(target)).brand_name,
          root,
        }),
      );
      assert(after.isSymlink);
      assertEquals(Deno.readLinkSync(link), text);
      assertEquals(after.ino, before.ino);
      assertEquals(
        JSON.parse(await Deno.readTextFile(target)).brand_name,
        "persisted target consumer",
      );
      assertEquals(
        new GlobalConfig(deployment(root)).storedConfig?.brand_name,
        "persisted target consumer",
      );
      assertEquals(JSON.parse(await Deno.readTextFile(target)).unknown, {
        keep: true,
      });
      assertEquals(
        [...Deno.readDirSync(`${root}/deployment`)].filter((entry) =>
          entry.name.startsWith(".config-")
        ).length,
        0,
      );
    } finally {
      console.log(JSON.stringify({ retainedConfigLinkFixture: root }));
    }
  });
}

async function persistenceFixture(
  run: (root: string, config: GlobalConfig) => Promise<void> | void,
) {
  const root = await Deno.makeTempDir({ prefix: "review-config-persistence-" });
  try {
    await Deno.mkdir(`${root}/vault`);
    await Deno.mkdir(`${root}/globnotes`);
    await Deno.mkdir(`${root}/deployment`);
    await run(root, new GlobalConfig(deployment(root)));
  } finally {
    console.log(JSON.stringify({ retainedConfigPersistenceFixture: root }));
  }
}
const deploymentConfig = {
  auth_type: "none",
  read_only_settings: false,
  unknown: { kept: true },
};

Deno.test("review repairs: R07 chained file and configured directory links update target and deployment recovery", async () => {
  await persistenceFixture((root) => {
    const target = `${root}/deployment/config.json`,
      file = `${root}/globnotes/config.json`,
      directory = `${root}/configured-state`;
    Deno.writeTextFileSync(target, JSON.stringify(deploymentConfig));
    Deno.symlinkSync(
      "../deployment/config.json",
      `${root}/globnotes/chain.json`,
    );
    Deno.symlinkSync("chain.json", file);
    Deno.symlinkSync("globnotes", directory);
    const env = deployment(root, directory);
    const links = [directory, file, `${root}/globnotes/chain.json`].map((
      location,
    ) => ({
      location,
      ino: Deno.lstatSync(location).ino,
      text: Deno.readLinkSync(location),
    }));
    const config = new GlobalConfig(env);
    config.saveStoredConfig({
      ...config.storedConfig,
      read_only_settings: true,
    });
    assertEquals(new GlobalConfig(env).settingsWritable, false);
    // Deployment recovery updates the same external target and is consumed on restart.
    Deno.writeTextFileSync(
      target,
      JSON.stringify({
        ...deploymentConfig,
        brand_name: "deployment recovery",
      }),
    );
    const recovered = new GlobalConfig(env);
    assertEquals(recovered.settingsWritable, true);
    assertEquals(recovered.storedConfig?.brand_name, "deployment recovery");
    for (const link of links) {
      assertEquals(Deno.lstatSync(link.location).ino, link.ino);
      assertEquals(Deno.readLinkSync(link.location), link.text);
    }
    console.log(
      JSON.stringify({
        chainedDirectoryLinkRecovery: true,
        settingsWritableAfterDeploymentRecovery: recovered.settingsWritable,
      }),
    );
  });
});

Deno.test("review repairs: R07 absent config parents and dangling file link preserve their distinct creation paths", async () => {
  await persistenceFixture((root) => {
    let env = deployment(root, `${root}/globnotes/first/run`);
    const first = new GlobalConfig(env), before = first.captureStoredConfig();
    first.saveStoredConfig(deploymentConfig, before);
    assertEquals(new GlobalConfig(env).storedConfig, deploymentConfig);
    env = deployment(root);
    const link = `${root}/globnotes/config.json`,
      target = `${root}/deployment/new.json`;
    Deno.symlinkSync("../deployment/new.json", link);
    const ino = Deno.lstatSync(link).ino, dangling = new GlobalConfig(env);
    dangling.saveStoredConfig(deploymentConfig, dangling.captureStoredConfig());
    assertEquals(Deno.lstatSync(link).ino, ino);
    assert(Deno.lstatSync(link).isSymlink);
    assertEquals(JSON.parse(Deno.readTextFileSync(target)), deploymentConfig);
    assertEquals(new GlobalConfig(env).storedConfig, deploymentConfig);
  });
});

for (
  const change of [
    "retarget",
    "replace-file",
    "replace-directory",
    "retarget-during-temporary",
  ]
) {
  Deno.test(`review repairs: R07 ${change} conflicts even with unchanged bytes and retains memory`, async () => {
    await persistenceFixture((root) => {
      const target = `${root}/deployment/config.json`,
        other = `${root}/deployment/other.json`,
        link = `${root}/globnotes/config.json`;
      const bytes = JSON.stringify(deploymentConfig);
      Deno.writeTextFileSync(target, bytes);
      Deno.writeTextFileSync(other, bytes);
      Deno.symlinkSync(target, link);
      const config = new GlobalConfig(deployment(root)),
        before = config.captureStoredConfig();
      const retarget = () => {
        Deno.removeSync(link);
        Deno.symlinkSync(other, link);
      };
      const write = Deno.writeTextFileSync;
      try {
        if (change === "retarget") retarget();
        if (change === "replace-file") {
          Deno.writeTextFileSync(`${root}/deployment/replacement.json`, bytes);
          Deno.renameSync(`${root}/deployment/replacement.json`, target);
        }
        if (change === "replace-directory") {
          Deno.renameSync(`${root}/deployment`, `${root}/old-deployment`);
          Deno.mkdirSync(`${root}/deployment`);
          Deno.writeTextFileSync(target, bytes);
          Deno.writeTextFileSync(other, bytes);
        }
        if (change === "retarget-during-temporary") {
          Deno.writeTextFileSync = ((location, data, options) => {
            write(location, data, options);
            if (String(location).includes("/.config-")) retarget();
          }) as typeof Deno.writeTextFileSync;
        }
        assertThrows(
          () =>
            config.saveStoredConfig({
              ...deploymentConfig,
              brand_name: "must not persist",
            }, before),
          StoredConfigConflict,
        );
        assertEquals(config.storedConfig, deploymentConfig);
        assertEquals(Deno.readTextFileSync(target), bytes);
        assertEquals(Deno.readTextFileSync(other), bytes);
        assertEquals(
          [...Deno.readDirSync(`${root}/deployment`)].filter((entry) =>
            entry.name.startsWith(".config-")
          ).length,
          0,
        );
      } finally {
        Deno.writeTextFileSync = write;
      }
      console.log(
        JSON.stringify({
          change,
          exactTargetBytesRetained: true,
          memoryRetained: true,
          temporaryResidue: 0,
        }),
      );
    });
  });
}

Deno.test("review repairs: R07 denied target write cannot borrow writable link directory and preserves target mode", async () => {
  await persistenceFixture((root) => {
    const target = `${root}/deployment/config.json`,
      link = `${root}/globnotes/config.json`,
      bytes = JSON.stringify(deploymentConfig);
    Deno.writeTextFileSync(target, bytes);
    Deno.symlinkSync(target, link);
    Deno.chmodSync(target, 0o444);
    const config = new GlobalConfig(deployment(root)),
      ino = Deno.lstatSync(link).ino;
    assertThrows(
      () =>
        config.saveStoredConfig({ ...deploymentConfig, brand_name: "denied" }),
      Deno.errors.PermissionDenied,
    );
    assertEquals(Deno.readTextFileSync(target), bytes);
    assertEquals(config.storedConfig, deploymentConfig);
    assertEquals(Deno.lstatSync(link).ino, ino);
    Deno.chmodSync(target, 0o640);
    config.saveStoredConfig({ ...deploymentConfig, brand_name: "permitted" });
    assertEquals(Deno.statSync(target).mode! & 0o777, 0o640);
    assertEquals(
      new GlobalConfig(deployment(root)).storedConfig?.brand_name,
      "permitted",
    );
  });
});

Deno.test("review repairs: R07 cycles nonregular and dangling-directory targets fail without replacing deployment links", async (t) => {
  for (
    const kind of [
      "cycle",
      "directory",
      "dangling-directory",
      "absent-external-parent",
    ]
  ) {
    await t.step(kind, () =>
      persistenceFixture((root) => {
        let env = deployment(root);
        const link = `${root}/globnotes/config.json`;
        if (kind === "cycle") Deno.symlinkSync("config.json", link);
        if (kind === "directory") Deno.symlinkSync(`${root}/deployment`, link);
        if (kind === "absent-external-parent") {
          Deno.symlinkSync(`${root}/unowned-parent/config.json`, link);
        }
        if (kind === "dangling-directory") {
          Deno.symlinkSync(
            `${root}/unowned-parent`,
            `${root}/configured-state`,
          );
          env = deployment(root, `${root}/configured-state`);
        }
        const configured = kind === "dangling-directory"
          ? `${root}/configured-state`
          : link;
        const ino = Deno.lstatSync(configured).ino,
          // This matrix varies the JSON binding, not the independent TOML owner.
          config = new GlobalConfig({
            instance: loadInstanceConfig({ env: {}, overlayPath: null }).config,
            notesPath: `${root}/vault`,
            statePath: env.fixtureStatePath!,
            instancePath: `${root}/instance`,
            vault: new VaultConfigStore(
              "globnotes",
              `${root}/vault/.globnotes/config.toml`,
            ),
          });
        assertThrows(() => config.saveStoredConfig(deploymentConfig));
        assert(Deno.lstatSync(configured).isSymlink);
        assertEquals(Deno.lstatSync(configured).ino, ino);
        assertEquals(config.storedConfig, null);
        assertEquals(
          [...Deno.readDirSync(root)].some((entry) =>
            entry.name === "unowned-parent"
          ),
          false,
        );
      }));
  }
});

Deno.test("review repairs: R07 actual target rename failure retains bytes memory and link without residue", async () => {
  await persistenceFixture((root) => {
    const target = `${root}/deployment/config.json`,
      link = `${root}/globnotes/config.json`,
      bytes = JSON.stringify(deploymentConfig);
    Deno.writeTextFileSync(target, bytes);
    Deno.symlinkSync(target, link);
    const config = new GlobalConfig(deployment(root)),
      rename = Deno.renameSync,
      ino = Deno.lstatSync(link).ino;
    try {
      Deno.renameSync = ((from, to) => {
        if (String(to) === target) {
          throw new Deno.errors.PermissionDenied(
            "fixture target rename refused",
          );
        }
        rename(from, to);
      }) as typeof Deno.renameSync;
      assertThrows(
        () =>
          config.saveStoredConfig({
            ...deploymentConfig,
            brand_name: "not committed",
          }),
        Deno.errors.PermissionDenied,
      );
      assertEquals(config.storedConfig, deploymentConfig);
      assertEquals(Deno.readTextFileSync(target), bytes);
      assertEquals(Deno.lstatSync(link).ino, ino);
      assertEquals(
        [...Deno.readDirSync(`${root}/deployment`)].filter((entry) =>
          entry.name.startsWith(".config-")
        ).length,
        0,
      );
    } finally {
      Deno.renameSync = rename;
    }
  });
});

Deno.test("review repairs: R05 R07 real Access HTTP writes keep config link and restart and recovery consumers agree", async () => {
  await persistenceFixture(async (root) => {
    const target = `${root}/deployment/config.json`,
      link = `${root}/globnotes/config.json`;
    Deno.writeTextFileSync(target, JSON.stringify(deploymentConfig));
    Deno.symlinkSync("../deployment/config.json", link);
    const ino = Deno.lstatSync(link).ino;
    const env = {
      GLOBNOTES_GLOBNOTES_PATH: `${root}/vault`,
      GLOBNOTES_METADATA_PATH: root,
      GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE: "false",
    };
    let server = await bootServer(env, { cwd: root });
    const call = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${server.baseUrl}/_/api/${route}`, {
        method,
        ...(body === undefined ? {} : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      const view = (await call("access")).body,
        bytes = Deno.readTextFileSync(target);
      assertEquals(
        (await call("access", "PUT", {
          mode: ["none"],
          revision: view.revision,
          signature: view.signature,
        })).status,
        422,
      );
      assertEquals(Deno.readTextFileSync(target), bytes);
      const updateId = crypto.randomUUID();
      assertEquals(
        (await call("access", "PUT", {
          mode: "none",
          readOnlySettings: true,
          revision: view.revision,
          signature: view.signature,
          updateId,
        })).status,
        200,
      );
      const committed = JSON.parse(Deno.readTextFileSync(target));
      assertEquals(committed.access_update_id, updateId);
      assertEquals(committed.unknown, deploymentConfig.unknown);
      assertEquals(Deno.lstatSync(link).ino, ino);
      await server.close();
      server = await bootServer(env, { cwd: root });
      const restarted = (await call("access")).body;
      assertEquals(restarted.settingsWritable, false);
      assertEquals(restarted.lastUpdateId, updateId);
      assertEquals(
        (await call("access", "PUT", {
          mode: "none",
          readOnlySettings: false,
          revision: restarted.revision,
          signature: restarted.signature,
        })).status,
        403,
      );
      assertEquals(
        (await call("notes", "POST", {
          path: "Public-note",
          content: "public note remains writable",
        })).status,
        200,
      );
      assertEquals(
        Deno.readTextFileSync(`${root}/vault/Public-note.md`),
        "public note remains writable",
      );
      await server.close();
      Deno.writeTextFileSync(
        target,
        JSON.stringify({
          ...committed,
          read_only_settings: false,
          brand_name: "recovered deployment",
        }),
      );
      Deno.writeTextFileSync(
        `${root}/globnotes/config.toml`,
        '[brand]\nname="recovered deployment"\n',
      );
      server = await bootServer(env, { cwd: root });
      assertEquals((await call("access")).body.settingsWritable, true);
      assertEquals(
        (await call("config")).body.brand.name,
        "recovered deployment",
      );
      assertEquals(Deno.lstatSync(link).ino, ino);
      assertEquals(Deno.readLinkSync(link), "../deployment/config.json");
      console.log(
        JSON.stringify({
          linkedAccessPersistedReceipt: updateId,
          restartSettingsLocked: true,
          publicNoteConsumer: true,
          deploymentRecoverySettingsWritable: true,
          linkIdentityRetained: true,
        }),
      );
    } finally {
      await server.close();
    }
  });
});
