// SPDX-License-Identifier: LGPL-3.0-only
// A deliberately failed owned child leaves its already-recorded candidates for
// the parent's recovery owner. No fixture teardown runs before process loss.
import { IdentityFile } from "../../server/auth/records.ts";
import { createOperationLease } from "../../server/operation_lease.ts";
import { createPublicationSet } from "../../server/config/owned_publication.ts";

const [root, phase, setId] = Deno.args;
const validate = (value: unknown) => value as { revision: number };
const one = new IdentityFile(`${root}/one.json`, validate, { revision: 0 });
const two = new IdentityFile(`${root}/two.json`, validate, { revision: 0 });
const lease = createOperationLease("live", [() => undefined]);
const journalPath = `${root}/journal.json`;
const set = createPublicationSet(setId, [
  one.prepareParticipant(
    { revision: 1 },
    one.capture(),
    lease.lease,
    setId,
    "one",
  ),
  two.prepareParticipant(
    { revision: 2 },
    two.capture(),
    lease.lease,
    setId,
    "two",
  ),
], journalPath);
const journal = new IdentityFile(
  journalPath,
  (value) => value,
  null,
);
journal.commit({ setId, phase: "prepared", records: set.records });
if (phase !== "prepared") {
  set.decide();
  journal.commit({ setId, phase: "decided", records: set.records });
  if (phase === "half") {
    const link = Deno.linkSync;
    Deno.linkSync = (from, to) => {
      link(from, to);
      throw new Error("stop after first actual publication");
    };
    const result = set.publish();
    if (result.state !== "recovery-required") {
      throw new Error("missing partial failure");
    }
  } else if (phase === "installed") {
    if (set.publish().state !== "committed") {
      throw new Error("missing installation");
    }
  }
}
throw new Error(`G1 recorded crash: ${phase}`);
