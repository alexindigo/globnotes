// SPDX-License-Identifier: LGPL-3.0-only
import * as path from "@std/path";
import type { FixtureScope } from "./fixture_scope.ts";
import { createFixtureScope, ownFixtureScope } from "./fixture_scope_engine.ts";
import { captureOwnedCommand } from "./owned_child.ts";
import { DENO } from "./process_values.ts";

const repository = path.fromFileUrl(new URL("../../", import.meta.url));
declare const buildBrand: unique symbol;
export interface CompletedBuild {
  readonly [buildBrand]: true;
  readonly assets: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}
const builds = new WeakMap<CompletedBuild, ReadonlyMap<string, Uint8Array>>();
const hash = async (bytes: Uint8Array) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ].map(
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");

/** This port is for owner contracts only. Concrete production builds below own
 * the real command and wait for successful exit before capturing any output. */
export async function completeBuild(
  scope: FixtureScope,
  produce: (directory: string, signal: AbortSignal) => Promise<void>,
): Promise<CompletedBuild> {
  const root = await scope.acquire(
    () => Deno.makeTempDir({ prefix: "globnotes-build-" }),
    (root) => Deno.remove(root, { recursive: true }),
  );
  const output = path.join(root.value, "dist");
  // Keep the parent root until production and capture settle, including when
  // the enclosing scope retires while either operation is in flight.
  return (await scope.admit(async (signal) => {
    await produce(output, signal);
    scope.assertCurrent();
    const files = new Map<string, Uint8Array>(),
      assets: { path: string; sha256: string }[] = [];
    const visit = async (directory: string, relative = "") => {
      for await (const entry of Deno.readDir(directory)) {
        signal.throwIfAborted();
        if (entry.isSymlink) {
          throw new TypeError("Completed build cannot follow symlinks");
        }
        const name = relative ? `${relative}/${entry.name}` : entry.name,
          file = path.join(directory, entry.name);
        if (entry.isDirectory) await visit(file, name);
        else if (entry.isFile) {
          const bytes = await Deno.readFile(file);
          signal.throwIfAborted();
          files.set(name, bytes);
          assets.push({ path: name, sha256: await hash(bytes) });
        } else throw new TypeError("Completed build contains a non-file asset");
      }
    };
    // Validate the root itself, not the target readDir would follow through a link.
    const rootInfo = await Deno.lstat(output);
    signal.throwIfAborted();
    if (rootInfo.isSymlink || !rootInfo.isDirectory) {
      throw new TypeError("Completed build requires a real output directory");
    }
    await visit(output);
    if (!files.get("index.html")?.length) {
      throw new TypeError("Completed build requires a nonempty index.html");
    }
    scope.assertCurrent();
    const build = Object.freeze({
      assets: Object.freeze(
        assets.sort((a, b) => a.path.localeCompare(b.path)).map((row) =>
          Object.freeze(row)
        ),
      ),
    }) as CompletedBuild;
    builds.set(build, files);
    return build;
  })).value;
}

/** Rejects a forged or unfinished input before any consumer allocates for it. */
export function assertCompletedBuild(build: CompletedBuild): void {
  if (!builds.has(build)) {
    throw new TypeError("Boot requires an issued completed-build input");
  }
}

/** Copies accepted bytes, never a live build directory. The input can outlive the
 * producer's temporary directory; callers cannot mutate its private byte map. */
export async function installCompletedBuild(
  scope: FixtureScope,
  build: CompletedBuild,
  cwd: string,
) {
  assertCompletedBuild(build);
  const files = builds.get(build)!;
  await scope.admit(async (signal) => {
    for (const [name, bytes] of files) {
      signal.throwIfAborted();
      const target = path.join(cwd, "client", "dist", name);
      await Deno.mkdir(path.dirname(target), { recursive: true });
      signal.throwIfAborted();
      await Deno.writeFile(target, bytes, { createNew: true });
    }
  });
}

interface ClientBuildJob {
  readonly scope: FixtureScope;
  readonly completion: Promise<CompletedBuild>;
  /** Set synchronously when the producer issues its input, before its scope
   * retires; a retired job without it can only reject and must not be joined. */
  readonly issued: boolean;
}

function startClientBuild(borrower?: FixtureScope): ClientBuildJob {
  const lifetime = createFixtureScope();
  if (borrower) ownFixtureScope(borrower, lifetime.scope);
  let issued = false;
  const completion = lifetime.run(async (scope) => {
    const build = await completeBuild(scope, async (output, signal) => {
      const { status, stdout, stderr } = await captureOwnedCommand(
        scope,
        DENO,
        {
          args: ["task", "build:client", "--outDir", output],
          cwd: repository,
        },
      );
      signal.throwIfAborted();
      if (!status.success) {
        throw new Error(
          `Client build failed (${status.code}): ${stderr}\n${stdout}`,
        );
      }
    });
    issued = true;
    return build;
  });
  return {
    scope: lifetime.scope,
    completion,
    get issued() {
      return issued;
    },
  };
}

export function buildClient(borrower?: FixtureScope): Promise<CompletedBuild> {
  try {
    return startClientBuild(borrower).completion;
  } catch (error) {
    return Promise.reject(error);
  }
}

let compatibility: ClientBuildJob | undefined;
/** Legacy boot callers used the presence of a donor build to select HTML
 * serving. Preserve that choice, but never copy its mutable files: build once
 * into a private output, then share the completed, immutable input. */
export function repositoryBuild(
  borrower?: FixtureScope,
  options: { required?: boolean } = {},
): Promise<CompletedBuild | undefined> {
  try {
    borrower?.assertCurrent();
    const { required = false } = options;
    // Capturing an option can run caller code. Fence it before touching the
    // donor, starting a producer, or returning an already-completed cache entry.
    borrower?.assertCurrent();
    if (!required) {
      try {
        Deno.statSync(path.join(repository, "client", "dist"));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          return Promise.resolve(undefined);
        }
        throw error;
      }
    }
    // Cancellation retires the producer scope synchronously, but clears this
    // cache only after its rejection settles. Never join that doomed job.
    if (
      !compatibility ||
      (compatibility.scope.signal.aborted && !compatibility.issued)
    ) {
      const job = startClientBuild(borrower);
      compatibility = job;
      job.completion.catch(() => {
        if (Object.is(compatibility, job)) compatibility = undefined;
      });
    }
    const job = compatibility;
    // All in-flight consumers can cancel the shared producer. Once its scope has
    // retired, only finite release remains; completed immutable input needs no root.
    if (borrower && !job.scope.signal.aborted) {
      ownFixtureScope(borrower, job.scope);
    }
    return job.completion;
  } catch (error) {
    return Promise.reject(error);
  }
}
