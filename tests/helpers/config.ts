// SPDX-License-Identifier: LGPL-3.0-only
/** Explicit private-record fixtures. No obsolete production env translation. */
import { pbkdf2Sync } from "node:crypto";
import { Buffer } from "node:buffer";
import { resolve } from "@std/path";
import {
  GlobalConfig as ProductionConfig,
  type ResolvedVaultSettings,
} from "../../server/config.ts";
import {
  loadInstanceConfig,
  setConfigForTests,
  vaultEnvironment,
} from "../../server/config/loader.ts";
import {
  instanceMetadataPath,
  vaultMetadataPath,
} from "../../server/config/paths.ts";
import { VaultConfigStore } from "../../server/config/vault.ts";
import { type FixtureEnvironment, testEnvironment } from "./environment.ts";
export * from "../../server/config.ts";

// Default-only constructor adapters use the one documented test seam.
setConfigForTests({});
const hashes = new Map<string, string>();
export function fixturePasswordHash(password: string): string {
  let hash = hashes.get(password);
  if (!hash) {
    const salt = "00112233445566778899aabbccddeeff";
    hash = `pbkdf2_sha256$100000$${salt}$${
      pbkdf2Sync(password, Buffer.from(salt, "hex"), 100000, 32, "sha256")
        .toString("hex")
    }`;
    hashes.set(password, hash);
  }
  return hash;
}
export class GlobalConfig extends ProductionConfig {
  constructor(
    input: FixtureEnvironment | ResolvedVaultSettings = testEnvironment(),
    explicit?: ResolvedVaultSettings,
  ) {
    if (explicit) {
      super(explicit);
      return;
    }
    if (!("get" in input)) {
      super(input);
      return;
    }
    const env = input.values;
    const notesPath = resolve(
      env.GLOBNOTES_GLOBNOTES_PATH ||
        resolve(
          env.GLOBNOTES__VAULTS_BASEPATH ||
            Deno.makeTempDirSync({ prefix: "globnotes-config-base-" }),
          "globnotes",
        ),
    );
    if (!env.GLOBNOTES_GLOBNOTES_PATH) {
      Deno.mkdirSync(notesPath, { recursive: true });
    }
    const loaded = loadInstanceConfig({
      env,
      overlayPath: env.GLOBNOTES_CONFIG ? undefined : null,
      vaults: {
        globnotes: {
          path: notesPath,
          ...(input.fixtureStatePath
            ? { overlayPath: `${input.fixtureStatePath}/config.toml` }
            : {}),
        },
      },
    });
    const instance = loaded.config;
    const statePath = input.fixtureStatePath ||
      vaultMetadataPath(notesPath, instance.metadata.path, "globnotes");
    if (input.fixtureAuth) {
      Deno.mkdirSync(statePath, { recursive: true });
      let saved = {};
      try {
        saved = JSON.parse(Deno.readTextFileSync(`${statePath}/config.json`));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      Deno.writeTextFileSync(
        `${statePath}/config.json`,
        JSON.stringify({ ...saved, ...input.fixtureAuth }),
      );
    }
    const vault = new VaultConfigStore(
      "globnotes",
      `${statePath}/config.toml`,
      { env: vaultEnvironment("globnotes", env) },
    );
    vault.prepareParents();
    super({
      instance,
      vault,
      notesPath,
      statePath,
      instancePath: instanceMetadataPath(
        instance.vaults.basepath,
        instance.metadata.path,
      ),
    });
  }
}
