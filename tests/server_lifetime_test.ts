// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  bootServer,
  createServerWorkingDirectory,
  SERVER_PORT_ENV,
} from "./helpers/boot.ts";
import { done, pending, READINESS_MS, waitUntil } from "./helpers/wait.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import { type FixtureScope, fixtureScope } from "./helpers/fixture_scope.ts";
import { publishRecord } from "./helpers/process_records.ts";
import { command, DENO } from "./helpers/process.ts";
import { fromFileUrl } from "@std/path";

const processProbe = (pid: number) =>
  command("bash", {
    args: ["-c", 'kill -0 "$1"', "boot-child-absence", String(pid)],
    stdout: "piped",
    stderr: "piped",
  }).output();
// Post-verdict rescue only. The assertions must observe cleanup before this runs.
async function rescueChild(pid: number) {
  if (!(await processProbe(pid)).success) return;
  try {
    Deno.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await waitUntil(
    async () => (await processProbe(pid)).success ? pending({ pid }) : done(),
    { label: "post-verdict child rescue" },
  );
}

Deno.test("server working directories isolate prefix stamping from sibling and donor assets", async () => {
  const donor = new URL("../client/dist/index.html", import.meta.url);
  let original: string | null = null;
  try {
    original = await Deno.readTextFile(donor);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await fixtureScope(async (scope) => {
    const first = (await scope.acquire(createServerWorkingDirectory, (dir) =>
      Deno.remove(dir, { recursive: true }))).value;
    const second = (await scope.acquire(createServerWorkingDirectory, (dir) =>
      Deno.remove(dir, { recursive: true }))).value;
    assertEquals(first === second, false);
    assertEquals(first.startsWith(Deno.cwd() + "/"), false);
    assertEquals(second.startsWith(Deno.cwd() + "/"), false);
    await Deno.mkdir(`${first}/client/dist`, { recursive: true });
    await Deno.writeTextFile(
      `${first}/client/dist/index.html`,
      "prefixed /notes assets",
    );
    if (original !== null) {
      assertEquals(
        await Deno.readTextFile(`${second}/client/dist/index.html`),
        original,
      );
      assertEquals(await Deno.readTextFile(donor), original);
    } else {
      await assertRejects(
        () =>
          Deno.stat(`${second}/client/dist/index.html`),
        Deno.errors.NotFound,
      );
      await assertRejects(() =>
        Deno.stat(donor), Deno.errors.NotFound);
    }
  });
});

/** Existing preload seam runs a real owned HTTP fixture before main. Its open
 * listener keeps the unresolved preload alive; product startup never executes. */
async function fixture(ignoreTerm: boolean, scope: FixtureScope) {
  const root = (await scope.acquire(
    () => Deno.makeTempDir({ prefix: "server-lifetime-" }),
    (root) => Deno.remove(root, { recursive: true }),
  )).value;
  await Deno.mkdir(`${root}/vault`);
  await Deno.writeTextFile(`${root}/vault/retained.md`, "caller-owned vault");
  const preload = `${root}/preload.mjs`;
  await Deno.writeTextFile(
    preload,
    `
Deno.addSignalListener('SIGTERM',()=>{
  console.log('TERM_RECEIVED');
  ${ignoreTerm ? "" : "Deno.exit(0);"}
});
console.error('OWNED_SERVER_DIAGNOSTIC');
Deno.serve({hostname:Deno.env.get('GLOBNOTES__SERVER_HOST'),port:Number(Deno.env.get(${
      JSON.stringify(SERVER_PORT_ENV)
    })),onListen({hostname,port}){
  console.log('globnotes listening on http://'+hostname+':'+port);
  Deno.writeTextFileSync(${
      JSON.stringify(`${root}/startup.json`)
    },JSON.stringify({cwd:Deno.cwd(),pid:Deno.pid}));
}},request=>{
  if(new URL(request.url).pathname==='/crash')Deno.exit(17);
  return new Response('ok');
});
await new Promise(()=>{});
`,
  );
  const server = (await scope.acquire(
    () =>
      bootServer({ GLOBNOTES_GLOBNOTES_PATH: `${root}/vault` }, {
        denoArgs: ["--preload", preload],
      }),
    async (server) => {
      // Post-verdict rescue only; construction and assertions retain custody.
      if (!server.status()) {
        await rescueChild(server.pid);
        await server.exited;
      }
      await server.close().catch(() => {});
    },
  )).value;
  const startup = JSON.parse(
    await Deno.readTextFile(`${root}/startup.json`),
  ) as { cwd: string; pid: number };
  assertEquals(startup.pid, server.pid);
  return {
    root,
    server,
    cwd: startup.cwd,
  };
}

for (const ignoreTerm of [false, true]) {
  Deno.test(`server lifetime: ${ignoreTerm ? "SIGKILL follows ignored SIGTERM" : "cooperative SIGTERM exits cleanly"}`, async () => {
    await fixtureScope(async (scope) => {
      const f = await fixture(ignoreTerm, scope);
      const closing = f.server.close();
      try {
        assertStrictEquals(f.server.close(), closing);
        // Shared readiness bound is only the test's safety net. The launcher
        // must actually kill the stubborn process; this test never does so first.
        await bounded(
          closing,
          "server close settled its owned child",
          READINESS_MS,
        );
        assertStringIncludes(f.server.output.stdout, "TERM_RECEIVED");
        assertEquals(f.server.status()?.signal, ignoreTerm ? "SIGKILL" : null);
        if (!ignoreTerm) assertEquals(f.server.status()?.code, 0);
        await assertRejects(
          () => Deno.stat(f.cwd),
          Deno.errors.NotFound,
          `stat '${f.cwd}'`,
        );
        assertEquals(
          await Deno.readTextFile(`${f.root}/vault/retained.md`),
          "caller-owned vault",
        );
      } finally {
        // Rescue first: a broken escalation must not block joining the original
        // teardown, nor let the fixture finish while that teardown is pending.
        await rescueChild(f.server.pid);
        await closing.catch(() => {});
      }
    });
  });
}

Deno.test("server lifetime: unexpected exit still rejects close with diagnostics", async () => {
  await fixtureScope(async (scope) => {
    const f = await fixture(false, scope);
    await fetch(`${f.server.baseUrl}/crash`).catch(() => {});
    await waitUntil(
      () => f.server.status() ? done() : pending({ pid: f.server.pid }),
      { label: "fixture crashed on request" },
    );
    const error = await assertRejects(
      () => f.server.close(),
      Error,
      "server exited on its own before close()",
    );
    assertStringIncludes(error.message, "exit code 17");
    assertStringIncludes(error.message, "OWNED_SERVER_DIAGNOSTIC");
    await assertRejects(
      () => Deno.stat(f.cwd),
      Deno.errors.NotFound,
      `stat '${f.cwd}'`,
    );
  });
});

Deno.test("server lifetime: failed cwd preparation releases its partial directory before return", async () => {
  await fixtureScope(async (scope) => {
    const root = (await scope.acquire(
      () => Deno.makeTempDir({ prefix: "boot-cwd-failure-" }),
      (root) => Deno.remove(root, { recursive: true }),
    )).value;
    const script = `${root}/check.ts`;
    const boot = new URL("./helpers/boot.ts", import.meta.url).href;
    await Deno.writeTextFile(
      script,
      `import {createServerWorkingDirectory} from ${JSON.stringify(boot)};
let rejected=false;
try { await createServerWorkingDirectory(); } catch(error) { if(!(error instanceof Deno.errors.NotCapable)) throw error; rejected=true; }
if(!rejected) throw Error("Expected donor access to reject");
const entries=[...Deno.readDirSync(${
        JSON.stringify(root)
      })].map(entry=>entry.name).sort();
if(JSON.stringify(entries)!=='["check.ts"]') throw Error("Unexpected root entries: "+JSON.stringify(entries));
console.log("partial cwd released");`,
    );
    const result = await command(DENO, {
      args: [
        "run",
        "--cached-only",
        "--frozen",
        `--config=${fromFileUrl(new URL("../deno.json", import.meta.url))}`,
        `--allow-read=${root},${DENO}`,
        `--allow-write=${root}`,
        script,
      ],
      env: { TMPDIR: root },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
    assertEquals(
      new TextDecoder().decode(result.stdout),
      "partial cwd released\n",
    );
  });
});

Deno.test("server lifetime: boot captures every option and its argument list before yielding", async () => {
  await fixtureScope(async (scope) => {
    const root = (await scope.acquire(() =>
      Deno.makeTempDir({ prefix: "boot-input-capture-" }), (root) =>
      Deno.remove(root, { recursive: true }))).value;
    const preload = `${root}/preload.mjs`, receipt = `${root}/startup.json`;
    await Deno.writeTextFile(
      preload,
      `
Deno.writeTextFileSync(${
        JSON.stringify(receipt)
      }, JSON.stringify({cwd:Deno.cwd(),host:Deno.env.get("GLOBNOTES__SERVER_HOST")}));
Deno.addSignalListener("SIGTERM",()=>Deno.exit(0));
Deno.serve({hostname:Deno.env.get("GLOBNOTES__SERVER_HOST"),port:0,onListen({port}){console.log("globnotes listening on http://127.0.0.1:"+port);}},()=>new Response("ok"));
await new Promise(()=>{});
`,
    );
    const reads: string[] = [];
    let changed = false;
    const extra = ["--preload", preload];
    const options = {
      get cwd() {
        reads.push("cwd");
        return changed ? Deno.cwd() : root;
      },
      get host() {
        reads.push("host");
        return changed ? "invalid.example" : "127.0.0.1";
      },
      get origin() {
        reads.push("origin");
        return changed
          ? () => {
            throw Error("changed origin");
          }
          : (port: number) =>
            `http://127.0.0.1:${port}`;
      },
      get healthFetch(): typeof fetch {
        reads.push("healthFetch");
        return changed
          ? () => Promise.reject(Error("changed fetch"))
          : fetch;
      },
      get denoArgs() {
        reads.push("denoArgs");
        return extra;
      },
    };
    const server = (await scope.acquire(() => {
      const starting = bootServer({}, options);
      changed = true;
      extra.splice(0, extra.length, "--not-a-deno-option");
      return starting;
    }, (server) => server.close())).value;
    assertEquals([
      reads,
      JSON.parse(await Deno.readTextFile(receipt)),
      server.args.slice(-3),
    ], [
      ["cwd", "host", "origin", "healthFetch", "denoArgs"],
      { cwd: root, host: "127.0.0.1" },
      [
        "--preload",
        preload,
        fromFileUrl(new URL("../server/main.ts", import.meta.url)),
      ],
    ]);
  });
});

for (const mode of ["failure", "missing"] as const) {
  Deno.test(`server lifetime: vault tracking survives ${mode} cleanup until successful or missing removal`, async () => {
    await fixtureScope(async (scope) => {
      const root = (await scope.acquire(() =>
        Deno.makeTempDir({ prefix: "boot-vault-retry-" }), (root) =>
        Deno.remove(root, { recursive: true }))).value;
      const script = `${root}/check.ts`, receipt = `${root}/result.json`;
      const boot = new URL("./helpers/boot.ts", import.meta.url).href;
      const checkout = fromFileUrl(new URL("../", import.meta.url));
      await Deno.writeTextFile(
        script,
        `
import {assertEquals,assertRejects} from "@std/assert";
import {bootServer} from ${JSON.stringify(boot)};
const nativeRemove=Deno.remove;
let vault="";
const removal=new Error("vault removal failed");
Deno.remove=async (file,options)=>{
  if(String(file).includes("globnotes-test-vault-")) {
    vault=String(file);
    if(${
          JSON.stringify(mode)
        }==="missing") {await nativeRemove(file,options);throw new Deno.errors.NotFound("already removed");}
    throw removal;
  }
  return nativeRemove(file,options);
};
const validation="test servers must not run in the checkout (cwd ${checkout}): the server rewrites the cwd-relative client/dist/index.html at boot";
const error=await assertRejects(()=>bootServer({}, {cwd:${
          JSON.stringify(checkout)
        }}), ${mode === "failure" ? "AggregateError" : "Error"}, ${
          mode === "failure" ? '"Owned resource release failed"' : "validation"
        });
Deno.remove=nativeRemove;
if(${
          JSON.stringify(mode)
        }==="failure") assertEquals(error.errors.map(item=>item.message), [validation,removal.message]);
let present;
try {await Deno.stat(vault);present=true;}catch(error){if(!(error instanceof Deno.errors.NotFound))throw error;present=false;}
assertEquals(present,${mode === "failure"});
addEventListener("unload",()=>{
  let remains;
  try{Deno.statSync(vault);remains=true;}catch(error){if(!(error instanceof Deno.errors.NotFound))throw error;remains=false;}
  Deno.writeTextFileSync(${
          JSON.stringify(receipt)
        },JSON.stringify({vault,present,remains}));
});
`,
      );
      const result = await bounded(
        command(DENO, {
          args: [
            "run",
            "--frozen",
            `--config=${fromFileUrl(new URL("../deno.json", import.meta.url))}`,
            "--allow-read",
            "--allow-write",
            "--allow-env",
            script,
          ],
          stdout: "piped",
          stderr: "piped",
        }).output(),
        "vault tracking subprocess completion",
      );
      assertEquals([result.code, new TextDecoder().decode(result.stderr)], [
        0,
        "",
      ]);
      const outcome = JSON.parse(await Deno.readTextFile(receipt));
      assertEquals([outcome.present, outcome.remains], [
        mode === "failure",
        false,
      ]);
      await assertRejects(
        () =>
          Deno.stat(outcome.vault),
        Deno.errors.NotFound,
        `stat '${outcome.vault}'`,
      );
    });
  });
}

for (const phase of ["startup", "receipt"] as const) {
  Deno.test(`server lifetime: ${phase} failure before a returned handle reaps and releases owned roots`, async () => {
    await fixtureScope(async (scope) => {
      const root = (await scope.acquire(
        () => Deno.makeTempDir({ prefix: "boot-failure-" }),
        (root) => Deno.remove(root, { recursive: true }),
      )).value;
      const preload = `${root}/preload.mjs`, record = `${root}/child.json`;
      scope.defer(async () => {
        let child;
        try {
          child = JSON.parse(await Deno.readTextFile(record));
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return;
          throw error;
        }
        await rescueChild(child.pid);
        for (const directory of [child.cwd, child.vault]) {
          try {
            await Deno.remove(directory, { recursive: true });
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
      });
      await Deno.writeTextFile(
        preload,
        `
Deno.writeTextFileSync(${
          JSON.stringify(record)
        },JSON.stringify({pid:Deno.pid,cwd:Deno.cwd(),vault:Deno.env.get('GLOBNOTES_GLOBNOTES_PATH')}));
${
          phase === "startup" ? "throw new Error('startup sentinel');" : `
Deno.addSignalListener('SIGTERM',()=>Deno.exit(0));
Deno.serve({hostname:Deno.env.get('GLOBNOTES__SERVER_HOST'),port:0,onListen({port}){console.log('globnotes listening on http://127.0.0.1:'+port);}},()=>new Response('ok'));
await new Promise(()=>{});`
        }
`,
      );
      const receipt = `${root}/receipt.json`;
      await Deno.mkdir(receipt);
      let origins = 0, publicationError: unknown;
      const error = await assertRejects(
        () =>
          bootServer({}, {
            denoArgs: ["--preload", preload],
            origin(port) {
              if (++origins === 2) {
                try {
                  publishRecord(receipt, "{}");
                } catch (error) {
                  publicationError = error;
                  throw error;
                }
              }
              return `http://127.0.0.1:${port}`;
            },
          }),
        phase === "startup" ? Error : Deno.errors.IsADirectory,
        phase === "startup" ? "startup sentinel" : receipt,
      );
      if (phase === "startup") {
        assertStringIncludes(error.message, "startup sentinel");
      } else assertEquals(error, publicationError);
      const child = JSON.parse(await Deno.readTextFile(record));
      const probe = await processProbe(child.pid);
      assertEquals(probe.success, false);
      assertStringIncludes(
        new TextDecoder().decode(probe.stderr),
        "No such process",
      );
      await assertRejects(
        () => Deno.stat(child.cwd),
        Deno.errors.NotFound,
        `stat '${child.cwd}'`,
      );
      await assertRejects(
        () => Deno.stat(child.vault),
        Deno.errors.NotFound,
        `stat '${child.vault}'`,
      );
    });
  });
}
