// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals } from "@std/assert";

const SCRIPT = new URL("../scripts/docker-latest-tag.sh", import.meta.url);

/** Runs the script in a temporary repository containing only the fixture tags. */
async function check(tags: string[], args: string[], githubOutput = true) {
  const root = await Deno.makeTempDir({ prefix: "globnotes-docker-latest-" });
  try {
    const git = async (...args: string[]): Promise<string> => {
      const result = await new Deno.Command("git", {
        args,
        cwd: root,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      return new TextDecoder().decode(result.stdout).trim();
    };

    await git("init", "--quiet");
    // Lightweight tags need only an object, not fixture commits or signing keys.
    const object = await git("hash-object", "-w", "--stdin");
    for (const tag of tags) {
      await git("update-ref", `refs/tags/${tag}`, object);
    }
    await Deno.mkdir(`${root}/scripts`);
    await Deno.copyFile(SCRIPT, `${root}/scripts/docker-latest-tag.sh`);
    const outputFile = `${root}/github-output`;
    const result = await new Deno.Command("bash", {
      args: [`${root}/scripts/docker-latest-tag.sh`, ...args],
      cwd: root,
      env: { GITHUB_OUTPUT: githubOutput ? outputFile : "" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      workflowOutput: result.success && githubOutput
        ? await Deno.readTextFile(outputFile)
        : "",
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const cases = [
  {
    name: "v2 gets latest when only v2 releases exist",
    tags: ["v2.4.0", "v2.5.0", "v2.5.1"],
    tag: "v2.5.1",
    latest: true,
  },
  {
    name: "v2 maintenance cannot move latest back after v3",
    tags: ["v3.0.0", "v2.5.1"],
    tag: "v2.5.1",
    latest: false,
  },
  {
    name: "v3 gets latest even with a later v2 release",
    tags: ["v3.0.0", "v2.5.1"],
    tag: "v3.0.0",
    latest: true,
  },
  {
    name: "v9 cannot take latest from v10",
    tags: ["v9.9.9", "v10.0.0"],
    tag: "v9.9.9",
    latest: false,
  },
  {
    name: "v10 is numerically newer than v9",
    tags: ["v9.9.9", "v10.0.0"],
    tag: "v10.0.0",
    latest: true,
  },
  {
    name: "non-release tags do not reserve a newer major",
    tags: [
      "v2.5.1",
      "nightly",
      "v99.0.0-rc.1",
      "v99.0.0+build",
      "v99.0",
      "99.0.0",
      "v99.0.0.1",
      "v099.0.0",
      "v99.00.0",
      "v99.0.00",
    ],
    tag: "v2.5.1",
    latest: true,
  },
  {
    name: "latest eligibility compares majors rather than patch versions",
    tags: ["v3.0.0", "v3.1.0"],
    tag: "v3.0.0",
    latest: true,
  },
];

for (const { name, tags, tag, latest } of cases) {
  Deno.test(`docker tags: ${name}`, async () => {
    const result = await check(tags, [tag]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stdout, `${latest}\n`);
    assertEquals(result.workflowOutput, `latest=${latest}\n`);
    assert(result.stderr.includes(tag), result.stderr);
  });
}

Deno.test("docker tags: stdout works without GITHUB_OUTPUT", async () => {
  const result = await check(["v2.5.1"], ["v2.5.1"], false);
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.stdout, "true\n");
});

Deno.test("docker tags: missing arguments print usage", async () => {
  const result = await check(["v2.5.1"], []);
  assertEquals(result.code, 1);
  assert(result.stderr.includes("usage:"), result.stderr);
});

Deno.test("docker tags: invalid release tags fail", async () => {
  const result = await check(["v2.5.1"], ["v3.0.0-rc.1"]);
  assertEquals(result.code, 1);
  assert(result.stderr.includes("v3.0.0-rc.1"), result.stderr);
});

Deno.test("docker tags: missing release tags fail with a fetch hint", async () => {
  const result = await check(["nightly", "v99.0.0-rc.1"], ["v2.5.1"]);
  assertEquals(result.code, 1);
  assert(result.stderr.includes("fetch repository tags"), result.stderr);
});
