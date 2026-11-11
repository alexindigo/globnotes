// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { driverDeclaration, minimalDriver } from "./helpers/driver_fixture.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

async function shutdownWithLiveStream(
  options: Parameters<typeof bootServer>[1] = {},
) {
  const server = await bootServer(
    { fixtureAuth: { auth_type: "none" } },
    options,
  );
  const stream = await fetch(`${server.baseUrl}/_/api/changes`, {
    headers: { accept: "text/event-stream" },
  });
  const reader = stream.body!.getReader();
  await reader.read();
  const stopping = server.close();
  try {
    await waitUntil(
      () => server.status() ? done() : pending({ openChangeStream: true }),
      { label: "server shutdown with live browser stream" },
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    await stopping;
  }
  assertEquals(server.status()?.code, 0, "server shutdown must exit cleanly");
  assertEquals(
    server.status()?.signal,
    null,
    "SIGKILL is cleanup, not shutdown proof",
  );
  assertEquals(server.status()?.success, true);
}

Deno.test("driver composition: shutdown completes while a browser change stream is still open", () =>
  shutdownWithLiveStream());

Deno.test("driver composition: live-stream shutdown rejects forced cleanup", async () => {
  const preload = await Deno.makeTempFile({
    prefix: "ignored-stream-stop-",
    suffix: ".mjs",
  });
  try {
    await Deno.writeTextFile(
      preload,
      `
const add=Deno.addSignalListener;
Deno.addSignalListener=(signal,listener)=>add(signal,signal==='SIGTERM'?()=>{}:listener);
`,
    );
    await assertRejects(
      () => shutdownWithLiveStream({ denoArgs: ["--preload", preload] }),
      Error,
      "server shutdown must exit cleanly",
    );
  } finally {
    await Deno.remove(preload);
  }
});

Deno.test("driver API: real HTTP CRUD and keys are write-only, revision-bound and instance-scoped", async () => {
  const f = await pluginFixture();
  const marker = "http-key-canary-/+==";
  await f.install("test-driver", { driver: driverDeclaration }, {
    "driver.js": minimalDriver,
  });
  const server = await bootServer({
    GLOBNOTES_GLOBNOTES_PATH: f.vault,
    GLOBNOTES_METADATA_PATH: f.metadataBase,
    fixtureAuth: { auth_type: "none" },
  });
  const packets: string[] = [];
  async function call(method: string, route = "", body?: unknown) {
    const response = await fetch(`${server.baseUrl}/_/api/drivers${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    packets.push(text);
    if (response.ok) {
      assertEquals(response.headers.get("cache-control"), "no-store");
    }
    return { status: response.status, value: text ? JSON.parse(text) : null };
  }
  try {
    const initial = await call("GET");
    assertEquals(initial.value.instances, []);
    assert(
      initial.value.plugins.some((plugin: { id: string }) =>
        plugin.id === "test-driver"
      ),
    );
    const created = await call("POST", "", {
      plugin: "test-driver",
      label: "First",
    });
    assertEquals(created.status, 200);
    const id = created.value.id;
    const second = await call("POST", "", {
      plugin: "test-driver",
      label: "Second",
    });
    const row = (await call("GET")).value.instances.find((
      row: { id: string },
    ) => row.id === id);
    assertEquals(row.status, "off");
    assertEquals(row.secrets[0].set, false);
    const key = await call("PUT", `/${id}/secrets/token`, {
      revision: 1,
      value: marker,
    });
    assertEquals(key.status, 200);
    assertEquals(key.value.revision, 2);
    assertEquals(key.value.secrets[0].set, true);
    assertEquals(
      (await call("PUT", `/${id}/secrets/token`, {
        revision: 1,
        value: "stale",
      })).status,
      409,
    );
    assertEquals(
      (await call("PUT", `/${id}/secrets/other`, {
        revision: 2,
        value: "unknown",
      })).status,
      404,
    );
    assertEquals(
      (await call("PUT", `/other-vault/secrets/token`, {
        revision: 2,
        value: "unknown",
      })).status,
      404,
    );
    const enabled = await call("PUT", `/${id}`, {
      revision: 2,
      label: "First",
      settings: { prefix: "" },
      enabled: true,
    });
    assertEquals(enabled.status, 200);
    assertEquals(enabled.value.revision, 3);
    const active = (await call("GET")).value.instances;
    assertEquals(
      active.find((row: { id: string }) => row.id === id).status,
      "active",
    );
    assertEquals(
      active.find((row: { id: string }) => row.id === second.value.id)
        .secrets[0].set,
      false,
    );
    assertEquals(
      (await call("POST", `/${id}/sync`, { revision: 2 })).status,
      409,
    );
    assertEquals(
      (await call("POST", `/${id}/sync`, { revision: 3 })).status,
      200,
    );
    assertEquals(
      (await call("PUT", `/${id}`, {
        revision: 3,
        label: "First",
        settings: { unexpected: true },
        enabled: true,
      })).status,
      422,
    );
    assertEquals(
      (await call("POST", `/${id}/decisions`, {
        instanceRevision: 3,
        attentionRevision: 1,
        action: "remote_empty_delete",
      })).status,
      409,
    );
    const getKey = await fetch(
      `${server.baseUrl}/_/api/drivers/${id}/secrets/token`,
    );
    packets.push(await getKey.text());
    assert(!getKey.ok);
    assertEquals(
      (await call("DELETE", `/${id}/secrets/token`, { revision: 3 })).status,
      200,
    );
    assertEquals(
      (await call("GET")).value.instances.find((row: { id: string }) =>
        row.id === id
      ).status,
      "locked",
    );
    await call("PUT", `/${id}/secrets/token`, { revision: 4, value: marker });
    const data = new TextDecoder().decode(
      Deno.readFileSync(`${f.statePath}/driver-secrets.sqlite`),
    );
    assert(data.includes(marker));
    assertEquals((await call("DELETE", `/${id}`, { revision: 5 })).status, 200);
    assertEquals(
      (await call("POST", `/${id}/sync`, { revision: 5 })).status,
      404,
    );
    assert(
      !new TextDecoder().decode(
        Deno.readFileSync(`${f.statePath}/driver-secrets.sqlite`),
      ).includes(marker),
    );
    assert(packets.every((packet) => !packet.includes(marker)));
    assert(!JSON.stringify(server.logs()).includes(marker));
    for (const name of ["hub.sqlite", "hub.sqlite-wal"]) {
      try {
        assert(
          !new TextDecoder().decode(Deno.readFileSync(`${f.statePath}/${name}`))
            .includes(marker),
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    assertEquals([...Deno.readDirSync(f.vault)], []);
  } finally {
    await server.close();
    await f.dispose();
  }
});

for (const settings of ["true", "false"]) {
  Deno.test(`driver API: ${settings === "true" ? "settings lock" : "read-only vault"} refuses every instance mutation`, async () => {
    const f = await pluginFixture();
    await f.install("test-driver", { driver: driverDeclaration }, {
      "driver.js": minimalDriver,
    });
    const server = await bootServer({
      GLOBNOTES_GLOBNOTES_PATH: f.vault,
      GLOBNOTES_METADATA_PATH: f.metadataBase,
      fixtureAuth: {
        auth_type: settings === "true" ? "none" : "read_only",
        read_only_settings: settings === "true",
      },
    });
    try {
      const read = await fetch(`${server.baseUrl}/_/api/drivers`);
      assertEquals(read.status, 200);
      await read.body?.cancel();
      for (
        const [method, route, body] of [
          ["POST", "", { plugin: "test-driver", label: "denied" }],
          ["PUT", "/uncreated", {
            revision: 1,
            label: "denied",
            settings: {},
            enabled: true,
          }],
          ["DELETE", "/uncreated", { revision: 1 }],
          ["PUT", "/uncreated/secrets/token", { revision: 1, value: "denied" }],
          ["DELETE", "/uncreated/secrets/token", { revision: 1 }],
          ["POST", "/uncreated/sync", { revision: 1 }],
          ["POST", "/uncreated/decisions", {
            instanceRevision: 1,
            attentionRevision: 1,
            action: "held_restore",
          }],
        ] as const
      ) {
        const response = await fetch(
          `${server.baseUrl}/_/api/drivers${route}`,
          {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        assertEquals(response.status, 403);
        await response.body?.cancel();
      }
    } finally {
      await server.close();
      await f.dispose();
    }
  });
}
