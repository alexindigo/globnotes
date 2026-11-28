// SPDX-License-Identifier: LGPL-3.0-only
/** Scoped defaults and deterministic password hashing for test accounts. */
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
import type { IdentityFixturePayload } from "./identity_fixture.ts";
import {
  PluginLifecycle,
  type PluginServiceEligibility,
} from "../../server/plugins/lifecycle.ts";
export * from "../../server/config.ts";
export { fixturePasswordHash } from "./fixture_password.ts";

/** Explicit background availability in fixtures that do not boot accounts. */
export function fixtureServiceEligibility(
  { operational = () => true, writable = operational }: Partial<
    PluginServiceEligibility
  > = {},
): PluginServiceEligibility {
  return { operational, writable };
}

export function fixtureLifecycle(
  config: ProductionConfig,
  eligibility = fixtureServiceEligibility(),
) {
  return new PluginLifecycle(config, eligibility);
}

// Default-only constructor adapters use the one documented test seam.
setConfigForTests({});
export class GlobalConfig extends ProductionConfig {
  /** Available to the prepared account fixture; never a production config field. */
  readonly fixtureIdentity?: IdentityFixturePayload | null;
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
    this.fixtureIdentity = input.fixtureIdentity;
  }
}
