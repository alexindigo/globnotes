// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  bootServer,
  createServerWorkingDirectory,
  SERVER_PORT_ENV,
  type TestServer,
} from "./helpers/boot.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

Deno.test("server working directories isolate prefix stamping from sibling and donor assets", async () => {
  const donor = new URL("../client/dist/index.html", import.meta.url);
  let original: string | null = null;
  try {
    original = await Deno.readTextFile(donor);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const first = await createServerWorkingDirectory();
  const second = await createServerWorkingDirectory();
  try {
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
        () => Deno.stat(`${second}/client/dist/index.html`),
        Deno.errors.NotFound,
      );
      await assertRejects(() => Deno.stat(donor), Deno.errors.NotFound);
    }
  } finally {
    await Deno.remove(first, { recursive: true });
    await Deno.remove(second, { recursive: true });
  }
});

/** Existing preload seam runs a real owned HTTP fixture before main. Its open
 * listener keeps the unresolved preload alive; product startup never executes. */
async function fixture(ignoreTerm: boolean) {
  const root = await Deno.makeTempDir({ prefix: "server-lifetime-" });
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
  let server: TestServer;
  try {
    server = await bootServer({ GLOBNOTES_GLOBNOTES_PATH: `${root}/vault` }, {
      denoArgs: ["--preload", preload],
    });
  } catch (error) {
    await Deno.remove(root, { recursive: true });
    throw error;
  }
  const startup = JSON.parse(
    await Deno.readTextFile(`${root}/startup.json`),
  ) as { cwd: string; pid: number };
  assertEquals(startup.pid, server.pid);
  return {
    root,
    server,
    cwd: startup.cwd,
    async cleanup() {
      // Cleanup of a failed regression must not leave its deliberately stubborn
      // child running. It is exactly the PID returned by this fixture's owner.
      if (!server.status()) {
        try {
          Deno.kill(server.pid, "SIGKILL");
        } catch { /* already exited */ }
        await waitUntil(
          () => server.status() ? done() : pending({ pid: server.pid }),
          { label: "owned lifetime fixture exited" },
        );
      }
      await server.close().catch(() => {});
      await Deno.remove(root, { recursive: true });
    },
  };
}

for (const ignoreTerm of [false, true]) {
  Deno.test(`server lifetime: ${ignoreTerm ? "SIGKILL follows ignored SIGTERM" : "cooperative SIGTERM exits cleanly"}`, async () => {
    const f = await fixture(ignoreTerm);
    let closing: Promise<void> | undefined;
    try {
      closing = f.server.close();
      // Shared readiness bound is only the test's safety net. The launcher
      // must actually kill the stubborn process; this test never does so first.
      await waitUntil(
        () => f.server.status() ? done() : pending({ pid: f.server.pid }),
        { label: "server close settled its owned child" },
      );
      await closing;
      assertStringIncludes(f.server.output.stdout, "TERM_RECEIVED");
      assertEquals(f.server.status()?.signal, ignoreTerm ? "SIGKILL" : null);
      if (!ignoreTerm) assertEquals(f.server.status()?.code, 0);
      await assertRejects(() => Deno.stat(f.cwd), Deno.errors.NotFound);
      assertEquals(
        await Deno.readTextFile(`${f.root}/vault/retained.md`),
        "caller-owned vault",
      );
    } finally {
      await f.cleanup();
      if (closing) await closing.catch(() => {});
    }
  });
}

Deno.test("server lifetime: unexpected exit still rejects close with diagnostics", async () => {
  const f = await fixture(false);
  try {
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
    await assertRejects(() => Deno.stat(f.cwd), Deno.errors.NotFound);
  } finally {
    await f.cleanup();
  }
});
