// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStringIncludes } from "@std/assert";
import { command } from "./helpers/process.ts";

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
    const reusable = ["success", "v2-success", "identical-base"].includes(mode);
    try {
      await Deno.mkdir(`${root}/bin`);
      const pr = {
        base: {
          ref: mode === "base-mismatch" ? "v2" : branch,
          sha: mode === "missing-base-sha"
            ? null
            : mode === "identical-base"
            ? sha
            : base,
        },
        head: { sha: mode === "pr-head-mismatch" ? base : sha },
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
        ...(mode === "missing-prs"
          ? {}
          : { pull_requests: mode === "fork-empty" ? [] : [pr] }),
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
      if (["pull-request", "release-tag"].includes(mode)) {
        let requested = false;
        try {
          await Deno.stat(`${root}/requests`);
          requested = true;
        } catch { /* no API call expected */ }
        assertEquals(requested, false);
      } else if (
        ["base-mismatch", "fork-empty", "missing-prs", "pr-head-mismatch"]
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
