// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertFalse } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl } from "@std/path";
import { parse, stringify } from "@std/toml";
import {
  bootServer,
  SERVER_PORT_ENV,
  type TestServer,
} from "./helpers/boot.ts";
import { command, DENO } from "./helpers/process.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

Deno.test("config acceptance: shell and server retain original provenance; saves survive restart and empty pins", async () => {
  const root = await Deno.makeTempDir({ prefix: "config-acceptance-" });
  const notes = `${root}/notes`,
    metadata = `${root}/metadata`,
    state = `${metadata}/globnotes`;
  let server: TestServer | undefined;
  try {
    await Deno.mkdir(notes);
    await Deno.mkdir(state, { recursive: true });
    await Deno.writeTextFile(`${notes}/Consumer.md`, "# Consumer\n");
    const file = `${state}/config.toml`;
    await Deno.writeTextFile(
      file,
      '[brand]\naccent="#123456"\n[quickaccess]\ntitle="TOML consumer"\n',
    );
    const env = {
      GLOBNOTES_GLOBNOTES_PATH: notes,
      GLOBNOTES__METADATA_PATH: metadata,
      GLOBNOTES__SERVER_PATHPREFIX: "/notes",
      GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE: "false",
    };
    const cli = await command(DENO, {
      cwd: ROOT,
      args: [
        "run",
        "--cached-only",
        "--allow-read",
        "--allow-env",
        "server/config/cli.ts",
        "--shell",
      ],
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(cli.code, 0, new TextDecoder().decode(cli.stderr));
    const projection = new TextDecoder().decode(cli.stdout);
    assert(projection.includes(`LAUNCH_VAULT_METADATA='${state}'`));
    assert(projection.includes("LAUNCH_PREFIX='/notes'"));
    assert(
      projection.trim().split("\n").every((row) => row.startsWith("LAUNCH_")),
    );
    server = await bootServer({ ...env, fixtureAuth: { auth_type: "none" } });
    const config = () =>
      fetch(`${server!.baseUrl}/notes/_/api/config`).then((r) => r.json());
    const manifest = () =>
      fetch(`${server!.baseUrl}/notes/_/brand/site.webmanifest`).then((r) =>
        r.json()
      );
    const save = async (name: string) => {
      const body = new FormData();
      body.set("name", name);
      const response = await fetch(`${server!.baseUrl}/notes/_/api/brand`, {
        method: "POST",
        body,
      });
      await response.body?.cancel();
      return response.status;
    };
    const initial = await config();
    assertEquals(initial.provenance["brand.accent"], {
      layer: "toml",
      pinned: false,
    });
    assertEquals(initial.provenance["quickaccess.limit"], {
      layer: "defaults",
      pinned: false,
    });
    assertEquals(initial.quickAccessTitle, "TOML consumer");
    const auth = await Deno.readTextFile(`${state}/config.json`);
    assertEquals(await save("Restart consumer"), 200);
    assertEquals((await manifest()).name, "Restart consumer");
    assertEquals(parse(await Deno.readTextFile(file)).brand, {
      accent: "#123456",
      name: "Restart consumer",
    });
    assertEquals(await Deno.readTextFile(`${state}/config.json`), auth);
    await server.close();
    server = undefined;
    server = await bootServer(env);
    assertEquals((await config()).brand.name, "Restart consumer");
    assertEquals((await manifest()).name, "Restart consumer");
    const external = `${await Deno.readTextFile(
      file,
    )}\n# externally edited binding\n`;
    await Deno.writeTextFile(file, external);
    assertEquals(await save("must not overwrite external edit"), 409);
    assertEquals(await Deno.readTextFile(file), external);
    assertEquals((await manifest()).name, "Restart consumer");
    await server.close();
    server = undefined;
    server = await bootServer({ ...env, GLOBNOTES_GLOBNOTES_BRAND_NAME: "" });
    assertEquals((await config()).brand.name, null);
    assertEquals((await manifest()).name, "globnotes");
    assertEquals(await save("forbidden"), 409);
    assertEquals(await Deno.readTextFile(file), external);
    console.log(
      JSON.stringify({
        shellProjectionAgrees: true,
        defaultProvenanceRetained: true,
        restartManifestConsumer: true,
        externalWriteRejected: true,
        emptyEnvPinClearsConsumer: true,
      }),
    );
  } finally {
    await server?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("config acceptance: actual startup aggregates errors and missing defaults before any metadata writes", async () => {
  const root = await Deno.makeTempDir({ prefix: "config-negative-startup-" });
  try {
    const app = `${root}/app`,
      notes = `${root}/notes`,
      metadata = `${root}/metadata`;
    await Deno.mkdir(app);
    await Deno.mkdir(notes);
    for (const dir of ["server", "shared", "defaults", "plugins"]) {
      await copy(`${ROOT}/${dir}`, `${app}/${dir}`);
    }
    for (const name of ["deno.json", "deno.lock", "VERSION"]) {
      await Deno.copyFile(`${ROOT}/${name}`, `${app}/${name}`);
    }
    await Deno.symlink(`${ROOT}/node_modules`, `${app}/node_modules`);
    await Deno.writeTextFile(`${notes}/Retained.md`, "retained note bytes\n");
    const defaults = parse(
      await Deno.readTextFile(`${app}/defaults/globnotes.toml`),
    );
    delete (defaults.log as Record<string, unknown>).level;
    await Deno.writeTextFile(
      `${app}/defaults/globnotes.toml`,
      stringify(defaults),
    );
    const secret = "FIXTURE-SECRET-MUST-NOT-APPEAR";
    const result = await command(DENO, {
      cwd: app,
      args: [
        "run",
        "--cached-only",
        "--frozen",
        `--config=${app}/deno.json`,
        "--unstable-worker-options",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
        `${app}/server/main.ts`,
      ],
      env: {
        GLOBNOTES_GLOBNOTES_PATH: notes,
        GLOBNOTES__METADATA_PATH: metadata,
        GLOBNOTES__LOG_LEVEL: "INFO",
        [SERVER_PORT_ENV]: secret,
        GLOBNOTES_GLOBNOTES_QUICKACCESS_LIMIT: "-1",
        GLOBNOTES_RETIRED_FIXTURE: secret,
      },
      signal: AbortSignal.timeout(15_000),
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(result.stdout),
      stderr = new TextDecoder().decode(result.stderr);
    assertFalse(result.success);
    assert(result.code !== 0);
    assertEquals(result.signal, null);
    for (
      const key of [
        "log.level",
        "server.port",
        SERVER_PORT_ENV,
        "quickaccess.limit",
        "GLOBNOTES_GLOBNOTES_QUICKACCESS_LIMIT",
        "GLOBNOTES_RETIRED_FIXTURE",
      ]
    ) assert(stderr.includes(key), `Missing ${key}: ${stderr}`);
    assertEquals(stdout, "");
    assertFalse(stderr.includes(secret));
    assertFalse(await Deno.stat(metadata).then(() => true).catch(() => false));
    assertEquals([...Deno.readDirSync(notes)].map((e) => e.name), [
      "Retained.md",
    ]);
    assertEquals(
      await Deno.readTextFile(`${notes}/Retained.md`),
      "retained note bytes\n",
    );
    console.log(JSON.stringify({
      startupExit: {
        code: result.code,
        success: result.success,
        signal: result.signal,
      },
      allDiagnostics: true,
      missingDefaultNotRepairedByEnv: true,
      metadataWrites: 0,
      secretInOutput: false,
    }));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
