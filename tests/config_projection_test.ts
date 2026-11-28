// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import {
  type Context,
  HttpError,
  type PathfinderRequest,
} from "@pathfinder/pathfinder";
import { GlobalConfig } from "../server/config.ts";
import { loadInstanceConfig } from "../server/config/loader.ts";
import { VaultConfigStore } from "../server/config/vault.ts";
import { serviceSettings } from "../server/config/consumers.ts";
import configGet from "../server/api/endpoints/_/api/config/get.ts";
import brandPost from "../server/api/endpoints/_/api/brand/post.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { state } from "../server/state.ts";
import { installFixtureState } from "./helpers/state.ts";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { openFixtureIdentity } from "./helpers/identity_fixture.ts";
import { publicScenario } from "./helpers/fixture_scenarios.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { createUuid } from "../shared/uuid.ts";

async function fixture(
  run: (
    config: GlobalConfig,
    root: string,
    admin: string,
  ) => void | Promise<void>,
) {
  await fixtureScope(async (scope) => {
    const root = (await scope.acquire(
      () => Deno.makeTempDirSync({ prefix: "config-projection-" }),
      (path) => Deno.removeSync(path, { recursive: true }),
    )).value;
    Deno.mkdirSync(`${root}/state`);
    Deno.writeTextFileSync(
      `${root}/state/config.json`,
      JSON.stringify({ auth_type: "none", unrelated: "retain-auth-record" }),
    );
    Deno.writeTextFileSync(
      `${root}/state/config.toml`,
      '[brand]\nname="saved name"\naccent="#aabbcc"\n[plugins]\nsettings=\'{"secret-plugin":{"page":{"secret":"DO-NOT-EXPOSE"}}}\'\n',
    );
    const config = new GlobalConfig({
      instance: loadInstanceConfig({ overlayPath: null, env: {} }).config,
      notesPath: root,
      statePath: `${root}/state`,
      instancePath: `${root}/instance`,
      vault: new VaultConfigStore("globnotes", `${root}/state/config.toml`, {
        env: { GLOBNOTES_GLOBNOTES_BRAND_NAME: "Pinned name" },
      }),
    });
    const identity = await openFixtureIdentity(
      scope,
      config,
      publicScenario().identity,
      () => state.plugins!,
    );
    const notes = new FileSystemNotes(
      root,
      {},
      serviceSettings(config.resolved.instance).notes,
    );
    installFixtureState(
      scope.defer,
      config,
      identity,
      notes,
      null,
      new FileServing(root),
    );
    const admin = await signIn(identity.sessions, {
      username: "alice",
      password: "password",
    });
    await run(config, root, admin.access_token);
  });
}
function request(
  fields: Record<string, string | File>,
  target?: string,
  prepare?: () => void,
  token?: string,
): PathfinderRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return {
    _raw: new Request("http://globnotes.test/_/api/brand", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    query: new URLSearchParams(target === undefined ? {} : { vault: target }),
    body: {
      form: () => {
        prepare?.();
        return Promise.resolve(form);
      },
    },
  } as unknown as PathfinderRequest;
}
Deno.test("branding: a committed receipt survives Admin demotion without the brand projection", () =>
  fixture(async (config, _root, admin) => {
    const req = request({ accent: "#778899" }, undefined, undefined, admin);
    const identity = state.identity!;
    const identityLease = await identity.composition.auth.lease(
      req._raw,
      "manageVault",
    );
    const response = await brandPost(
      req,
      { state: { identityLease } } as Context,
    );
    assertEquals(config.brandAccent, "#778899");
    const acl = identity.composition.vault.acl;
    acl.save({ everybody: "view", grants: {} }, acl.capture(), {
      updateId: createUuid(),
      actorId: null,
    });
    assertEquals([response.status, await response.json()], [200, {
      committed: true,
    }]);
    assertEquals(config.brandAccent, "#778899");
  }));
Deno.test("config projection: no host paths, raw values or plugin pins in public config; safe per-leaf origins", () =>
  fixture(async (config, root, admin) => {
    const projected =
      await (await configGet(request({}, undefined, undefined, admin))).json();
    const raw = JSON.stringify(projected);
    for (
      const privateValue of [
        root,
        "config.toml",
        "DO-NOT-EXPOSE",
        "secret-plugin",
        "notesPath",
      ]
    ) assertFalse(raw.includes(privateValue));
    assertEquals(projected.brand, {
      name: "Pinned name",
      accent: "#aabbcc",
      files: [],
      fields: {
        name: { source: "environment", readonly: true },
        accent: { source: "toml", readonly: false },
      },
    });
    assertEquals(
      (projected.provenance as Record<string, unknown>)["brand.name"],
      { layer: "env", pinned: true },
    );
    assertEquals(
      (await (await configGet(request({}, "globnotes"))).json()).brand,
      projected.brand,
    );
    await assertRejects(
      () => configGet(request({}, "other")),
      HttpError,
      "HTTP 400",
    );
    assertEquals(config.brandName, "Pinned name");
  }));
Deno.test("config projection: pinned same-value writes fail before image effects; sibling TOML writes preserve identity and legacy bytes", () =>
  fixture(async (config, root, admin) => {
    const legacy = `${root}/state/config.json`;
    const accounts = `${root}/instance/accounts.json`;
    const json = Deno.readTextFileSync(legacy),
      accountBytes = Deno.readTextFileSync(accounts),
      toml = Deno.readTextFileSync(`${root}/state/config.toml`);
    const filesBefore = [...Deno.readDirSync(`${root}/state`)].map((entry) =>
      entry.name
    ).sort();
    const error = await assertRejects(
      () =>
        brandPost(
          request(
            {
              name: "Pinned name",
              logo: new File(["image"], "logo.svg"),
            },
            undefined,
            undefined,
            admin,
          ),
        ),
      HttpError,
      "HTTP 409",
    );
    assertEquals(error.status, 409);
    assertEquals(Deno.readTextFileSync(`${root}/state/config.toml`), toml);
    assertFalse(Deno.statSync(`${root}/state`).isFile);
    assertEquals(
      [...Deno.readDirSync(`${root}/state`)].map((entry) => entry.name).sort(),
      filesBefore,
    );
    const response = await brandPost(
      request({ accent: "" }, undefined, undefined, admin),
    );
    assertEquals(response.status, 200);
    const result = await response.json();
    assertEquals(result.accent, null);
    assertEquals(config.brandAccent, null);
    assertEquals(Deno.readTextFileSync(legacy), json);
    assertEquals(Deno.readTextFileSync(accounts), accountBytes);
    assertEquals(
      new VaultConfigStore("globnotes", `${root}/state/config.toml`).settings
        .brand,
      { name: "saved name", accent: "" },
    );
    assertEquals((await (await configGet(request({}))).json()).brand, result);
  }));
Deno.test("config projection: external TOML edit during request is a conflict before files or memory change", () =>
  fixture(async (config, root, admin) => {
    await assertRejects(
      () =>
        brandPost(
          request(
            { accent: "#112233", icon: new File(["image"], "icon.svg") },
            undefined,
            () =>
              Deno.writeTextFileSync(
                `${root}/state/config.toml`,
                '[brand]\naccent="#ffffff"',
              ),
            admin,
          ),
        ),
      HttpError,
      "HTTP 409",
    );
    assertEquals(config.brandAccent, "#aabbcc");
    assert(
      Deno.readTextFileSync(`${root}/state/config.toml`).includes("#ffffff"),
    );
    await assertRejects(
      () => brandPost(request({}, "not-globnotes")),
      HttpError,
      "HTTP 400",
    );
  }));
