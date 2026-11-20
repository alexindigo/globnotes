// SPDX-License-Identifier: LGPL-3.0-only

import * as path from "@std/path";
import { HttpError } from "@pathfinder/pathfinder";
import type { PluginLifecycle } from "../../server/plugins/lifecycle.ts";
import { OperationError } from "../../server/plugins/errors.ts";
import {
  createFixtureScope,
  type FixtureScope,
  fixtureScope,
  ownFixtureScope,
} from "./fixture_scope_engine.ts";

// Root custody can outlive one runtime only through an issued retained-evidence
// result. Rebinding never revives the old runtime's escaped capabilities.
interface RootBinding {
  readonly owner: FixtureScope;
  readonly scope: FixtureScope;
  readonly paths: Pick<
    ScopedPluginFixture,
    "root" | "vault" | "statePath" | "metadataBase"
  >;
}
const rootOwners = new WeakMap<object, RootBinding>();

function rootBinding(fixture: ScopedPluginFixture): RootBinding {
  const binding = rootOwners.get(fixture) ?? rootOwners.get(fixture.install);
  if (
    !binding ||
    Object.entries(binding.paths).some(([key, value]) =>
      Reflect.get(fixture, key) !== value
    )
  ) {
    throw new TypeError(
      "Plugin fixture has no matching issued root custody",
    );
  }
  return binding;
}

/** Task-owned plugins: no installed plugin, operator policy or real vault is edited. */
export async function pluginFixture(options: { stateInVault?: boolean } = {}) {
  const owner = createFixtureScope();
  return await owner.prepare(async (scope) =>
    compatibilityPluginFixture(
      await scopedPluginFixture(scope, options),
      () => owner.close(),
    )
  );
}

/** Internal construction port: root custody belongs to the enclosing scenario
 * before any directory preparation. Retention leaves evidence, not live work. */
export async function scopedPluginFixture(
  scope: FixtureScope,
  options: { stateInVault?: boolean; retain?: boolean } = {},
) {
  const root = (await scope.acquire(
    () => Deno.makeTempDir({ prefix: "globnotes-platform-" }),
    (root) =>
      options.retain
        ? console.log(JSON.stringify({ retainedPluginFixture: root }))
        : Deno.remove(root, { recursive: true }),
  )).value;
  const vault = path.join(root, "vault");
  const metadataBase = options.stateInVault
    ? path.join(vault, "State")
    : path.join(root, "relocated-state");
  const statePath = path.join(metadataBase, "globnotes");
  const prepared = await scope.admit(async () => {
    const mkdir = scope.bind(Deno.mkdir);
    await mkdir(vault);
    await mkdir(statePath, { recursive: true });
    return pluginCapabilities(
      scope,
      { root, vault, statePath, metadataBase },
      scope,
    );
  });
  return prepared.value;
}

function pluginCapabilities(
  scope: FixtureScope,
  paths: RootBinding["paths"],
  rootOwner: FixtureScope,
): ScopedPluginFixture {
  ownFixtureScope(rootOwner, scope);
  const { root, vault, statePath, metadataBase } = paths;
  const bind = <Args extends unknown[], T>(effect: (...args: Args) => T) =>
    scope.bind(rootOwner.bind(effect));
  const admit = bind(<T>(effect: (signal: AbortSignal) => T | PromiseLike<T>) =>
    rootOwner.admit(effect, scope)
  );
  const mkdir = bind(Deno.mkdir), writeTextFile = bind(Deno.writeTextFile);
  const install = bind(async function (
    id: string,
    manifest: Record<string, unknown>,
    files: Record<string, string> = {},
  ) {
    // Pending installation is owned before the first filesystem await. Close
    // joins it before deleting the older root, even if a write is in flight.
    const installed = await admit(async () => {
      const dir = path.join(statePath, "plugins", id);
      await mkdir(dir, { recursive: true });
      await writeTextFile(
        path.join(dir, "manifest.json"),
        JSON.stringify({ id, ...manifest }),
      );
      for (const [name, source] of Object.entries(files)) {
        const file = path.join(dir, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeTextFile(file, source);
      }
      return dir;
    });
    return installed.value;
  });
  const fixture = Object.freeze({
    root,
    vault,
    statePath,
    metadataBase,
    install,
    admit,
  });
  const binding = {
    owner: rootOwner,
    scope,
    paths: { root, vault, statePath, metadataBase },
  };
  rootOwners.set(fixture, binding);
  rootOwners.set(install, binding);
  return fixture;
}

export interface ScopedPluginFixture {
  readonly root: string;
  readonly vault: string;
  readonly statePath: string;
  readonly metadataBase: string;
  /** One resource-owned admission port for installation, preparation and domain
   * helper effects, co-admitted by this runtime's scope when borrowed. */
  readonly admit: <T>(
    effect: (signal: AbortSignal) => T | PromiseLike<T>,
  ) => Promise<Readonly<{ value: T }>>;
  readonly install: (
    id: string,
    manifest: Record<string, unknown>,
    files?: Record<string, string>,
  ) => Promise<string>;
}

/** Project only scoped capabilities, including when borrowing a legacy fixture. */
export function bindPluginFixture(
  scope: FixtureScope,
  fixture: ScopedPluginFixture,
): ScopedPluginFixture {
  const binding = rootBinding(fixture);
  binding.owner.assertCurrent();
  return pluginCapabilities(scope, binding.paths, binding.owner);
}

/** Preserve an existing root custodian while projecting a new runtime scope. */
export function compatibilityPluginFixture(
  fixture: ScopedPluginFixture,
  dispose: () => Promise<void>,
) {
  const result = Object.freeze({ ...fixture, dispose });
  rootOwners.set(result, rootBinding(fixture));
  return result;
}

/** Separate evidence custody, not a live callback capability. */
export async function retainedPluginFixture(fixture: ScopedPluginFixture) {
  const evidence = createFixtureScope();
  await evidence.scope.adopt(
    fixture.root,
    (root) => Deno.remove(root, { recursive: true }),
  );
  const binding = rootBinding(fixture);
  const result = compatibilityPluginFixture(
    pluginCapabilities(binding.scope, binding.paths, evidence.scope),
    () => evidence.close(),
  );
  return result;
}

export function withPluginFixture<T>(
  body: (
    fixture: ScopedPluginFixture,
    scope: FixtureScope,
  ) => T | PromiseLike<T>,
  options: { stateInVault?: boolean; retain?: boolean } = {},
): Promise<T> {
  return fixtureScope(async (scope) =>
    body(await scopedPluginFixture(scope, options), scope)
  );
}

export const fixturePage = {
  id: "preferences",
  label: "Preferences",
  renderer: { kind: "declarative-v1", version: 1 },
  fields: [
    {
      key: "message",
      label: "Message",
      type: "text",
      default: "fixture",
      maxLength: 100,
    },
    {
      key: "protect",
      label: "Protect deletion",
      type: "toggle",
      default: true,
    },
    {
      key: "limit",
      label: "Limit",
      type: "number",
      default: 5,
      min: 1,
      max: 10,
      step: 1,
    },
  ],
};

/** Fresh fixture-owned public API authority for direct operation tests.
 * Actual HTTP/JWT admission is tested through the real request handlers.
 * Each call captures once; a later gate never borrows another epoch. */
export function fixtureApiOrigin(lifecycle: PluginLifecycle) {
  const epoch = lifecycle.epoch;
  return {
    origin: "api" as const,
    lease: Object.freeze({
      epoch,
      assertCurrent(operationId?: string) {
        if (!lifecycle.operational()) {
          throw new HttpError(503, "setup_required");
        }
        if (!lifecycle.writable()) throw new HttpError(403, "read-only mode");
        if (lifecycle.epoch !== epoch) {
          throw new OperationError(
            409,
            "operation_conflict",
            "Fixture API authority retired before effects.",
            { operationId },
          );
        }
      },
    }),
  };
}
