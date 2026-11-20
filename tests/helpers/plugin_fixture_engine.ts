// SPDX-License-Identifier: LGPL-3.0-only

import * as path from "@std/path";
import { HttpError } from "@pathfinder/pathfinder";
import type { PluginLifecycle } from "../../server/plugins/lifecycle.ts";
import { OperationError } from "../../server/plugins/errors.ts";
import {
  createFixtureScope,
  type FixtureScope,
  fixtureScope,
} from "./fixture_scope_engine.ts";

/** Task-owned plugins: no installed plugin, operator policy or real vault is edited. */
export async function pluginFixture(options: { stateInVault?: boolean } = {}) {
  const owner = createFixtureScope();
  return await owner.prepare(async (scope) => ({
    ...await scopedPluginFixture(scope, options),
    dispose: () => owner.close(),
  }));
}

/** Internal construction port: root custody belongs to the enclosing scenario
 * before any directory preparation. Retention leaves evidence, not live work. */
export async function scopedPluginFixture(
  scope: FixtureScope,
  options: { stateInVault?: boolean; retain?: boolean } = {},
) {
  const root = await scope.acquire(
    () => Deno.makeTempDir({ prefix: "globnotes-platform-" }),
    (root) =>
      options.retain
        ? console.log(JSON.stringify({ retainedPluginFixture: root }))
        : Deno.remove(root, { recursive: true }),
  );
  const vault = path.join(root, "vault");
  const metadataBase = options.stateInVault
    ? path.join(vault, "State")
    : path.join(root, "relocated-state");
  const statePath = path.join(metadataBase, "globnotes");
  await Deno.mkdir(vault);
  await Deno.mkdir(statePath, { recursive: true });
  async function install(
    id: string,
    manifest: Record<string, unknown>,
    files: Record<string, string> = {},
  ) {
    const dir = path.join(statePath, "plugins", id);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ id, ...manifest }),
    );
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(dir, name);
      await Deno.mkdir(path.dirname(file), { recursive: true });
      await Deno.writeTextFile(file, source);
    }
    return dir;
  }
  return {
    root,
    vault,
    statePath,
    metadataBase,
    install,
    // Compatibility custody for retained evidence after its runtime has closed.
    // The ordinary callback entry does not expose this manual deletion port.
    dispose: () => Deno.remove(root, { recursive: true }),
  };
}

export function withPluginFixture<T>(
  body: (
    fixture: Omit<Awaited<ReturnType<typeof scopedPluginFixture>>, "dispose">,
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
