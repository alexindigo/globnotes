// SPDX-License-Identifier: LGPL-3.0-only
// Execute the pinned v3 planner unchanged, exposing its private pure entry points.
// Imports for Obsidian IO/pro features are fail-closed runtime shims, never algorithms.
import { assert } from "@std/assert";
import { createHash } from "node:crypto";
import { revision } from "./remotely_save_reference.mjs";
export async function referencePlanner() {
  const dir = await Deno.makeTempDir({
    dir: "/artifacts",
    prefix: "v3-planner-",
  });
  const sources = [];
  async function download(path, name) {
    const url =
      `https://raw.githubusercontent.com/remotely-save/remotely-save/${revision}/${path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    assert(response.ok, `planner source ${response.status}`);
    const original = await response.text();
    await Deno.writeTextFile(`${dir}/${name}.original`, original);
    sources.push({
      url,
      sha256: createHash("sha256").update(original).digest("hex"),
    });
    return original;
  }
  const unavailable =
    "(..._args:unknown[])=>{throw Error('Unused upstream IO/import shim invoked');}";
  const names = [
    "copyFile",
    "copyFileOrFolder",
    "copyFolder",
    "clearPrevSyncRecordByVaultAndProfile",
    "getAllPrevSyncRecordsByVaultAndProfile",
    "insertSyncPlanRecordByVault",
    "upsertPrevSyncRecordByVaultAndProfile",
    "checkProRunnableAndFixInplace",
    "isMergable",
    "mergeFile",
    "tryDuplicateFile",
    "clearFileContentHistoryByVaultAndProfile",
    "getFileContentHistoryByVaultAndProfile",
    "upsertFileContentHistoryByVaultAndProfile",
  ];
  await Deno.writeTextFile(
    `${dir}/unavailable.ts`,
    `export default ${unavailable};\n` +
      names.map((name) => `export const ${name}=${unavailable};`).join("\n"),
  );
  await Deno.writeTextFile(
    `${dir}/metadata.ts`,
    `export const DEFAULT_FILE_NAME_FOR_METADATAONREMOTE='_remotely-save-metadata-on-remote.json';export const DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2='_remotely-save-metadata-on-remote.bin';`,
  );
  const misc = await download("src/misc.ts", "misc.ts");
  await Deno.writeTextFile(
    `${dir}/misc.ts`,
    misc.replace('from "path"', 'from "node:path"').replace(
      'from "emoji-regex"',
      'from "./unavailable.ts"',
    ).replace('from "xregexp"', 'from "./unavailable.ts"').replace(
      'from "rfc4648"',
      'from "npm:rfc4648@1.5.4"',
    ),
  );
  const sync = await download("pro/src/sync.ts", "sync.ts");
  let linked = sync;
  for (
    const specifier of [
      "aggregate-error",
      "p-queue",
      "xregexp",
      "../../src/copyLogic",
      "../../src/localdb",
      "./account",
      "./conflictLogic",
      "./localdb",
    ]
  ) linked = linked.replace(`from "${specifier}"`, 'from "./unavailable.ts"');
  linked = linked.replace(
    'from "../../src/metadataOnRemote"',
    'from "./metadata.ts"',
  ).replace('from "../../src/misc"', 'from "./misc.ts"');
  await Deno.writeTextFile(
    `${dir}/sync.ts`,
    linked + "\nexport {ensembleMixedEnties,getSyncPlanInplace};\n",
  );
  // Only display formatting uses moment; no timestamps/decisions are changed.
  globalThis.window = {
    ...globalThis.window,
    moment: (value) => ({ format: () => String(value) }),
  };
  const planner = await import(`file://${dir}/sync.ts`);
  await Deno.writeTextFile(
    `${dir}/provenance.json`,
    JSON.stringify(
      {
        revision,
        sources,
        changes: "import/runtime shims and private export exposure only",
      },
      null,
      2,
    ),
  );
  return async (local, previous, remote, backend) => {
    // Actual fsS3/fsWebdav inventories synthesize parent entities. Fixture adds
    // only these structural entries, leaving file sizes/times byte-exact.
    const parents = (entities) => {
      const all = new Map(entities.map((entity) => [entity.key, entity]));
      for (const entity of entities) {
        for (
          let i = entity.key.indexOf("/");
          i >= 0;
          i = entity.key.indexOf("/", i + 1)
        ) {
          const key = entity.key.slice(0, i + 1);
          if (!all.has(key)) {
            all.set(key, { key, keyEnc: key, size: 0, sizeEnc: 0 });
          }
        }
      }
      return [...all.values()];
    };
    const mapped = await planner.ensembleMixedEnties(
      parents(local),
      parents(previous),
      parents(remote),
      false,
      false,
      ".obsidian",
      true,
      [],
      [],
      { encryptEntity: (entity) => Promise.resolve({ ...entity }) },
      backend,
      undefined,
    );
    const result = await planner.getSyncPlanInplace(
      mapped,
      -1,
      "keep_newer",
      "bidirectional",
      undefined,
      { serviceType: backend, password: "", concurrency: 1 },
      "manual",
      ".obsidian",
    );
    return Object.fromEntries(
      Object.entries(result).filter(([key]) =>
        !key.endsWith("/") && key !== "/$@meta"
      ).map((
        [key, row],
      ) => [key, {
        decision: row.decision,
        branch: row.decisionBranch,
        change: row.change,
      }]),
    );
  };
}
