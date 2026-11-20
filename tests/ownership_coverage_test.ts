// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as path from "@std/path";
import {
  analyzeOwnership,
  assertModuleCoverage,
  ownershipCoverage,
  OwnershipSourceOwner,
  repositoryOwnership,
  repositorySources,
} from "./helpers/ownership_contract.ts";

Deno.test("ownership coverage: root spellings and symlinks have identical complete coverage", async () => {
  const root = path.fromFileUrl(new URL("../", import.meta.url));
  const canonical = await Deno.realPath(root);
  const temporary = await Deno.makeTempDir({ prefix: "ownership-root-" });
  try {
    const link = path.join(temporary, "checkout");
    await Deno.symlink(canonical, link, { type: "dir" });
    const relative = path.relative(Deno.cwd(), canonical) || ".";
    const spellings = [
      canonical,
      canonical + "/",
      relative,
      "./" + relative,
      "./" + relative + "/./",
      path.join(relative, "..", path.basename(canonical)),
      link,
      link + "/",
    ];
    const reference = await repositoryOwnership(canonical);
    for (const spelling of spellings) {
      const actual = await repositoryOwnership(spelling);
      assertEquals(
        actual.coverage,
        reference.coverage,
        `coverage for ${spelling}`,
      );
      assertEquals(
        actual.sites,
        reference.sites,
        `capabilities for ${spelling}`,
      );
    }
    console.log(
      JSON.stringify({
        root: reference.coverage.root,
        modules: reference.coverage.files.length,
        roots: reference.coverage.roots,
        spellings: spellings.length,
      }),
    );
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
});

Deno.test("ownership coverage: empty, partial and foreign roots cannot define a passing scan", async () => {
  await assertRejects(() => repositorySources(""), Error, "empty root");
  const root = await Deno.makeTempDir({ prefix: "ownership-incomplete-" });
  try {
    await assertRejects(() => repositorySources(root), Error, "root mismatch");
    await assertRejects(
      () => new OwnershipSourceOwner(root).sources(root),
      Error,
      "missing source root",
    );
    await Deno.mkdir(path.join(root, "server"));
    await assertRejects(
      () => new OwnershipSourceOwner(root).sources(root),
      Error,
      "empty source root",
    );
    await Deno.writeTextFile(
      path.join(root, "server", "one.ts"),
      "export const x = 1;",
    );
    await assertRejects(
      () => new OwnershipSourceOwner(root).sources(root),
      Error,
      "missing source root tests",
    );
    const link = path.join(root, "wrong-checkout");
    await Deno.symlink(path.join(root, "server"), link, { type: "dir" });
    await assertRejects(() => repositorySources(link), Error, "root mismatch");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ownership coverage: empty, partial, duplicate and differently spelled module sets reject", async () => {
  assertThrows(() => analyzeOwnership([]), Error, "empty module set");
  const sources = await repositorySources(
    path.fromFileUrl(new URL("../", import.meta.url)),
  );
  const manifest = ownershipCoverage(sources);
  assert(manifest.roots.server > 0);
  const files = sources.map((source) => source.file);
  assertModuleCoverage(manifest.files, files);
  assertThrows(
    () => assertModuleCoverage(manifest.files, []),
    Error,
    "empty module set",
  );
  assertThrows(
    () =>
      assertModuleCoverage(
        manifest.files,
        files.filter((file) => !file.startsWith("server/")),
      ),
    Error,
    "coverage mismatch",
  );
  assertThrows(
    () => assertModuleCoverage(manifest.files, [...files, files[0]]),
    Error,
    "duplicate parsed",
  );
  assertThrows(
    () =>
      assertModuleCoverage(
        manifest.files,
        files.map((file, index) => index ? file : "./" + file),
      ),
    Error,
    "noncanonical parsed",
  );
  // The parser retains the owner's enumeration independently of mutable input.
  sources.pop();
  assertThrows(() => analyzeOwnership(sources), Error, "coverage mismatch");
});
