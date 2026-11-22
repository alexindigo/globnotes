// SPDX-License-Identifier: LGPL-3.0-only
import * as path from "@std/path";
import type { FixtureScope } from "./fixture_scope.ts";
import { ownFixtureScope } from "./fixture_scope_engine.ts";
import {
  assertCompletedBuild,
  type CompletedBuild,
  installCompletedBuild,
  repositoryBuild,
} from "./completed_build_engine.ts";
declare const layoutBrand: unique symbol;
export interface FixtureLayout {
  readonly [layoutBrand]: true;
  readonly instance: string;
  readonly vault: string;
  readonly metadata: string;
  readonly cwd: string;
  readonly artifacts: string;
  readonly environment: Readonly<Record<string, string>>;
}
const layouts = new WeakMap<FixtureLayout, FixtureScope>();
const retainedRoots = new Set<string>();
globalThis.addEventListener?.("unload", () => {
  const errors = [];
  for (const root of retainedRoots) {
    try {
      Deno.removeSync(root, { recursive: true });
      retainedRoots.delete(root);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) retainedRoots.delete(root);
      else errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Retained fixture layout cleanup failed");
  }
});
export async function fixtureLayout(
  scope: FixtureScope,
  inputs: Record<string, string>,
  options: {
    cwd?: string;
    artifacts?: string;
    build?: CompletedBuild;
    retainPersistent?: () => boolean;
  } = {},
): Promise<FixtureLayout> {
  inputs = { ...inputs };
  const {
    cwd: suppliedCwd,
    artifacts: suppliedArtifacts,
    build: suppliedBuild,
    retainPersistent,
  } = options;
  // Validate the captured input before allocating any root for it.
  if (suppliedCwd !== undefined && suppliedBuild !== undefined) {
    throw new TypeError(
      "A borrowed cwd cannot be combined with a completed build",
    );
  }
  if (suppliedBuild !== undefined) assertCompletedBuild(suppliedBuild);
  const root = await scope.acquire(
    async () => {
      const root = await Deno.makeTempDir({ prefix: "globnotes-layout-" });
      retainedRoots.add(root);
      return root;
    },
    async (root) => {
      // Compatibility boot retains successful instance/vault state for restart,
      // transferring that custody to the existing process-unload phase.
      if (retainPersistent?.()) {
        return;
      }
      try {
        await Deno.remove(root, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      retainedRoots.delete(root);
    },
  );
  const directory = async (name: string, transient = false) => {
    const allocate = async () => {
      const result = path.join(root.value, name);
      await Deno.mkdir(result);
      return result;
    };
    // Reserve each in-flight allocation too: retirement must not remove the
    // enclosing root while a later mkdir is still able to recreate it.
    return (await scope.admit(() =>
      scope.acquire(
        allocate,
        (dir) => transient ? Deno.remove(dir, { recursive: true }) : undefined,
      )
    )).value.value;
  };
  const instance = inputs.GLOBNOTES__VAULTS_BASEPATH
    ? path.resolve(inputs.GLOBNOTES__VAULTS_BASEPATH)
    : await directory("instance");
  const vault = inputs.GLOBNOTES_GLOBNOTES_PATH
    ? path.resolve(inputs.GLOBNOTES_GLOBNOTES_PATH)
    : path.join(instance, "globnotes");
  if (!inputs.GLOBNOTES_GLOBNOTES_PATH && !inputs.GLOBNOTES__VAULTS_BASEPATH) {
    await scope.admit(() => Deno.mkdir(vault, { recursive: true }));
  }
  const metadataBase = inputs.GLOBNOTES__METADATA_PATH;
  const metadata = metadataBase
    ? path.resolve(metadataBase, "globnotes")
    : path.join(vault, ".globnotes");
  // Do not pre-create borrowed roots: doing so would bypass the product's
  // permission/durability preflight for a missing metadata creation parent.
  if (
    !metadataBase && !inputs.GLOBNOTES_GLOBNOTES_PATH &&
    !inputs.GLOBNOTES__VAULTS_BASEPATH
  ) {
    await scope.admit(
      () => Deno.mkdir(metadata, { recursive: true }),
    );
  }
  const cwd = suppliedCwd
    ? path.resolve(suppliedCwd)
    : await directory("cwd", true);
  const artifacts = suppliedArtifacts
    ? path.resolve(suppliedArtifacts)
    : await directory("artifacts", true);
  const environment: Record<string, string> = {
    ...inputs,
    GLOBNOTES__VAULTS_BASEPATH: instance,
  };
  // The default notes path is derived by the product. Do not fabricate metadata
  // or vault overrides merely to obtain isolation.
  if (inputs.GLOBNOTES_GLOBNOTES_PATH) {
    environment.GLOBNOTES_GLOBNOTES_PATH = vault;
  }
  if (metadataBase) {
    environment.GLOBNOTES__METADATA_PATH = path.resolve(metadataBase);
  }
  const build = suppliedBuild ??
    (suppliedCwd
      ? undefined
      : (await scope.admit(() => repositoryBuild(scope))).value);
  if (!suppliedCwd && build) await installCompletedBuild(scope, build, cwd);
  scope.assertCurrent();
  const result = Object.freeze({
    instance,
    vault,
    metadata,
    cwd,
    artifacts,
    environment: Object.freeze(environment),
  }) as FixtureLayout;
  layouts.set(result, scope);
  return result;
}
export function layoutEnvironment(
  layout: FixtureLayout,
): Readonly<Record<string, string>> {
  const scope = layouts.get(layout);
  if (!scope) throw new TypeError("Layout custody was not issued");
  scope.assertCurrent();
  return layout.environment;
}

/** Keep autonomous server work inside the layout's lifetime, not only the IO
 * that boot performs before returning the server. */
export function bindLayout(
  layout: FixtureLayout,
  borrower: FixtureScope,
): void {
  const owner = layouts.get(layout);
  if (!owner) throw new TypeError("Layout custody was not issued");
  ownFixtureScope(owner, borrower);
}

/** Promise-returning: an unissued layout rejects, it never throws synchronously. */
export async function admitLayout<T>(
  layout: FixtureLayout,
  borrower: FixtureScope,
  effect: (signal: AbortSignal) => T | PromiseLike<T>,
): Promise<Readonly<{ value: T }>> {
  const owner = layouts.get(layout);
  if (!owner) throw new TypeError("Layout custody was not issued");
  return await owner.admit(effect, borrower);
}

/** Explicit product-data seeding needs the metadata directory before startup;
 * ordinary boot must leave borrowed root creation to the real product. */
export async function prepareFixtureMetadata(
  layout: FixtureLayout,
  borrower: FixtureScope,
): Promise<void> {
  await admitLayout(
    layout,
    borrower,
    () => Deno.mkdir(layout.metadata, { recursive: true }),
  );
}

/** Compatibility entry for native launchers not yet adopted. It still accepts
 * only completed bytes; caller retains the returned directory until removal. */
export async function serverWorkingDirectory(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "globnotes-test-cwd-" });
  try {
    const build = await repositoryBuild();
    if (build) {
      // No lifetime escapes this installer; the compatibility caller owns dir.
      const { fixtureScope } = await import("./fixture_scope.ts");
      await fixtureScope((scope) => installCompletedBuild(scope, build, dir));
    }
    return dir;
  } catch (primary) {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        "Server cwd preparation failed",
        { cause: primary },
      );
    }
    throw primary;
  }
}
