// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { BoundFileStore, StoredConfigConflict } from "../config/file_store.ts";

export class IdentityOwnershipError extends Error {
  constructor() {
    super("Identity state has another live owner; stop it before recovery.");
  }
}
/** Stable advisory inode held for the server/CLI lifetime. Preparation uses the
 * existing bound-file parent's CAS owner, never a second mkdir path. */
export function acquireIdentityOwnership(root: string): {
  assertCurrent(): void;
  close(): void;
} {
  const store = new BoundFileStore(join(root, "identity.lock"));
  let held = store.capture();
  if (held.raw === null) {
    try {
      held = store.prepareParents(held);
      store.replace("", held, (snapshot) => {
        held = snapshot;
      });
    } catch (error) {
      if (
        !(error instanceof Deno.errors.AlreadyExists) &&
        !(error instanceof StoredConfigConflict)
      ) throw error;
      const winner = store.capture();
      // Reuse the winner only under the same bound parents and links.
      if (
        winner.raw === null || winner.binding.target !== held.binding.target ||
        JSON.stringify(
            winner.binding.nodes.filter((n) =>
              n.location !== winner.binding.target
            ),
          ) !==
          JSON.stringify(
            held.binding.nodes.filter((n) =>
              n.location !== held.binding.target
            ),
          )
      ) throw new StoredConfigConflict();
      held = winner;
    }
  }
  const handle = Deno.openSync(held.binding.target, { read: true });
  let closed = false;
  try {
    const stat = handle.statSync();
    const node = held.binding.nodes.find((n) =>
      n.location === held.binding.target
    );
    if (
      !node?.identity || node.identity.ino !== stat.ino ||
      node.identity.dev !== stat.dev
    ) throw new StoredConfigConflict();
    store.assertUnchanged(held);
    if (!handle.tryLockSync(true)) throw new IdentityOwnershipError();
    const assertCurrent = () => {
      if (closed) throw new IdentityOwnershipError();
      store.assertUnchanged(held);
    };
    assertCurrent();
    return Object.freeze({
      assertCurrent,
      close() {
        if (closed) return;
        closed = true;
        handle.close();
      },
    });
  } catch (error) {
    handle.close();
    throw error;
  }
}
