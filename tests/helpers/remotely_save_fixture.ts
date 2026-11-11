// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { bootServer } from "./boot.ts";
import { pluginFixture } from "./plugin_fixture.ts";

export const remotelySaveSource = new URL(
  "../../plugins/globnotes-remotely-save/",
  import.meta.url,
);

/** Installs the unmodified production plugin and uses ordinary HTTP controls.
 * Permissions are explicitly approved by this fixture, never by the driver. */
export async function remotelySaveServerFixture(authorities: string[]) {
  const fixture = await pluginFixture();
  const declaration = JSON.parse(
    await Deno.readTextFile(new URL("manifest.json", remotelySaveSource)),
  );
  const files: Record<string, string> = {};
  for (const entry of Deno.readDirSync(remotelySaveSource)) {
    if (entry.isFile && entry.name.endsWith(".js")) {
      files[entry.name] = await Deno.readTextFile(
        new URL(entry.name, remotelySaveSource),
      );
    }
  }
  await fixture.install(declaration.id, declaration, files);
  const env = {
    GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES_METADATA_PATH: fixture.metadataBase,
    fixtureAuth: { auth_type: "none" },
    GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE: "false",
  };
  let server = await bootServer(env);
  const packets: string[] = [], logs: string[] = [];
  async function call(route: string, method = "GET", body?: unknown) {
    const response = await fetch(`${server.baseUrl}/_/api/${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    packets.push(text);
    assert(response.ok, `${method} ${route}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
  const one = async (id: string) =>
    (await call("drivers")).instances.find((row: { id: string }) =>
      row.id === id
    );
  async function configure(id: string, changes: Record<string, unknown>) {
    const before = await one(id);
    return await call(`drivers/${id}`, "PUT", {
      revision: before.revision,
      label: before.label,
      settings: before.settings,
      enabled: before.enabled,
      ...changes,
    });
  }
  async function key(id: string, name: string, value?: string) {
    return await call(
      `drivers/${id}/secrets/${name}`,
      value === undefined ? "DELETE" : "PUT",
      {
        revision: (await one(id)).revision,
        ...(value === undefined ? {} : { value }),
      },
    );
  }
  const catalog = await call("plugin-host");
  await call(`plugin-host/${declaration.id}/enabled`, "PUT", {
    enabled: true,
    revision: catalog.policy.revision,
    signature: catalog.policy.signature,
  });
  const permission = await call(`plugin-host/${declaration.id}/permissions`);
  await call(`plugin-host/${declaration.id}/permissions`, "PUT", {
    revision: permission.revision,
    signature: permission.signature,
    requestSourceKey: permission.requestSourceKey,
    requestSourceRevision: permission.requestSourceRevision,
    allowNetwork: true,
    approvedNetwork: authorities.map((authority) => ({
      type: "host",
      authority,
    })),
    approvedImports: [],
  });
  return {
    ...fixture,
    call,
    one,
    configure,
    key,
    packets,
    logs: () => logs.join("\n") + server.output.stdout + server.output.stderr,
    metadata(sql: string) {
      const db = new DatabaseSync(`${fixture.statePath}/hub.sqlite`, {
        readOnly: true,
      });
      try {
        return db.prepare(sql).all();
      } finally {
        db.close();
      }
    },
    async add(
      settings: Record<string, unknown>,
      keys: Record<string, string>,
      label = "Remotely Save",
    ) {
      const created = await call("drivers", "POST", {
        plugin: declaration.id,
        label,
        settings,
      });
      assertEquals((await one(created.id)).enabled, false);
      for (const [name, value] of Object.entries(keys)) {
        await key(created.id, name, value);
      }
      await configure(created.id, { enabled: true });
      return created.id as string;
    },
    async sync(id: string) {
      await call(`drivers/${id}/sync`, "POST", {
        revision: (await one(id)).revision,
      });
      return await one(id);
    },
    async decide(id: string, action: string, paths?: string[]) {
      const row = await one(id);
      await call(`drivers/${id}/decisions`, "POST", {
        instanceRevision: row.revision,
        attentionRevision: row.attention.revision,
        action,
        ...(paths ? { paths } : {}),
      });
      return await one(id);
    },
    async restart() {
      await server.close();
      logs.push(server.output.stdout, server.output.stderr);
      server = await bootServer(env);
    },
    async close() {
      await server.close();
      await fixture.dispose();
    },
  };
}
