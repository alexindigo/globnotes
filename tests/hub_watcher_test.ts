// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { VaultHub } from "../server/hub/hub.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

function fixture() {
  const root = Deno.makeTempDirSync();
  const vault = `${root}/vault`;
  Deno.mkdirSync(vault);
  const hub = new VaultHub(
    vault,
    `${vault}/.globnotes`,
    testEnvironment({
      GLOBNOTES_HUB_SCAN_INTERVAL: "3600",
    }),
  );
  const original = Deno.watchFs;
  const watches: {
    path: string;
    recursive: boolean;
    closed: boolean;
    events: Deno.FsEvent[];
  }[] = [];
  Deno.watchFs = (target, options) => {
    const watcher = original(target, options);
    const record = {
      path: String(target),
      recursive: options?.recursive ?? true,
      closed: false,
      events: [] as Deno.FsEvent[],
    };
    watches.push(record);
    return new Proxy(watcher, {
      get(target, key) {
        if (key === "close") {
          return () => {
            record.closed = true;
            target.close();
          };
        }
        if (key === Symbol.asyncIterator) {
          return async function* () {
            for await (const event of target) {
              record.events.push(event);
              yield event;
            }
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return {
    vault,
    hub,
    watches,
    close() {
      hub.stop();
      Deno.watchFs = original;
      Deno.removeSync(root, { recursive: true });
    },
  };
}

Deno.test("hub watcher: state writes have no covering watch or delivered events", async () => {
  const f = fixture();
  try {
    Deno.mkdirSync(`${f.vault}/notes`);
    Deno.mkdirSync(`${f.vault}/.obsidian`);
    Deno.symlinkSync(`${f.vault}/.globnotes`, `${f.vault}/state-alias`);
    f.hub.start();
    assertEquals(
      f.watches.map((watch) => [watch.path, watch.recursive]),
      [[f.vault, false], [`${f.vault}/notes`, true]],
    );
    Deno.writeTextFileSync(`${f.vault}/.globnotes/private.md`, "state");
    Deno.writeTextFileSync(`${f.vault}/top.md`, "root event");
    await waitUntil(
      () => f.hub.fileState("top.md") ? done() : pending(f.hub.sequence()),
      { label: "nonrecursive root watch publishes top-level writes" },
    );
    assertEquals(f.hub.fileState(".globnotes/private.md"), null);
    assertEquals(
      f.watches.flatMap((watch) => watch.events.flatMap((event) => event.paths))
        .filter((name) => name.startsWith(`${f.vault}/.globnotes/`)),
      [],
    );
  } finally {
    f.close();
  }
  assert(f.watches.every((watch) => watch.closed), "stop closes every watch");
});

Deno.test("hub watcher: new top-level directories gain a recursive watch before later edits", async () => {
  const f = fixture();
  try {
    f.hub.start();
    Deno.mkdirSync(`${f.vault}/new/deep`, { recursive: true });
    Deno.writeTextFileSync(`${f.vault}/new/deep/live.md`, "initial");
    await waitUntil(
      () => f.hub.fileState("new/deep/live.md") ? done() : pending(f.watches),
      { label: "root event discovers new directory content" },
    );
    const before = f.hub.sequence();
    Deno.writeTextFileSync(`${f.vault}/new/deep/live.md`, "edited later");
    await waitUntil(
      () => f.hub.sequence() > before ? done() : pending(f.hub.sequence()),
      { label: "new recursive watch publishes a later nested edit" },
    );
    assert(
      f.watches.some((watch) =>
        watch.path === `${f.vault}/new` && watch.recursive && !watch.closed
      ),
    );
    assertEquals(f.hub.fileState("new/deep/live.md")?.vector, { local: 2 });
  } finally {
    f.close();
  }
});

Deno.test("hub watcher: dot-folder edits wait for the periodic scan seam", async () => {
  const f = fixture();
  try {
    Deno.mkdirSync(`${f.vault}/.obsidian`);
    Deno.writeTextFileSync(`${f.vault}/.obsidian/config.json`, "initial");
    f.hub.start();
    const before = f.hub.sequence();
    Deno.writeTextFileSync(`${f.vault}/.obsidian/config.json`, "edited later");
    // Observe beyond the 300 ms debounce; no periodic scan runs for an hour.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assertEquals(f.hub.sequence(), before);
    assertEquals(
      f.watches.flatMap((watch) => watch.events.flatMap((event) => event.paths))
        .filter((name) => name.startsWith(`${f.vault}/.obsidian/`)),
      [],
    );
    f.hub.scanNow();
    assertEquals(f.hub.fileState(".obsidian/config.json")?.vector, {
      local: 2,
    });
  } finally {
    f.close();
  }
});

Deno.test("hub watcher: removal and rename to a dot folder close directory watches", async () => {
  const f = fixture();
  try {
    Deno.mkdirSync(`${f.vault}/removed`);
    Deno.mkdirSync(`${f.vault}/renamed`);
    f.hub.start();
    for (const name of ["removed", "renamed"]) {
      assert(f.watches.some((watch) => watch.path === `${f.vault}/${name}`));
    }
    Deno.removeSync(`${f.vault}/removed`);
    Deno.renameSync(`${f.vault}/renamed`, `${f.vault}/.renamed`);
    await waitUntil(
      () =>
        f.watches.filter((watch) => watch.path !== f.vault).every((watch) =>
            watch.closed
          )
          ? done()
          : pending(f.watches),
      { label: "root events retire removed and renamed directory watches" },
    );
    assertEquals(f.watches.length, 3, "dot destination is never watched");
  } finally {
    f.close();
  }
});

Deno.test("hub watcher: replacing a directory at the same path retires the old inode watch", async () => {
  const f = fixture();
  try {
    Deno.mkdirSync(`${f.vault}/replaced`);
    f.hub.start();
    const old = f.watches.find((watch) =>
      watch.path === `${f.vault}/replaced`
    )!;
    Deno.renameSync(`${f.vault}/replaced`, `${f.vault}/.old`);
    Deno.mkdirSync(`${f.vault}/replaced/deep`, { recursive: true });
    await waitUntil(
      () =>
        old.closed &&
          f.watches.some((watch) =>
            watch !== old && watch.path === old.path && !watch.closed
          )
          ? done()
          : pending(f.watches),
      { label: "replacement directory owns a fresh recursive watch" },
    );
    Deno.writeTextFileSync(`${f.vault}/replaced/deep/new.md`, "replacement");
    await waitUntil(
      () =>
        f.hub.fileState("replaced/deep/new.md")
          ? done()
          : pending(f.hub.sequence()),
      { label: "replacement directory's nested write reaches the hub" },
    );
  } finally {
    f.close();
  }
});
