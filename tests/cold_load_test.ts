// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStringIncludes } from "@std/assert";
import { command, DENO } from "./helpers/process.ts";
import { SERVER_PORT_ENV } from "./helpers/boot.ts";

for (const mode of ["early-exit", "ignore-term"]) {
  Deno.test(`cold-load: preserves diagnostics for ${mode}`, async () => {
    const root = await Deno.makeTempDir({ prefix: "cold-load-control-" });
    try {
      await Deno.mkdir(`${root}/server`);
      await Deno.writeTextFile(`${root}/deno.json`, "{}");
      const portEnv = JSON.stringify(SERVER_PORT_ENV);
      const server = mode === "early-exit"
        ? 'console.log("SERVER_CRASH_STDOUT"); console.error("SERVER_CRASH_STDERR"); Deno.exit(17);'
        : `Deno.addSignalListener("SIGTERM", () => {});
console.log("SERVER_IGNORES_TERM");
Deno.serve({hostname:"0.0.0.0",port:Number(Deno.env.get(${portEnv}))},
  request => new Response("fixture", {status:new URL(request.url).pathname === "/_/api/health" ? 200 : 500}));`;
      await Deno.writeTextFile(`${root}/server/main.ts`, server);
      const script = new URL("../scripts/cold-load.mjs", import.meta.url);
      const result = await command("timeout", {
        args: ["40", DENO, "run", "-A", script.pathname, root, mode],
      }).output();
      assertEquals(result.code, 1);
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);
      assertStringIncludes(stdout, "SERVER STDOUT");
      assertStringIncludes(stdout, "SERVER STDERR");
      if (mode === "early-exit") {
        assertStringIncludes(stdout, "SERVER_CRASH_STDOUT");
        assertStringIncludes(stdout, "SERVER_CRASH_STDERR");
        assertStringIncludes(
          stderr,
          "cached cold-load never served health 200",
        );
        assertStringIncludes(stdout, '"code":17');
      } else {
        assertStringIncludes(stdout, "SERVER_IGNORES_TERM");
        assertStringIncludes(stdout, '"signal":"SIGKILL"');
        assertStringIncludes(stderr, "static index not HTML 200");
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
