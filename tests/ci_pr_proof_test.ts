// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStringIncludes } from "@std/assert";
import { command } from "./helpers/process.ts";

for (
  const mode of [
    "success",
    "no-runs",
    "api-error",
    "no-job",
    "job-error",
    "malformed-url",
    "pull-request",
    "release-tag",
  ]
) {
  Deno.test(`CI PR proof: ${mode} only reuses proven exact-SHA test success`, async () => {
    const root = await Deno.makeTempDir({ prefix: "ci-pr-proof-" });
    const sha = "a".repeat(40);
    try {
      await Deno.mkdir(`${root}/bin`);
      await Deno.writeTextFile(
        `${root}/bin/gh`,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE/requests"
if [[ "$*" == *workflows/ci.yml/runs* ]]; then
  [[ "$*" == *"head_sha=$GITHUB_SHA"* && "$*" == *event=pull_request* && "$*" == *status=success* ]] || exit 99
  [[ "$MODE" != api-error ]] || exit 22
  [[ "$MODE" != no-runs ]] || exit 0
  if [[ "$MODE" == malformed-url ]]; then printf '123\\thttps://foreign.example/run\\n'; else printf '123\\thttps://github.com/owner/repo/actions/runs/123\\n'; fi
else
  [[ "$*" == *"runs/123/jobs?filter=latest"* ]] || exit 99
  [[ "$MODE" != job-error ]] || exit 22
  [[ "$MODE" != no-job ]] || exit 0
  printf '456\\n'
fi
`,
        { mode: 0o755 },
      );
      const result = await command("timeout", {
        args: [
          "20",
          "bash",
          new URL("../scripts/ci-pr-proof.sh", import.meta.url).pathname,
        ],
        env: {
          PATH: `${root}/bin:${Deno.env.get("PATH")}`,
          FIXTURE: root,
          MODE: mode,
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_SHA: sha,
          GITHUB_EVENT_NAME: mode === "pull-request" ? "pull_request" : "push",
          GITHUB_REF: mode === "release-tag"
            ? "refs/tags/v2.9.0"
            : "refs/heads/main",
          GITHUB_OUTPUT: `${root}/output`,
          GITHUB_STEP_SUMMARY: `${root}/summary`,
        },
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      assertEquals(
        await Deno.readTextFile(`${root}/output`),
        `run-tests=${mode !== "success"}\n`,
      );
      const summary = await Deno.readTextFile(`${root}/summary`);
      assertStringIncludes(
        summary,
        mode === "success"
          ? "https://github.com/owner/repo/actions/runs/123"
          : "Running tests",
      );
      if (mode === "pull-request" || mode === "release-tag") {
        let requested = false;
        try {
          await Deno.stat(`${root}/requests`);
          requested = true;
        } catch { /* no API call expected */ }
        assertEquals(requested, false);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
