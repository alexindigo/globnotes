// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { command } from "./helpers/process.ts";

Deno.test("CI layout: two native shards, one checks job and proof-compatible final test", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
  );
  const job = (name: string) =>
    workflow.split(`\n  ${name}:\n`)[1]?.split(/\n {2}[a-z-]+:\n/)[0] ?? "";
  const native = job("native"), checks = job("checks"), test = job("test");
  assertStringIncludes(native, "shard: [1/2, 2/2]");
  assertStringIncludes(native, "fail-fast: false");
  assertStringIncludes(native, "GLOBNOTES_E2E_CONCURRENCY=2");
  assertStringIncludes(native, "--native");
  assertStringIncludes(native, "--shard '${{ matrix.shard }}'");
  assertEquals(native.includes("--checks"), false);
  assertEquals(checks.includes("matrix:"), false);
  assertStringIncludes(checks, "--checks");
  assertStringIncludes(checks, "--timing");
  assertEquals(checks.includes("--browser"), false);
  assertStringIncludes(test, "needs: [evidence, checks, native]");
  assertStringIncludes(test, "if: always()");
  const body = test.split("        run: |\n")[1].split("\n").map((line) =>
    line.slice(10)
  ).join("\n");
  for (
    const [evidence, reuse, checks, native, expected] of [
      ["success", "true", "success", "success", 0],
      ["success", "false", "skipped", "skipped", 0],
      ["failure", "false", "skipped", "skipped", 1],
      ["success", "true", "success", "failure", 1],
      ["success", "true", "success", "cancelled", 1],
      ["success", "true", "skipped", "success", 1],
      ["success", "false", "success", "skipped", 1],
    ] as const
  ) {
    const result = await command("bash", {
      args: ["-euc", body],
      env: {
        EVIDENCE_RESULT: evidence,
        RUN_TESTS: reuse,
        CHECKS_RESULT: checks,
        NATIVE_RESULT: native,
      },
    }).output();
    assertEquals(result.code, expected);
  }
});

// The fake API projects JSON fields like gh --jq, but makes no eligibility
// decisions. The real shell script owns branch, SHA, ancestry and job checks.
const fakeGh =
  `#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
const root=Deno.env.get('FIXTURE'),mode=Deno.env.get('MODE');
await Deno.writeTextFile(root+'/requests',JSON.stringify(Deno.args)+'\\n',{append:true});
const payload=JSON.parse(await Deno.readTextFile(root+'/api.json'));
const endpoint=Deno.args.find(arg=>arg.startsWith('repos/'));
const query=Deno.args[Deno.args.indexOf('--jq')+1];
if(endpoint.includes('/compare/')){
  if(endpoint!=='repos/owner/repo/compare/'+payload.comparison.base+'...'+payload.comparison.head)Deno.exit(99);
  if(mode==='compare-error')Deno.exit(22);
  console.log(payload.comparison.status ?? '');
}else{
  let rows;
  if(endpoint.includes('workflows/ci.yml/runs')){
    if(!endpoint.includes('head_sha='+Deno.env.get('GITHUB_SHA'))||!endpoint.includes('event=pull_request')||!endpoint.includes('status=success'))Deno.exit(99);
    if(mode==='api-error')Deno.exit(22);
    rows=payload.workflow_runs.flatMap(run=>query.includes('.pull_requests[]?')?(run.pull_requests??[]).map(pr=>({run,node:pr})):[{run,node:run}]);
  }else if(endpoint.includes('/commits/')){
    if(endpoint!=='repos/owner/repo/commits/'+Deno.env.get('GITHUB_SHA')+'/pulls?per_page=100'||!Deno.args.includes('--paginate'))Deno.exit(99);
    if(mode==='pr-api-error')Deno.exit(22);
    rows=payload.associated_prs.map(node=>({node}));
  }else{
    if(!endpoint.includes('runs/123/jobs?filter=latest'))Deno.exit(99);
    if(mode==='job-error')Deno.exit(22);
    rows=payload.jobs.map(node=>({node}));
  }
  const fields=query.includes('@tsv')?query.slice(query.lastIndexOf('[')+1,query.lastIndexOf(']')).split(',').map(field=>field.trim()):['.id'];
  for(const row of rows)console.log(fields.map(field=>{
    const run=field.startsWith('$run.');
    const path=field.slice(run?5:1).split('.');
    return path.reduce((value,key)=>value?.[key],run?row.run:row.node)??'';
  }).join('\\t'));
}
`;

for (
  const mode of [
    "success",
    "v2-success",
    "identical-base",
    "merged-pr-success",
    "merged-base-mismatch",
    "fork-associated",
    "unknown-pr-repo",
    "wrong-run-repo",
    "unknown-run-repo",
    "pr-api-error",
    "no-associated-prs",
    "later-pr-success",
    "base-repo-mismatch",
    "unknown-base-repo",
    "no-runs",
    "api-error",
    "no-job",
    "job-error",
    "test-failed",
    "other-job",
    "job-in-progress",
    "malformed-url",
    "pull-request",
    "release-tag",
    "base-mismatch",
    "fork-empty",
    "missing-prs",
    "pr-head-mismatch",
    "missing-base-sha",
    "diverged-base",
    "behind-base",
    "compare-error",
    "compare-malformed",
    "wrong-head",
    "wrong-event",
    "wrong-run-status",
    "wrong-run-conclusion",
  ]
) {
  Deno.test(`CI PR proof: ${mode} only reuses equivalent target-branch success`, async () => {
    const root = await Deno.makeTempDir({ prefix: "ci-pr-proof-" });
    const sha = "a".repeat(40), base = "b".repeat(40);
    const branch = mode === "v2-success" ? "v2" : "main";
    const reusable = [
      "success",
      "v2-success",
      "identical-base",
      "merged-pr-success",
      "later-pr-success",
    ].includes(mode);
    try {
      await Deno.mkdir(`${root}/bin`);
      const pr = {
        number: 42,
        state: mode.startsWith("merged-") ? "closed" : "open",
        merged_at: mode.startsWith("merged-") ? "2026-11-08T07:53:59Z" : null,
        base: {
          ref: ["base-mismatch", "merged-base-mismatch"].includes(mode)
            ? "v2"
            : branch,
          sha: mode === "missing-base-sha"
            ? null
            : mode === "identical-base"
            ? sha
            : base,
          repo: mode === "unknown-base-repo" ? null : {
            full_name: mode === "base-repo-mismatch"
              ? "other/repo"
              : "owner/repo",
          },
        },
        head: {
          sha: mode === "pr-head-mismatch" ? base : sha,
          repo: mode === "unknown-pr-repo" ? null : {
            full_name: ["fork-empty", "fork-associated"].includes(mode)
              ? "fork/repo"
              : "owner/repo",
            // The destination repository can itself be a fork. Identity,
            // not this ancestry flag, distinguishes a fork-origin PR.
            fork: true,
          },
        },
      };
      const run = {
        id: 123,
        html_url: mode === "malformed-url"
          ? "https://foreign.example/run"
          : "https://github.com/owner/repo/actions/runs/123",
        head_sha: mode === "wrong-head" ? base : sha,
        event: mode === "wrong-event" ? "push" : "pull_request",
        status: mode === "wrong-run-status" ? "in_progress" : "completed",
        conclusion: mode === "wrong-run-conclusion" ? "failure" : "success",
        head_repository: mode === "unknown-run-repo" ? null : {
          full_name: mode === "wrong-run-repo" ? "fork/repo" : "owner/repo",
        },
        ...(mode === "missing-prs" ? {} : {
          pull_requests: [
              "fork-empty",
              "merged-pr-success",
              "merged-base-mismatch",
            ].includes(mode)
            ? []
            : [pr],
        }),
      };
      const status = mode === "diverged-base"
        ? "diverged"
        : mode === "behind-base"
        ? "behind"
        : mode === "identical-base"
        ? "identical"
        : mode === "compare-malformed"
        ? null
        : "ahead";
      await Deno.writeTextFile(
        `${root}/api.json`,
        JSON.stringify({
          workflow_runs: mode === "no-runs" ? [] : [run],
          associated_prs: ["missing-prs", "no-associated-prs"].includes(mode)
            ? []
            : mode === "later-pr-success"
            ? [{ ...pr, base: { ...pr.base, ref: "v2" } }, pr]
            : [pr],
          jobs: mode === "no-job" ? [] : [{
            id: 456,
            name: mode === "other-job" ? "docker-build" : "test",
            status: mode === "job-in-progress" ? "in_progress" : "completed",
            conclusion: mode === "test-failed" ? "failure" : "success",
          }],
          comparison: { status, base: pr.base.sha, head: sha },
        }),
      );
      await Deno.writeTextFile(`${root}/bin/gh`, fakeGh, { mode: 0o755 });
      const result = await command("timeout", {
        args: [
          "20",
          "bash",
          fromFileUrl(new URL("../scripts/ci-pr-proof.sh", import.meta.url)),
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
            : `refs/heads/${branch}`,
          GITHUB_OUTPUT: `${root}/output`,
          GITHUB_STEP_SUMMARY: `${root}/summary`,
        },
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      assertEquals(
        await Deno.readTextFile(`${root}/output`),
        `run-tests=${!reusable}\n`,
      );
      assertStringIncludes(
        await Deno.readTextFile(`${root}/summary`),
        reusable
          ? "https://github.com/owner/repo/actions/runs/123"
          : "Running tests",
      );
      if (reusable) {
        assertStringIncludes(
          await Deno.readTextFile(`${root}/requests`),
          `/commits/${sha}/pulls?per_page=100`,
        );
      }
      if (["pull-request", "release-tag"].includes(mode)) {
        let requested = false;
        try {
          await Deno.stat(`${root}/requests`);
          requested = true;
        } catch { /* no API call expected */ }
        assertEquals(requested, false);
      } else if (
        [
          "base-mismatch",
          "merged-base-mismatch",
          "fork-empty",
          "fork-associated",
          "unknown-pr-repo",
          "wrong-run-repo",
          "unknown-run-repo",
          "missing-prs",
          "no-associated-prs",
          "pr-head-mismatch",
          "base-repo-mismatch",
          "unknown-base-repo",
        ]
          .includes(mode)
      ) {
        const requests = await Deno.readTextFile(`${root}/requests`);
        assertEquals(requests.includes("/compare/"), false);
        assertEquals(requests.includes("/jobs?"), false);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
