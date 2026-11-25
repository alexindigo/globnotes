// SPDX-License-Identifier: LGPL-3.0-only
// Deliberate process loss retains the production journal, not fixture scratch.
import { transactionContext } from "./identity_transaction.ts";
import { basename, dirname } from "@std/path";
const [root, phase] = Deno.args;
const f = transactionContext(root, undefined, (point) => {
  if (point === phase) throw new Error(`identity crash: ${phase}`);
  if (phase === "half" && point === "decided") {
    const link = Deno.linkSync;
    Deno.linkSync = (from, to) => {
      link(from, to);
      const fault = new Error("identity crash: first participant published");
      // The publication set reports an unavailable receipt, not the native cause.
      console.error(fault.message);
      throw fault;
    };
  }
  if (point === "prepared" && phase.startsWith("cleanup-")) {
    const remove = Deno.removeSync;
    Deno.removeSync = (path, options) => {
      const file = String(path);
      const failed = phase === "cleanup-journal"
        ? file === `${root}/identity-transaction.json`
        : basename(file).startsWith(".config-") &&
          dirname(file) ===
            (phase === "cleanup-access" ? `${root}/vault` : root);
      if (failed) throw new Error(`identity crash: ${phase}`);
      return remove(path, options);
    };
    throw new Error("identity crash: before decision");
  }
});
const staged = await f.stage();
f.transaction.commit(staged.meta, staged.parts, f.lease);
