// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { decodeJwt } from "jose";
import { LocalAuth } from "../server/auth/local.ts";
import { GlobalConfig } from "../server/config.ts";
import { serviceSettings } from "../server/config/consumers.ts";
import { loadInstanceConfig } from "../server/config/loader.ts";
import { legacyServiceSettings } from "../server/config/legacy.ts";
import { VaultHub } from "../server/hub/hub.ts";
import { initializeLogger, logger } from "../server/logger.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { state } from "../server/state.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { awaitIndexReady, restoreState, setupState } from "./helpers/state.ts";
import { command } from "./helpers/process.ts";

Deno.test("config consumers: pre-initialization diagnostics are plain stderr, never machine stdout", async () => {
  const script = `import { logger } from ${
    JSON.stringify(new URL("../server/logger.ts", import.meta.url).href)
  }; logger.debug("configuration diagnostic"); logger.error("configuration error"); console.log("machine-only");`;
  const result = await command(Deno.execPath(), {
    args: ["eval", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 0);
  assertEquals(new TextDecoder().decode(result.stdout).trim(), "machine-only");
  assertEquals(
    new TextDecoder().decode(result.stderr).trim(),
    "configuration diagnostic\nconfiguration error",
  );
});

function configured(env: Record<string, string> = {}) {
  return serviceSettings(loadInstanceConfig({ overlayPath: null, env }).config);
}

Deno.test("config consumers: fractional scan TTL reaches the real directory cache", () => {
  const root = Deno.makeTempDirSync({ prefix: "config-consumer-cache-" });
  const original = performance.now;
  let clock = 1000;
  try {
    performance.now = () => clock;
    Deno.writeTextFileSync(`${root}/a.md`, "alpha");
    const notes = new FileSystemNotes(
      root,
      {},
      configured({ GLOBNOTES__INDEX_SCANCACHETTL: "0.25" }).notes,
    );
    assertEquals(notes.listAllNoteFilenames(), ["a.md"]);
    Deno.writeTextFileSync(`${root}/b.md`, "bravo");
    clock = 1249;
    assertEquals(notes.listAllNoteFilenames(), ["a.md"]);
    clock = 1250;
    assertEquals(notes.listAllNoteFilenames().sort(), ["a.md", "b.md"]);
  } finally {
    performance.now = original;
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("config consumers: typed batch size and fractional pacing reach the FTS consumer", async () => {
  const root = Deno.makeTempDirSync({ prefix: "config-consumer-index-" }),
    previous = { ...state };
  let fixture: ReturnType<typeof setupState> | undefined;
  try {
    for (const name of ["a", "b", "c"]) {
      Deno.writeTextFileSync(`${root}/${name}.md`, `# ${name}`);
    }
    fixture = setupState(root);
    const paced: number[] = [];
    const index = new Fts5Indexer(
      `${root}/typed-index`,
      configured({
        GLOBNOTES__INDEX_BATCHSIZE: "2",
        GLOBNOTES__INDEX_BATCHDELAY: "0.125",
      }).index,
      {
        pace: (ms) => {
          paced.push(ms);
          return Promise.resolve();
        },
      },
    );
    state.indexer = index;
    index.startBackgroundSync();
    await awaitIndexReady(index);
    assertEquals(paced, [125, 125]);
    assertEquals(index.titlesFor(["a.md", "b.md", "c.md"]), {
      "a.md": "a",
      "b.md": "b",
      "c.md": "c",
    });
  } finally {
    fixture?.hub.stop();
    restoreState(previous);
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("config consumers: typed scan interval reaches the hub's actual timer", () => {
  const root = Deno.makeTempDirSync({ prefix: "config-consumer-hub-" }),
    original = globalThis.setInterval;
  const delays: (number | undefined)[] = [];
  let hub: VaultHub | undefined;
  try {
    globalThis.setInterval = (...args: Parameters<typeof original>) => {
      delays.push(args[1]);
      return original(...args);
    };
    hub = new VaultHub(
      root,
      `${root}/.globnotes`,
      configured({ GLOBNOTES__HUB_SCANINTERVAL: "1.25" }).hub,
    );
    hub.start();
    assertEquals(delays, [1250]);
  } finally {
    globalThis.setInterval = original;
    hub?.stop();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("config consumers: session expiry reaches the signed JWT, independent of legacy expiry", async () => {
  const root = Deno.makeTempDirSync({ prefix: "config-consumer-auth-" });
  try {
    const config = new GlobalConfig(testEnvironment({
      GLOBNOTES_PATH: root,
      GLOBNOTES_AUTH_TYPE: "password",
      GLOBNOTES_USERNAME: "owner",
      GLOBNOTES_PASSWORD: "fixture password",
      GLOBNOTES_SECRET_KEY: "fixture signing material",
      GLOBNOTES_SESSION_EXPIRY_DAYS: "10",
    }));
    const auth = new LocalAuth(
      config,
      configured({ GLOBNOTES__SESSIONS_EXPIRYDAYS: "2" }).sessions,
    );
    const before = Math.floor(Date.now() / 1000);
    const token = await auth.login({
      username: "owner",
      password: "fixture password",
    });
    const payload = decodeJwt(token.access_token);
    const after = Math.floor(Date.now() / 1000);
    assert(payload.exp! >= before + 172800 && payload.exp! <= after + 172800);
    assertEquals(
      (await auth.validateTokenMetadata(token.access_token)).expiresAt,
      payload.exp! * 1000,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("config consumers: temporary compatibility adapter retains old injected input behavior", () => {
  const settings = legacyServiceSettings(testEnvironment({
    GLOBNOTES_SCAN_CACHE_TTL: "0.5",
    GLOBNOTES_INDEX_BATCH_SIZE: "7",
    GLOBNOTES_INDEX_BATCH_DELAY: "0.25",
    GLOBNOTES_HUB_SCAN_INTERVAL: "1.5",
    GLOBNOTES_SESSION_EXPIRY_DAYS: "3",
  }));
  assertEquals(settings, {
    notes: { scanCacheTtlMs: 500 },
    index: { batchSize: 7, batchDelayMs: 250 },
    hub: { scanIntervalMs: 1500 },
    sessions: { expirySeconds: 259200 },
  });
  assert(Object.isFrozen(settings.notes));
  assert(
    Deno.readTextFileSync(new URL("../Dockerfile", import.meta.url)).includes(
      "COPY defaults ./defaults",
    ),
  );
});

Deno.test("config consumers: logger uses explicit validated level without an env read", () => {
  const original = console.log, messages: unknown[][] = [];
  try {
    console.log = (...args) => {
      messages.push(args);
    };
    initializeLogger("ERROR");
    logger.info("filtered");
    assertEquals(messages, []);
    initializeLogger("DEBUG");
    logger.info("visible");
    assertEquals(messages.length, 1);
    assertThrows(() => initializeLogger("invalid"));
  } finally {
    console.log = original;
    initializeLogger("INFO");
  }
});
