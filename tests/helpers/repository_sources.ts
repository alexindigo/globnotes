// SPDX-License-Identifier: LGPL-3.0-only
import { dirname, fromFileUrl, join } from "@std/path";

interface SourceSet {
  files: readonly string[];
  trees?: readonly string[];
  omitTrees?: readonly string[];
  rebase?: string;
}

const runtime = ["deno.json", "deno.lock", "VERSION"];
const server = ["defaults/", "plugins/", "server/", "shared/"];
const backup = "plugins/globnotes-backup/";
const remotelySave = "plugins/globnotes-remotely-save/";
const mcpVault = "tests/fixtures/mcp/vault/";

// Names come from Git, not from a walk of any of these directories. A prefix
// opts in to tracked inputs below it, never generated siblings or artifacts.
const sets = {
  "unit-control": {
    files: [
      "deno.json",
      "deno.lock",
      "tailwind.config.js",
      "vitest.config.mjs",
    ],
    trees: ["client/", "shared/"],
    omitTrees: ["client/tests/e2e/"],
  },
  "backup-control": {
    files: [...runtime, "tailwind.config.js", "vite.config.js"],
    trees: [...server, "client/", "tests/helpers/", "tests/fixtures/"],
  },
  "config-startup": { files: runtime, trees: server },
  "backup-plugin": {
    files: [`${backup}manifest.json`],
    trees: [backup],
    rebase: backup,
  },
  "remotely-save-plugin": {
    files: [`${remotelySave}manifest.json`],
    trees: [remotelySave],
    rebase: remotelySave,
  },
  "mcp-vault": { files: [], trees: [mcpVault], rebase: mcpVault },
} satisfies Record<string, SourceSet>;

const repository = fromFileUrl(new URL("../../", import.meta.url));
const sourceIndex = "/run-logs/files.z";

function selectSources(raw: Uint8Array, set: SourceSet): string[] {
  const paths = new TextDecoder("utf-8", { fatal: true }).decode(raw).split(
    "\0",
  );
  if (paths.pop() !== "" || !paths.length) {
    throw Error("Expected a nonempty NUL-terminated tracked source inventory");
  }
  const tracked = new Set(paths);
  if (
    tracked.size !== paths.length ||
    paths.some((file) =>
      file.split("/").some((part) => !part || part === "." || part === "..")
    )
  ) {
    throw Error("Invalid tracked source inventory");
  }
  for (const file of set.files) {
    if (!tracked.has(file)) {
      throw Error(`Required source is not tracked: ${file}`);
    }
  }
  const files = paths.filter((file) =>
    set.files.includes(file) ||
    (set.trees?.some((tree) => file.startsWith(tree)) &&
      !set.omitTrees?.some((tree) => file.startsWith(tree)))
  );
  for (const tree of set.trees ?? []) {
    if (!files.some((file) => file.startsWith(tree))) {
      throw Error(`No tracked sources in ${tree}`);
    }
  }
  return files;
}

/** Materialize only a declared tracked source set in a caller-owned directory.
 * Use the current source bytes so uncommitted edits and the copied control's
 * deliberate mutations survive. The index supplies names, not blob contents.
 * A missing selected file is an error, not a reason to silently skip it. */
export async function copyRepositorySources(
  name: keyof typeof sets,
  destination: string,
  { root = repository, inventory = sourceIndex } = {},
): Promise<void> {
  const set: SourceSet = sets[name];
  const raw = await Deno.readFile(inventory).catch((cause) => {
    throw Error(
      `Cannot read tracked source inventory ${inventory}; run via .devcontainer/run.sh`,
      { cause },
    );
  });
  const selected = selectSources(raw, set);
  const source = await Deno.realPath(root);
  for (const relative of selected) {
    const file = join(source, relative);
    if (
      !(await Deno.lstat(file)).isFile || await Deno.realPath(file) !== file
    ) {
      throw Error(`Not a regular source file: ${relative}`);
    }
    const output = join(destination, relative.slice(set.rebase?.length ?? 0));
    await Deno.mkdir(dirname(output), { recursive: true });
    await Deno.copyFile(file, output);
  }
}
