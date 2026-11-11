// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  config,
  ConfigError,
  defaultsPath,
  envName,
  get,
  isTree,
  leaves,
  loadInstanceConfig,
  parseEnv,
  resetConfigForTests,
  setConfigForTests,
  type Sources,
} from "../server/config/loader.ts";
import { INSTANCE_SCHEMA, type Tree } from "../server/config/schema.ts";
import { SERVER_PORT_ENV } from "./helpers/boot.ts";

function fixture(run: (root: string) => void): void {
  const root = Deno.makeTempDirSync({ prefix: "layered-config-" });
  try {
    run(root);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}
function load(env: Record<string, string> = {}) {
  return loadInstanceConfig({ env, overlayPath: null });
}

Deno.test("layered config: sections are plain records, not dates or object instances", () => {
  assert(isTree({}));
  assert(isTree(Object.create(null)));
  class Section {}
  for (
    const value of [
      new Date(),
      new Map(),
      new Set(),
      new Section(),
      /section/,
      new Uint8Array(),
      [],
      null,
    ]
  ) {
    assertFalse(isTree(value));
  }
});

Deno.test("layered config: a TOML date at a section key reports a section error", () =>
  fixture((root) => {
    const file = `${root}/section.toml`;
    for (const value of ["2026-11-12", "2026-11-12T03:00:00Z"]) {
      Deno.writeTextFileSync(file, `server = ${value}\n`);
      const error = assertThrows(
        () => loadInstanceConfig({ overlayPath: file, env: {} }),
        ConfigError,
      );
      assertStringIncludes(
        error.message,
        "server (GLOBNOTES__SERVER): expected section, not a value",
      );
    }
  }));

Deno.test("layered config: allowed hosts reject blank list members but preserve explicit unrestricted lists", () =>
  fixture((root) => {
    const file = `${root}/hosts.toml`;
    for (
      const entries of [[""], [" "], [", "], [","], [",", ","], ["", " "], [
        "globnotes.home",
        "",
      ]]
    ) {
      Deno.writeTextFileSync(
        file,
        `[server]\nallowedhosts=${JSON.stringify(entries)}\n`,
      );
      const error = assertThrows(
        () => loadInstanceConfig({ overlayPath: file, env: {} }),
        ConfigError,
      );
      assertStringIncludes(error.message, "server.allowedhosts");
    }
    for (const raw of [",", " ", " , ", "globnotes.home,", ",globnotes.home"]) {
      const error = assertThrows(
        () => load({ GLOBNOTES__SERVER_ALLOWEDHOSTS: raw }),
        ConfigError,
      );
      assertStringIncludes(error.message, "GLOBNOTES__SERVER_ALLOWEDHOSTS");
    }
    Deno.writeTextFileSync(file, "[server]\nallowedhosts=[]\n");
    assertEquals(
      loadInstanceConfig({ overlayPath: file, env: {} }).config.server
        .allowedhosts,
      [],
    );
    assertEquals(
      load({ GLOBNOTES__SERVER_ALLOWEDHOSTS: "" }).config.server.allowedhosts,
      [],
    );
    assertEquals(
      load({ GLOBNOTES__SERVER_ALLOWEDHOSTS: " globnotes.home , nas.home " })
        .config.server.allowedhosts,
      ["globnotes.home", "nas.home"],
    );
  }));

Deno.test("layered config: complete shipped defaults and immutable provenance", () => {
  const result = load();
  assertEquals(result.config.server.port, 8080);
  assertEquals(result.config.index.batchdelay, 0.1);
  assertEquals(result.config.mcp.ratelimit, 600);
  for (const [key] of leaves(INSTANCE_SCHEMA)) {
    assert(get(result.config as unknown as Tree, key) !== undefined, key);
    assertEquals(result.provenance[key], {
      layer: "defaults",
      source: defaultsPath,
      pinned: false,
    });
  }
  assert(Object.isFrozen(result.config.server));
  assert(Object.isFrozen(result.provenance));
});

Deno.test("layered config: defaults then partial TOML then env, including false zero and empties", () =>
  fixture((root) => {
    const file = `${root}/operator.toml`;
    Deno.writeTextFileSync(
      file,
      '[server]\nport=1234\nhost="192.0.2.1"\nallowedhosts=["globnotes.home"]\npathprefix="/notes"\n[mcp]\nenabled=true\nratelimit=12\n',
    );
    const result = loadInstanceConfig({
      overlayPath: file,
      env: {
        [SERVER_PORT_ENV]: "0",
        GLOBNOTES__SERVER_PATHPREFIX: "",
        GLOBNOTES__SERVER_ALLOWEDHOSTS: "",
        GLOBNOTES__MCP_ENABLED: "false",
        GLOBNOTES__MCP_RATELIMIT: "0",
        GLOBNOTES__INDEX_SCANCACHETTL: "0.25",
      },
    });
    assertEquals(result.config.server, {
      host: "192.0.2.1",
      port: 0,
      pathprefix: "",
      allowedhosts: [],
    });
    assertEquals(result.config.mcp, { enabled: false, ratelimit: 0 });
    assertEquals(result.config.index.scancachettl, 0.25);
    assertEquals(result.config.index.batchsize, 200);
    assertEquals(result.provenance["server.host"].layer, "toml");
    assertEquals(
      result.provenance["server.port"].source,
      SERVER_PORT_ENV,
    );
    assertEquals(result.loaded, [defaultsPath, file]);
  }));

Deno.test("layered config: explicit file selection replaces the conventional overlay", () =>
  fixture((root) => {
    const selected = `${root}/selected.toml`;
    Deno.writeTextFileSync(selected, "[server]\nport=9000");
    const result = loadInstanceConfig({
      overlayPath: `${root}/other.toml`,
      env: { GLOBNOTES_CONFIG: selected },
    });
    assertEquals(result.config.server.port, 9000);
    assertEquals(result.loaded, [defaultsPath, selected]);
  }));

Deno.test("layered config: only conventional NotFound is skipped", () =>
  fixture((root) => {
    assertEquals(
      loadInstanceConfig({ overlayPath: `${root}/absent`, env: {} }).loaded,
      [defaultsPath],
    );
    const sources: Sources[] = [
      { defaultsPath: `${root}/absent`, env: {} },
      { env: { GLOBNOTES_CONFIG: `${root}/absent` } },
      { env: { GLOBNOTES_CONFIG: "" } },
    ];
    for (const source of sources) {
      assertThrows(() => loadInstanceConfig(source), ConfigError);
    }
    const error = assertThrows(
      () => loadInstanceConfig({ overlayPath: root, env: {} }),
      ConfigError,
    );
    assertStringIncludes(error.message, "cannot read configuration file");
  }));

Deno.test("layered config: missing defaults fail even when TOML and env supply the leaf", () =>
  fixture((root) => {
    const missing = `${root}/defaults.toml`, overlay = `${root}/operator.toml`;
    Deno.writeTextFileSync(
      missing,
      Deno.readTextFileSync(defaultsPath).replace("port = 8080", ""),
    );
    Deno.writeTextFileSync(overlay, "[server]\nport=9000");
    const error = assertThrows(
      () =>
        loadInstanceConfig({
          defaultsPath: missing,
          overlayPath: overlay,
          env: { [SERVER_PORT_ENV]: "1234" },
        }),
      ConfigError,
    );
    assertStringIncludes(
      error.message,
      `server.port (${SERVER_PORT_ENV}): missing default leaf`,
    );
  }));

Deno.test("layered config: aggregate shape type range and unknown errors without values", () =>
  fixture((root) => {
    const file = `${root}/bad.toml`, secret = "NEVER_PRINT_SECRET_8472";
    Deno.writeTextFileSync(
      file,
      `server="${secret}"\n[extra]\nkey="${secret}"\n[index]\nbatchsize="${secret}"\n`,
    );
    const error = assertThrows(
      () =>
        loadInstanceConfig({
          overlayPath: file,
          env: {
            [SERVER_PORT_ENV]: "65536",
            GLOBNOTES__MCP_ENABLED: "yes",
            GLOBNOTES__INDEX_BATCHDELAY: "NaN",
            GLOBNOTES__SERVER: secret,
            GLOBNOTES_OLD: secret,
          },
        }),
      ConfigError,
    );
    for (
      const key of [
        "server",
        "extra",
        "index.batchsize",
        SERVER_PORT_ENV,
        "GLOBNOTES__MCP_ENABLED",
        "GLOBNOTES__INDEX_BATCHDELAY",
        "GLOBNOTES__SERVER",
        "GLOBNOTES_OLD",
      ]
    ) assertStringIncludes(error.message, key);
    assertFalse(error.message.includes(secret));
    assert(error.problems.length >= 8);
  }));

Deno.test("layered config: malformed TOML parser does not quote a secret line", () =>
  fixture((root) => {
    const file = `${root}/bad.toml`, secret = "NEVER_PRINT_TOML_632";
    Deno.writeTextFileSync(file, `[server]\nport = ${secret}\n`);
    const error = assertThrows(
      () => loadInstanceConfig({ overlayPath: file, env: {} }),
      ConfigError,
    );
    assertStringIncludes(error.message, "invalid TOML");
    assertFalse(error.message.includes(secret));
  }));

Deno.test("layered config: strict numeric boolean list and TOML types", () =>
  fixture((root) => {
    for (const raw of ["true", "false"]) {
      assertEquals(parseEnv(raw, { type: "boolean" }), raw === "true");
    }
    for (const raw of ["TRUE", "0", "1", "", " true"]) {
      assertEquals(parseEnv(raw, { type: "boolean" }), undefined);
    }
    for (const raw of ["1.1", "1e2", "9007199254740992", "", "Infinity"]) {
      assertEquals(parseEnv(raw, { type: "integer" }), undefined);
    }
    for (const raw of ["NaN", "Infinity", "1e999", "", " ", "0xff"]) {
      assertEquals(parseEnv(raw, { type: "number" }), undefined);
    }
    assertEquals(parseEnv("", { type: "list" }), []);
    assertEquals(parseEnv("a, b", { type: "list" }), ["a", "b"]);
    for (
      const content of [
        '[server]\nport="8080"',
        '[mcp]\nenabled="false"',
        "[server.port]\nfoo=1",
        "[server]\nallowedhosts=[1]",
      ]
    ) {
      const file = `${root}/bad.toml`;
      Deno.writeTextFileSync(file, content);
      assertThrows(
        () => loadInstanceConfig({ overlayPath: file, env: {} }),
        ConfigError,
      );
    }
  }));

Deno.test("layered config: metadata special spelling and build envelope only", () => {
  assertEquals(envName("metadata.path"), "GLOBNOTES_METADATA_PATH");
  assertEquals(
    load({ GLOBNOTES_METADATA_PATH: "/etc/globnotes", GLOBNOTES_REVISION: "" })
      .config.metadata.path,
    "/etc/globnotes",
  );
  for (
    const name of [
      "GLOBNOTES__METADATA_PATH",
      "GLOBNOTES__METADATA_BASEPATH",
      "GLOBNOTES_PORT",
      "GLOBNOTES_TEST_HOST",
      "GLOBNOTES_READ_ONLY_SETTINGS",
      "GLOBNOTES_PLUGIN_SETTINGS",
    ]
  ) assertThrows(() => load({ [name]: "value" }), ConfigError);
});

Deno.test("layered config: test seam uses shipped baselines and validates overrides", () => {
  try {
    setConfigForTests({ server: { port: 4321 }, mcp: { enabled: false } });
    assertEquals(config().server.port, 4321);
    assertEquals(config().server.host, "0.0.0.0");
    assertEquals(config().mcp.enabled, false);
    assertThrows(
      () => setConfigForTests({ server: { port: -1 } }),
      ConfigError,
    );
  } finally {
    resetConfigForTests();
  }
});

Deno.test("layered config: inherited object names are unknown schema keys", () =>
  fixture((root) => {
    const file = `${root}/operator.toml`;
    for (const key of ["constructor", "toString", "__proto__"]) {
      Deno.writeTextFileSync(file, `[${key}]\nport=1234\n`);
      const error = assertThrows(
        () => loadInstanceConfig({ overlayPath: file, env: {} }),
        ConfigError,
      );
      assertStringIncludes(error.message, `${key} (`);
    }
  }));
