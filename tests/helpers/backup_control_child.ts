// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { backupFixture } from "./backup_fixture.ts";
import { FsError } from "../../server/plugins/contracts.ts";
const [kind, mode, directory] = Deno.args;
assert(
  ["count", "order", "location", "preimage", "pin", "recovery", "aliases"]
    .includes(kind),
);
assert(["healthy", "broken"].includes(mode));
const changes: Record<string, [string, string][]> = {
  count: [[
    "const planned = stages.slice(0, config.count)",
    "const planned = stages.slice(0, Math.min(3, config.count + 1))",
  ], [
    "Math.min(journal.count, journal.old.length + 1)",
    "Math.min(Math.min(3, journal.count + 1), journal.old.length + 1)",
  ]],
  order: [
    [
      "const planned = stages.slice(0, config.count)",
      "const planned = stages.slice(0, config.count).reverse()",
    ],
    [
      "slot.hash !== journal.stages[index].hash",
      "slot.hash !== journal.stages[journal.planned.length - index - 1].hash",
    ],
    [
      "this.#verifiedFile(state.stages[index].file, slot.hash, config)",
      "this.#verifiedFile(state.stages[state.planned.length - index - 1].file, slot.hash, config)",
    ],
  ],
  location: [[
    "root = workspace.vault;",
    "root = join(workspace.vault, 'misplaced');",
  ]],
  preimage: [[
    "content: before.content",
    "content: fact.after?.content ?? before.content",
  ]],
  pin: [["base: values.basePath", "base: ''"]],
  recovery: [[
    "if (metadata?.value.operationKey === state.operationKey)",
    "if (false && metadata?.value.operationKey === state.operationKey)",
  ]],
  aliases: [[
    "JSON.stringify([root, captured.path])",
    "JSON.stringify([config.base, captured.path])",
  ], [
    "JSON.stringify([state.root, state.path])",
    "JSON.stringify([state.base, state.path])",
  ]],
};
let armed = false, fired = false;
const b = await backupFixture({
  environment: kind === "pin"
    ? JSON.stringify({
      "globnotes-backup": { backup: { basePath: "dedicated" } },
    })
    : undefined,
  variant: (name, text) => {
    if (mode !== "broken" || name !== "backup.js") return text;
    for (const [before, after] of changes[kind]) {
      assertEquals(
        text.split(before).length - 1,
        1,
        "control source delta must match once",
      );
      text = text.replace(before, after);
    }
    return text;
  },
  fault: (method, args, boundary) => {
    if (
      kind === "recovery" && armed && !fired && boundary === "after" &&
      method === "fs.writeFile" && String(args[0]).includes("/family-")
    ) {
      fired = true;
      throw new FsError("fs_io_error", "committed");
    }
  },
});
let restarted: Awaited<ReturnType<typeof backupFixture>> | undefined;
try {
  await Deno.mkdir(`${b.fixture.vault}/misplaced`);
  await Deno.mkdir(`${b.fixture.vault}/dedicated`);
  await Deno.writeTextFile(
    `${directory}/source-delta.json`,
    JSON.stringify({
      kind,
      mode,
      deltas: mode === "broken" ? changes[kind] : [],
      fixture: b.fixture.root,
      actualPluginSource: await Deno.readTextFile(`${b.dir}/backup.js`),
    }),
  );
  await b.create("Control", "A");
  await b.save("Control", "B");
  await b.status();
  if (kind === "aliases") await b.configure(2, ".");
  if (kind === "recovery") armed = true;
  await b.save("Control", "C");
  await b.status();
  if (kind === "recovery") {
    await b.close();
    restarted = await backupFixture({
      fixture: b.fixture,
      variant: (name, text) =>
        mode === "broken" && name === "backup.js"
          ? text.replace(changes.recovery[0][0], changes.recovery[0][1])
          : text,
    });
    assertEquals(
      (await restarted.status()).pendingRecovery,
      false,
      `BACKUP_CONSUMER_${kind}: committed ring cleanup must complete after restart`,
    );
  }
  const current = restarted ?? b;
  await current.save("Control", "D");
  await current.status();
  const base = kind === "pin"
    ? `${b.fixture.vault}/dedicated`
    : b.fixture.vault;
  const read = async (slot: number) => {
    try {
      return await Deno.readTextFile(`${base}/Control.md.${slot}.bak`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  };
  // Each actual producer must reach ready/managed ACK before this named disk consumer.
  assertEquals(
    await read(0),
    "C",
    `BACKUP_CONSUMER_${kind}: newest captured text`,
  );
  assertEquals(
    await read(1),
    "B",
    `BACKUP_CONSUMER_${kind}: older captured text`,
  );
  assertEquals(
    await read(2),
    null,
    `BACKUP_CONSUMER_${kind}: exactly two ordered slots`,
  );
  await Deno.writeTextFile(
    `${directory}/consumer.json`,
    JSON.stringify({
      kind,
      mode,
      fixture: b.fixture.root,
      observed: [await read(0), await read(1), await read(2)],
      status: await current.status(),
      live: await Deno.readTextFile(`${b.fixture.vault}/Control.md`),
      namedConsumerCompleted: true,
    }),
  );
  console.log(`BACKUP_CONSUMER_${kind}: complete`);
} finally {
  if (restarted) await restarted.close();
  else await b.close();
}
