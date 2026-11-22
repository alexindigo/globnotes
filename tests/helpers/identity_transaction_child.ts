// SPDX-License-Identifier: LGPL-3.0-only
// Deliberate process loss retains the production journal, not fixture scratch.
import { transactionContext } from "./identity_transaction.ts";
const [root, phase] = Deno.args;
const f = transactionContext(root, undefined, (point) => {
  if (point === phase) throw new Error(`identity crash: ${phase}`);
  if (phase === "half" && point === "decided") {
    const link = Deno.linkSync;
    Deno.linkSync = (from, to) => {
      link(from, to);
      throw new Error("identity crash: first participant published");
    };
  }
});
const staged = await f.stage();
f.transaction.commit(staged.meta, staged.parts, f.lease);
