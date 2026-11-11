// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertFalse } from "@std/assert";
import { parse, stringify } from "@std/toml";
import { assertThrows } from "@std/assert";
import { ConfigError, loadInstanceConfig } from "../server/config/loader.ts";
import { singleVaultBindings } from "../server/config/single_vault.ts";
import { command, DENO } from "./helpers/process.ts";
const ROOT = new URL("../", import.meta.url).pathname;

Deno.test("config launch: incomplete defaults retain aggregate diagnostics at the scope binding", async () => {
  const root = await Deno.makeTempDir({ prefix: "config-binding-defaults-" });
  try {
    const defaults = parse(
      await Deno.readTextFile(`${ROOT}/defaults/globnotes.toml`),
    );
    delete (defaults.vaults as Record<string, unknown>).basepath;
    delete (defaults.log as Record<string, unknown>).level;
    const file = `${root}/defaults.toml`;
    await Deno.writeTextFile(file, stringify(defaults));
    const error = assertThrows(
      () =>
        loadInstanceConfig({
          defaultsPath: file,
          overlayPath: null,
          env: { GLOBNOTES__LOG_LEVEL: "INFO" },
          vaults: singleVaultBindings,
        }),
      ConfigError,
    );
    assert(error.message.includes("vaults.basepath"));
    assert(error.message.includes("log.level"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function fixture(
  run: (root: string, env: Record<string, string>) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "config-launch-" });
  try {
    const notes = `${root}/vault's ; $(unrequested)`;
    await Deno.mkdir(notes);
    const file = `${root}/operator.toml`;
    await Deno.writeTextFile(
      file,
      stringify({
        server: {
          host: "::",
          port: 18765,
          pathprefix: "/notes",
          allowedhosts: ["globnotes.test:18765"],
        },
        vaults: {
          basepath: `${root}/base`,
          entries: { globnotes: { path: notes } },
        },
        metadata: { path: `${root}/metadata` },
      }),
    );
    await run(root, { GLOBNOTES_CONFIG: file });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
function cli(env: Record<string, string>) {
  return command(DENO, {
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
}
Deno.test("config launch: real CLI emits only allowlisted safely quoted values and no startup files", () =>
  fixture(async (root, env) => {
    const result = await cli(env);
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const projection = new TextDecoder().decode(result.stdout);
    assertEquals(
      projection.trim().split("\n").map((row) => row.split("=")[0]),
      [
        "LAUNCH_NOTES",
        "LAUNCH_VAULT_METADATA",
        "LAUNCH_INSTANCE_METADATA",
        "LAUNCH_HOST",
        "LAUNCH_PORT",
        "LAUNCH_PREFIX",
        "LAUNCH_HEALTH_HOST",
      ],
    );
    const shell = await command("sh", {
      args: [
        "-c",
        `${projection}\nprintf '%s\\n' "$LAUNCH_NOTES" "$LAUNCH_VAULT_METADATA" "$LAUNCH_INSTANCE_METADATA" "$LAUNCH_HOST" "$LAUNCH_PORT" "$LAUNCH_PREFIX" "$LAUNCH_HEALTH_HOST"`,
      ],
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(shell.code, 0);
    assertEquals(new TextDecoder().decode(shell.stdout).trim().split("\n"), [
      `${root}/vault's ; $(unrequested)`,
      `${root}/metadata/globnotes`,
      `${root}/metadata/_`,
      "::",
      "18765",
      "/notes",
      "globnotes.test:18765",
    ]);
    assertFalse(
      await Deno.stat(`${root}/metadata`).then(() => true).catch(() => false),
    );
    assertFalse(projection.includes("GLOBNOTES_"));
  }));
Deno.test("config launch: actual health script consumes TOML port prefix IPv6 wildcard and Host header", () =>
  fixture(async (root, env) => {
    await Deno.mkdir(`${root}/bin`);
    await Deno.writeTextFile(
      `${root}/bin/wget`,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$FIXTURE_REQUEST"\n',
    );
    await Deno.chmod(`${root}/bin/wget`, 0o755);
    const result = await command("sh", {
      cwd: ROOT,
      args: ["healthcheck.sh"],
      env: {
        ...env,
        PATH: `${root}/bin:${Deno.env.get("PATH")}`,
        FIXTURE_REQUEST: `${root}/request.txt`,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const args = await Deno.readTextFile(`${root}/request.txt`);
    assert(args.includes("http://[::1]:18765/notes/_/api/health"));
    assert(args.includes("Host: globnotes.test:18765"));
  }));
Deno.test("config launch: invalid launcher configuration stops before mkdir/chown/exec effects without values", () =>
  fixture(async (root, env) => {
    const invalid = {
      ...env,
      GLOBNOTES__INDEX_BATCHSIZE: "SECRET-INVALID",
      GLOBNOTES_UNKNOWN: "SECRET-INVALID",
    };
    const result = await command("sh", {
      cwd: ROOT,
      args: ["entrypoint.sh"],
      env: invalid,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.code !== 0);
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    assert(output.includes("index.batchsize"));
    assert(output.includes("GLOBNOTES_UNKNOWN"));
    assertFalse(output.includes("SECRET-INVALID"));
    assertFalse(
      await Deno.stat(`${root}/metadata`).then(() => true).catch(() => false),
    );
    assertEquals([...Deno.readDirSync(`${root}/vault's ; $(unrequested)`)], []);
  }));

Deno.test("config launch: recursive metadata ownership cannot include the mounted notes root", async () => {
  const root = await Deno.makeTempDir({ prefix: "config-launch-ownership-" });
  try {
    const notes = `${root}/metadata/globnotes`;
    await Deno.mkdir(notes, { recursive: true });
    // A canonical root reached through an instance metadata link also contains notes.
    await Deno.symlink("/", `${root}/metadata/_`);
    await Deno.writeTextFile(`${notes}/Note.md`, "unchanged notes\n");
    await Deno.mkdir(`${root}/bin`);
    for (
      const [name, script] of Object.entries({
        id: "#!/bin/sh\necho 0\n",
        chown: '#!/bin/sh\nprintf "%s\\n" "$@" >> "$FIXTURE_CHOWN"\n',
        executor: "#!/bin/sh\nexit 0\n",
      })
    ) {
      await Deno.writeTextFile(`${root}/bin/${name}`, script);
      await Deno.chmod(`${root}/bin/${name}`, 0o755);
    }
    const result = await command("sh", {
      cwd: ROOT,
      args: ["entrypoint.sh"],
      stdout: "piped",
      stderr: "piped",
      env: {
        GLOBNOTES_GLOBNOTES_PATH: notes,
        GLOBNOTES_METADATA_PATH: `${root}/metadata`,
        PATH: `${root}/bin:${Deno.env.get("PATH")}`,
        PUID: "1000",
        PGID: "1000",
        EXEC_TOOL: `${root}/bin/executor`,
        FIXTURE_CHOWN: `${root}/chown.log`,
      },
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertFalse(
      await Deno.stat(`${root}/chown.log`).then(() => true).catch(() => false),
    );
    assertEquals(
      await Deno.readTextFile(`${notes}/Note.md`),
      "unchanged notes\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
