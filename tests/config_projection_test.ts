// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { GlobalConfig } from "../server/config.ts";
import { loadInstanceConfig } from "../server/config/loader.ts";
import { VaultConfigStore } from "../server/config/vault.ts";
import configGet from "../server/api/endpoints/_/api/config/get.ts";
import brandPost from "../server/api/endpoints/_/api/brand/post.ts";
import { state } from "../server/state.ts";
import { restoreState } from "./helpers/state.ts";

async function fixture(
  run: (config: GlobalConfig, root: string) => void | Promise<void>,
) {
  const root = Deno.makeTempDirSync({ prefix: "config-projection-" }),
    previous = { ...state };
  try {
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
    state.config = config;
    state.auth = null;
    Reflect.deleteProperty(state, "lifecycle");
    await run(config, root);
  } finally {
    restoreState(previous);
    Deno.removeSync(root, { recursive: true });
  }
}
function request(
  fields: Record<string, string | File>,
  target?: string,
  prepare?: () => void,
): PathfinderRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return {
    _raw: new Request("http://globnotes.test/_/api/brand", { method: "POST" }),
    query: new URLSearchParams(target === undefined ? {} : { vault: target }),
    body: {
      form: () => {
        prepare?.();
        return Promise.resolve(form);
      },
    },
  } as unknown as PathfinderRequest;
}
Deno.test("config projection: no host paths, raw values or plugin pins in public config; safe per-leaf origins", () =>
  fixture((config, root) => {
    const projected = configGet(), raw = JSON.stringify(projected);
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
    assertEquals(configGet(request({}, "globnotes")).brand, projected.brand);
    assertThrows(
      () => configGet(request({}, "other")),
      HttpError,
      "HTTP 400",
    );
    assertEquals(config.brandName, "Pinned name");
  }));
Deno.test("config projection: pinned same-value writes fail before image effects; sibling TOML writes preserve auth", () =>
  fixture(async (config, root) => {
    const json = Deno.readTextFileSync(config.configPath),
      toml = Deno.readTextFileSync(`${root}/state/config.toml`);
    const error = await assertRejects(
      () =>
        brandPost(
          request({
            name: "Pinned name",
            logo: new File(["image"], "logo.svg"),
          }),
        ),
      HttpError,
      "HTTP 409",
    );
    assertEquals(error.status, 409);
    assertEquals(Deno.readTextFileSync(`${root}/state/config.toml`), toml);
    assertFalse(Deno.statSync(`${root}/state`).isFile);
    assertEquals(
      [...Deno.readDirSync(`${root}/state`)].map((entry) => entry.name).sort(),
      ["config.json", "config.toml"],
    );
    const result = await brandPost(request({ accent: "" }));
    assertEquals(result.accent, null);
    assertEquals(config.brandAccent, null);
    assertEquals(Deno.readTextFileSync(config.configPath), json);
    assertEquals(
      new VaultConfigStore("globnotes", `${root}/state/config.toml`).settings
        .brand,
      { name: "saved name", accent: "" },
    );
    assertEquals(configGet().brand, result);
  }));
Deno.test("config projection: external TOML edit during request is a conflict before files or memory change", () =>
  fixture(async (config, root) => {
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
