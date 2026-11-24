// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { parse } from "@std/toml";
import {
  BoundFileStore,
  StoredConfigConflict,
} from "../server/config/file_store.ts";
import { VaultConfigStore } from "../server/config/vault.ts";
import { withFixtureDirectory } from "./helpers/fixture_layout.ts";
import { bootServer } from "./helpers/boot.ts";
import { publicScenario } from "./helpers/fixture_scenarios.ts";
import { createUuid } from "../shared/uuid.ts";

const initial = '[brand]\nname="original"\naccent="#aabbcc"\n';
const changes = { brand: { name: "published" } };
const store = (path: string) => new VaultConfigStore("globnotes", path);
function residue(directory: string) {
  return [...Deno.readDirSync(directory)].map(({ name }) => name).filter((
    name,
  ) => name.startsWith(".config-"));
}
function tree(root: string) {
  const directory = `${root}/deployment`;
  Deno.mkdirSync(directory);
  Deno.mkdirSync(`${root}/state`);
  const target = `${directory}/config.toml`, link = `${root}/state/config.toml`;
  Deno.writeTextFileSync(target, initial);
  return { directory, target, link };
}

for (const absolute of [false, true]) {
  Deno.test(`R07: ${absolute ? "absolute" : "relative"} TOML link retains identity, persists and reopens`, () =>
    withFixtureDirectory((root) => {
      const { directory, target, link } = tree(root);
      const text = absolute ? target : "../deployment/config.toml";
      Deno.symlinkSync(text, link);
      const ino = Deno.lstatSync(link).ino;
      store(link).save(changes);
      assertEquals([
        Deno.lstatSync(link).isSymlink,
        Deno.lstatSync(link).ino,
        Deno.readLinkSync(link),
      ], [true, ino, text]);
      assertEquals(parse(Deno.readTextFileSync(target)), {
        brand: { name: "published", accent: "#aabbcc" },
      });
      assertEquals(store(link).settings.brand.name, "published");
      assertEquals(residue(directory), []);
    }));
}

for (const fault of ["capture", "cleanup"] as const) {
  Deno.test(`TOML publication survives post-publication ${fault} and permits a following save`, () =>
    withFixtureDirectory((root) => {
      const filename = `${root}/config.toml`, config = store(filename);
      const link = Deno.linkSync,
        remove = Deno.removeSync,
        capture = BoundFileStore.prototype.capture;
      let published = false, exercised = false;
      try {
        Deno.linkSync = (from, to) => {
          link(from, to);
          published ||= String(to) === filename;
        };
        Deno.removeSync = (path, options) => {
          if (
            published && fault === "cleanup" &&
            String(path).includes("/.config-")
          ) {
            exercised = true;
            throw new Deno.errors.PermissionDenied("post-publication cleanup");
          }
          remove(path, options);
        };
        BoundFileStore.prototype.capture = function () {
          if (published && fault === "capture") {
            exercised = true;
            throw new Deno.errors.PermissionDenied("post-publication capture");
          }
          return capture.call(this);
        };
        config.save(changes);
        assertEquals([
          published,
          config.settings.brand.name,
          parse(Deno.readTextFileSync(filename)),
        ], [true, "published", changes]);
      } finally {
        Deno.linkSync = link;
        Deno.removeSync = remove;
        BoundFileStore.prototype.capture = capture;
      }
      // The publication callback installs its owned snapshot without doing an
      // ordinary capture. Cleanup is still attempted, even after visibility.
      assertEquals(exercised, fault === "cleanup");
      config.save({ brand: { name: "Following" } });
      assertEquals([
        config.settings.brand.name,
        store(filename).settings.brand.name,
      ], ["Following", "Following"]);
    }));
}

Deno.test("R07: chained file and directory links persist into the target and observe deployment recovery on reopen", () =>
  withFixtureDirectory((root) => {
    const { target, link } = tree(root);
    const intermediary = `${root}/state/chain.toml`,
      directory = `${root}/configured-state`;
    Deno.symlinkSync("../deployment/config.toml", intermediary);
    Deno.symlinkSync("chain.toml", link);
    Deno.symlinkSync("state", directory);
    const links = [directory, link, intermediary];
    const witnesses = links.map((
      path,
    ) => [Deno.lstatSync(path).ino, Deno.readLinkSync(path)]);
    const filename = `${directory}/config.toml`;
    store(filename).save(changes);
    assertEquals(store(filename).settings.brand.name, "published");
    Deno.writeTextFileSync(target, '[brand]\nname="deployment recovery"\n');
    assertEquals(store(filename).settings.brand.name, "deployment recovery");
    assertEquals(
      links.map((path) => [Deno.lstatSync(path).ino, Deno.readLinkSync(path)]),
      witnesses,
    );
  }));

Deno.test("R07: absent parents and a dangling file link preserve distinct creation paths", () =>
  withFixtureDirectory((root) => {
    const first = `${root}/first/run/config.toml`;
    store(first).save(changes);
    assertEquals(store(first).settings.brand.name, "published");
    const { directory, link } = tree(root), target = `${directory}/new.toml`;
    Deno.symlinkSync("../deployment/new.toml", link);
    const ino = Deno.lstatSync(link).ino;
    store(link).save(changes);
    assertEquals([Deno.lstatSync(link).isSymlink, Deno.lstatSync(link).ino], [
      true,
      ino,
    ]);
    assertEquals(parse(Deno.readTextFileSync(target)), changes);
    assertEquals(store(link).settings.brand.name, "published");
  }));

for (
  const change of [
    "retarget",
    "replace-file",
    "replace-directory",
    "retarget-during-temporary",
  ] as const
) {
  Deno.test(`R07: ${change} conflicts even with identical TOML bytes and leaves exact bytes, memory and no residue`, () =>
    withFixtureDirectory((root) => {
      const { directory, target, link } = tree(root),
        other = `${directory}/other.toml`;
      Deno.writeTextFileSync(other, initial);
      Deno.symlinkSync(target, link);
      const config = store(link), before = config.capture();
      const retarget = () => {
        Deno.removeSync(link);
        Deno.symlinkSync(other, link);
      };
      const write = Deno.writeTextFileSync;
      try {
        if (change === "retarget") retarget();
        if (change === "replace-file") {
          Deno.writeTextFileSync(`${directory}/replacement.toml`, initial);
          Deno.renameSync(`${directory}/replacement.toml`, target);
        }
        if (change === "replace-directory") {
          Deno.renameSync(directory, `${root}/old-deployment`);
          Deno.mkdirSync(directory);
          Deno.writeTextFileSync(target, initial);
          Deno.writeTextFileSync(other, initial);
        }
        if (change === "retarget-during-temporary") {
          Deno.writeTextFileSync = (path, bytes, options) => {
            write(path, bytes, options);
            if (String(path).includes("/.config-")) retarget();
          };
        }
        assertThrows(
          () => config.save(changes, before),
          StoredConfigConflict,
          "Stored configuration changed before commit.",
        );
        assertEquals(config.capture(), before);
        assertEquals([
          Deno.readTextFileSync(target),
          Deno.readTextFileSync(other),
          residue(directory),
        ], [initial, initial, []]);
      } finally {
        Deno.writeTextFileSync = write;
      }
    }));
}

Deno.test("R07: unwritable target cannot borrow directory permission; allowed save retains target mode", () =>
  withFixtureDirectory((root) => {
    const { target, link } = tree(root);
    Deno.symlinkSync(target, link);
    Deno.chmodSync(target, 0o444);
    const config = store(link),
      before = config.capture(),
      ino = Deno.lstatSync(link).ino;
    assertThrows(() => config.save(changes), Deno.errors.PermissionDenied);
    assertEquals([
      Deno.readTextFileSync(target),
      config.capture(),
      Deno.lstatSync(link).ino,
    ], [initial, before, ino]);
    Deno.chmodSync(target, 0o640);
    // Mode is part of storage ownership, so reopen after the deployment edit.
    store(link).save(changes);
    assertEquals([
      Deno.statSync(target).mode! & 0o777,
      store(link).settings.brand.name,
    ], [0o640, "published"]);
  }));

Deno.test("R07: invalid targets fail without replacing links or creating unowned parents", async (t) => {
  for (
    const kind of [
      "cycle",
      "directory",
      "dangling-directory",
      "absent-external-parent",
    ] as const
  ) {
    await t.step(kind, () =>
      withFixtureDirectory((root) => {
        const { link, directory } = tree(root);
        const unowned = `${root}/unowned`,
          asDirectory = `${root}/configured-state`;
        const configured = kind === "dangling-directory" ? asDirectory : link;
        Deno.symlinkSync(
          {
            cycle: "config.toml",
            directory,
            "dangling-directory": unowned,
            "absent-external-parent": `${unowned}/config.toml`,
          }[kind],
          configured,
        );
        const ino = Deno.lstatSync(configured).ino;
        const filename = kind === "dangling-directory"
          ? `${asDirectory}/config.toml`
          : link;
        assertThrows(() => store(filename).save(changes));
        assertEquals([
          Deno.lstatSync(configured).isSymlink,
          Deno.lstatSync(configured).ino,
        ], [true, ino]);
        assertThrows(() => Deno.lstatSync(unowned), Deno.errors.NotFound);
      }));
  }
});

Deno.test("R07: target rename refusal preserves TOML bytes, memory and link with no residue", () =>
  withFixtureDirectory((root) => {
    const { directory, target, link } = tree(root);
    Deno.symlinkSync(target, link);
    const config = store(link),
      before = config.capture(),
      ino = Deno.lstatSync(link).ino;
    const rename = Deno.renameSync;
    try {
      Deno.renameSync = (from, to) => {
        if (String(to) === target) {
          throw new Deno.errors.PermissionDenied(
            "fixture target rename refused",
          );
        }
        rename(from, to);
      };
      assertThrows(
        () => config.save(changes),
        Deno.errors.PermissionDenied,
        "fixture target rename refused",
      );
      assertEquals([
        config.capture(),
        Deno.readTextFileSync(target),
        Deno.lstatSync(link).ino,
        residue(directory),
      ], [before, initial, ino, []]);
    } finally {
      Deno.renameSync = rename;
    }
  }));

Deno.test("R05 R07: HTTP Access follows linked ACL and persists its exact receipt across restart", () =>
  withFixtureDirectory(async (root, scope) => {
    const vault = `${root}/vault`, directory = `${root}/deployment`;
    Deno.mkdirSync(vault);
    Deno.mkdirSync(directory);
    const env = {
      GLOBNOTES_GLOBNOTES_PATH: vault,
      GLOBNOTES__METADATA_PATH: root,
      fixtureScenario: publicScenario(),
    };
    const boot = async () =>
      (await scope.acquire(() => bootServer(env), (server) => server.close()))
        .value;
    let server = await boot();
    const state = `${root}/globnotes`,
      link = `${state}/access.json`,
      target = `${directory}/access.json`;
    await server.close();
    Deno.renameSync(link, target);
    Deno.symlinkSync("../deployment/access.json", link);
    const ino = Deno.lstatSync(link).ino;
    server = await boot();
    async function call(
      path: string,
      method = "GET",
      body?: unknown,
      token?: string,
    ) {
      const response = await fetch(`${server.baseUrl}/_/api/${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    }
    const login = async () =>
      (await call("token", "POST", { username: "alice", password: "password" }))
        .body.access_token as string;
    const token = await login();
    const { body: { revision, signature, grants } } = await call(
      "access",
      "GET",
      undefined,
      token,
    );
    const updateId = createUuid(), bytes = Deno.readTextFileSync(target);
    assertEquals(
      (await call("access", "PUT", {
        revision,
        signature,
        grants,
        updateId,
        everybody: ["edit"],
      }, token)).status,
      422,
    );
    assertEquals(Deno.readTextFileSync(target), bytes);
    const id = Object.keys(grants)[0];
    const ack = await call("access", "PUT", {
      revision,
      signature,
      grants: { [id]: "edit" },
      updateId,
      everybody: "edit",
    }, token);
    assertEquals([
      ack.status,
      ack.body.updateId,
      ack.body.capabilities.canManageVault,
    ], [200, updateId, false]);
    const committed = Deno.readTextFileSync(target);
    assertEquals(Deno.lstatSync(link).ino, ino);
    await server.close();
    server = await boot();
    const restarted = await login();
    assertEquals(
      (await call("access", "GET", undefined, restarted)).status,
      403,
    );
    assertEquals(
      (await call("access", "PUT", {
        revision,
        signature,
        grants,
        updateId,
        everybody: "edit",
      }, restarted)).status,
      403,
    );
    assertEquals(JSON.parse(committed).updateId, updateId);
    assertEquals(Deno.readTextFileSync(target), committed);
    assertEquals(
      (await call("notes", "POST", {
        path: "Public-note",
        content: "public note remains writable",
      })).status,
      200,
    );
    assertEquals(
      Deno.readTextFileSync(`${vault}/Public-note.md`),
      "public note remains writable",
    );
    await server.close();
    const persisted = JSON.parse(committed);
    Deno.writeTextFileSync(
      target,
      JSON.stringify({
        ...persisted,
        revision: persisted.revision + 1,
        grants,
      }),
    );
    Deno.writeTextFileSync(
      `${state}/config.toml`,
      '[brand]\nname="recovered deployment"\n',
    );
    server = await boot();
    const recovered = await login();
    const access = await call("access", "GET", undefined, recovered);
    assertEquals([access.status, access.body.grants, access.body.updateId], [
      200,
      grants,
      updateId,
    ]);
    assertEquals(
      (await call("config")).body.brand.name,
      "recovered deployment",
    );
    assertEquals([Deno.lstatSync(link).ino, Deno.readLinkSync(link)], [
      ino,
      "../deployment/access.json",
    ]);
  }));
