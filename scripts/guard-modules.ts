// SPDX-License-Identifier: LGPL-3.0-only
import { walk } from "@std/fs/walk";
import { fromFileUrl, relative, resolve } from "@std/path";

/** Guard filenames are registration, not imports in a shared test module. */
export function guardModules(files: readonly string[]): string[] {
  const guards: string[] = [];
  for (const file of files) {
    if (!file.startsWith("tests/")) continue;
    const name = file.slice(file.lastIndexOf("/") + 1);
    // The pre-existing coverage contract is also always-on. Keep its name.
    if (
      name.endsWith("_guard_test.ts") ||
      file === "tests/ownership_coverage_test.ts"
    ) guards.push(file);
    else if (/(?:^|[_.-])guard(?:[_.-]|$)/.test(name)) {
      throw new Error(`guard module must use *_guard_test.ts: ${file}`);
    }
  }
  return guards.sort();
}

export async function discoverGuardModules(root: string): Promise<string[]> {
  root = resolve(root);
  const files: string[] = [];
  for await (
    const entry of walk(resolve(root, "tests"), { includeDirs: false })
  ) {
    if (entry.isFile) files.push(relative(root, entry.path));
  }
  return guardModules(files);
}

if (import.meta.main) {
  for (
    const file of await discoverGuardModules(
      fromFileUrl(new URL("../", import.meta.url)),
    )
  ) console.log(file);
}
