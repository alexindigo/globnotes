// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  BoundFileStore,
  StoredConfigConflict,
  type StoredConfigSnapshot,
} from "../server/config/file_store.ts";
import { StoredConfigConflict as FacadeConflict } from "../server/config.ts";

function fixture(run: (root: string) => void): void {
  const root = Deno.makeTempDirSync({ prefix: "bound-config-" });
  try {
    Deno.mkdirSync(`${root}/state`);
    Deno.mkdirSync(`${root}/deployment`);
    run(root);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}
const formats = [
  {
    filename: "config.json",
    before: '{"brand":"before","extra":{"keep":true}}',
    after: '{"brand":"after","extra":{"keep":true}}',
  },
  {
    filename: "config.toml",
    before: '# operator\n[brand]\nname="before"\n',
    after: '# operator\n[brand]\nname="after"\n',
  },
];

for (const { filename, after } of formats) {
  Deno.test(`bound file ${filename}: post-rename equal-byte replacement is not adopted as committed identity`, () =>
    fixture((root) => {
      const target = `${root}/deployment/${filename}`,
        store = new BoundFileStore(target),
        rename = Deno.renameSync;
      let committed: StoredConfigSnapshot | undefined;
      let writtenInode: number | null = null;
      try {
        Deno.renameSync = ((from, to) => {
          writtenInode = Deno.lstatSync(from).ino;
          rename(from, to);
          Deno.writeTextFileSync(`${target}.external`, after);
          rename(`${target}.external`, target);
        }) as typeof rename;
        store.replace(after, store.capture(), (snapshot) => {
          committed = snapshot;
        });
      } finally {
        Deno.renameSync = rename;
      }
      assert(committed);
      assertEquals(committed.raw, after);
      assertEquals(
        committed.binding.nodes.find((node) => node.location === target)
          ?.identity?.ino,
        writtenInode,
      );
      assertThrows(
        () => store.replace("following", committed),
        StoredConfigConflict,
      );
      assertEquals(Deno.readTextFileSync(target), after);
    }));

  for (const existing of [false, true]) {
    Deno.test(`bound file ${filename}: committed metadata needs no post-rename filesystem reads (${existing ? "linked" : "new parents"})`, () =>
      fixture((root) => {
        const target = existing
            ? `${root}/deployment/${filename}`
            : `${root}/state/new/parent/${filename}`,
          configured = `${root}/state/${filename}`;
        if (existing) {
          Deno.writeTextFileSync(target, "before");
          Deno.chmodSync(target, 0o640);
          Deno.symlinkSync(target, configured);
        }
        const store = new BoundFileStore(existing ? configured : target),
          expected = store.capture(),
          rename = Deno.renameSync,
          read = Deno.readTextFileSync,
          stat = Deno.statSync,
          lstat = Deno.lstatSync;
        let committed: StoredConfigSnapshot | undefined;
        const denied = () => {
          throw new Deno.errors.PermissionDenied("post-rename read");
        };
        try {
          Deno.renameSync = ((from, to) => {
            rename(from, to);
            Deno.readTextFileSync = denied;
            Deno.statSync = denied;
            Deno.lstatSync = denied;
          }) as typeof rename;
          store.replace(after, expected, (snapshot) => {
            committed = snapshot;
          });
        } finally {
          Deno.renameSync = rename;
          Deno.readTextFileSync = read;
          Deno.statSync = stat;
          Deno.lstatSync = lstat;
        }
        assert(committed);
        assert(Object.isFrozen(committed));
        assert(Object.isFrozen(committed.binding.nodes));
        assertEquals(committed, store.capture());
        assertEquals(committed.raw, after);
        store.replace("following", committed);
        assertEquals(Deno.readTextFileSync(target), "following");
      }));
  }
}
function residue(root: string): string[] {
  return [...Deno.readDirSync(`${root}/deployment`)].map((e) => e.name).filter(
    (name) => name.startsWith(".config-"),
  );
}

Deno.test("bound file: facade exports the same conflict identity", () =>
  assertEquals(FacadeConflict, StoredConfigConflict));

for (const { filename, before, after } of formats) {
  for (const absolute of [false, true]) {
    Deno.test(`bound file ${filename}: ${absolute ? "absolute" : "relative"} link and directory binding retain identity`, () =>
      fixture((root) => {
        const target = `${root}/deployment/${filename}`,
          link = `${root}/state/${filename}`,
          alias = `${root}/configured-state`;
        Deno.writeTextFileSync(target, before);
        Deno.chmodSync(target, 0o640);
        Deno.symlinkSync(absolute ? target : `../deployment/${filename}`, link);
        Deno.symlinkSync("state", alias);
        const links = [alias, link].map((file) => ({
          file,
          ino: Deno.lstatSync(file).ino,
          text: Deno.readLinkSync(file),
        }));
        const store = new BoundFileStore(`${alias}/${filename}`),
          snapshot = store.capture();
        let published = false;
        assert(Object.isFrozen(snapshot.binding.nodes));
        store.replace(after, snapshot, () => {
          published = true;
          assertEquals(Deno.readTextFileSync(target), after);
        });
        assert(published);
        assertEquals(
          new BoundFileStore(`${alias}/${filename}`).capture().raw,
          after,
        );
        assertEquals(Deno.statSync(target).mode! & 0o777, 0o640);
        for (const { file, ino, text } of links) {
          assertEquals(Deno.lstatSync(file).ino, ino);
          assertEquals(Deno.readLinkSync(file), text);
        }
        assertEquals(residue(root), []);
      }));
  }

  for (
    const change of [
      "bytes",
      "retarget",
      "equal-file",
      "equal-directory",
      "during-write",
    ]
  ) {
    Deno.test(`bound file ${filename}: ${change} invalidates CAS without publishing`, () =>
      fixture((root) => {
        const target = `${root}/deployment/${filename}`,
          other = `${root}/deployment/other`,
          link = `${root}/state/${filename}`;
        Deno.writeTextFileSync(target, before);
        Deno.writeTextFileSync(other, before);
        Deno.symlinkSync(target, link);
        const store = new BoundFileStore(link), expected = store.capture();
        const retarget = () => {
          Deno.removeSync(link);
          Deno.symlinkSync(other, link);
        };
        const write = Deno.writeTextFileSync;
        let published = false;
        try {
          if (change === "bytes") {
            Deno.writeTextFileSync(target, "external bytes");
          }
          if (change === "retarget") retarget();
          if (change === "equal-file") {
            Deno.writeTextFileSync(`${target}.new`, before);
            Deno.renameSync(`${target}.new`, target);
          }
          if (change === "equal-directory") {
            Deno.renameSync(`${root}/deployment`, `${root}/old`);
            Deno.mkdirSync(`${root}/deployment`);
            Deno.writeTextFileSync(target, before);
          }
          if (change === "during-write") {
            Deno.writeTextFileSync = ((file, data, opts) => {
              write(file, data, opts);
              if (String(file).includes("/.config-")) retarget();
            }) as typeof write;
          }
          assertThrows(() =>
            store.replace(after, expected, () => {
              published = true;
            }), StoredConfigConflict);
          assertEquals(published, false);
          assertEquals(
            Deno.readTextFileSync(target),
            change === "bytes" ? "external bytes" : before,
          );
          assertEquals(residue(root), []);
        } finally {
          Deno.writeTextFileSync = write;
        }
      }));
  }

  Deno.test(`bound file ${filename}: absent ordinary parents and dangling file target remain distinct`, () =>
    fixture((root) => {
      const nested = new BoundFileStore(`${root}/state/new/parent/${filename}`);
      const snapshot = nested.capture();
      assertEquals(snapshot.raw, null);
      nested.replace(after, snapshot);
      assertEquals(nested.capture().raw, after);
      const link = `${root}/state/${filename}`,
        target = `${root}/deployment/${filename}`;
      Deno.symlinkSync(target, link);
      const ino = Deno.lstatSync(link).ino;
      new BoundFileStore(link).replace(after);
      assertEquals(Deno.readTextFileSync(target), after);
      assertEquals(Deno.lstatSync(link).ino, ino);
    }));

  Deno.test(`bound file ${filename}: target permission cannot be borrowed from a writable directory`, () =>
    fixture((root) => {
      const target = `${root}/deployment/${filename}`,
        link = `${root}/state/${filename}`;
      Deno.writeTextFileSync(target, before);
      Deno.symlinkSync(target, link);
      Deno.chmodSync(target, 0o444);
      try {
        assertThrows(
          () => new BoundFileStore(link).replace(after),
          Deno.errors.PermissionDenied,
        );
        assertEquals(Deno.readTextFileSync(target), before);
      } finally {
        Deno.chmodSync(target, 0o600);
      }
      assertEquals(residue(root), []);
    }));

  for (const boundary of ["write", "rename"]) {
    Deno.test(`bound file ${filename}: ${boundary} failure retains exact bytes and no publication`, () =>
      fixture((root) => {
        const target = `${root}/deployment/${filename}`,
          link = `${root}/state/${filename}`;
        Deno.writeTextFileSync(target, before);
        Deno.symlinkSync(target, link);
        const store = new BoundFileStore(link),
          snapshot = store.capture(),
          write = Deno.writeTextFileSync,
          rename = Deno.renameSync;
        let published = false;
        try {
          if (boundary === "write") {
            Deno.writeTextFileSync = ((file, data, opts) => {
              if (String(file).includes("/.config-")) {
                throw new Deno.errors.PermissionDenied("fixture");
              }
              write(file, data, opts);
            }) as typeof write;
          } else {Deno.renameSync = ((from, to) => {
              if (String(to) === target) {
                throw new Deno.errors.PermissionDenied("fixture");
              }
              rename(from, to);
            }) as typeof rename;}
          assertThrows(() =>
            store.replace(after, snapshot, () => {
              published = true;
            }), Deno.errors.PermissionDenied);
          assertEquals(published, false);
          assertEquals(Deno.readTextFileSync(target), before);
          assertEquals(Deno.readLinkSync(link), target);
          assertEquals(residue(root), []);
        } finally {
          Deno.writeTextFileSync = write;
          Deno.renameSync = rename;
        }
      }));
  }

  Deno.test(`bound file ${filename}: cleanup errors retain the original error and publication timing`, () =>
    fixture((root) => {
      const target = `${root}/deployment/${filename}`;
      Deno.writeTextFileSync(target, before);
      const store = new BoundFileStore(target),
        remove = Deno.removeSync,
        rename = Deno.renameSync;
      let published = false;
      try {
        Deno.removeSync = ((file, opts) => {
          if (String(file).includes("/.config-")) {
            throw new Deno.errors.PermissionDenied("cleanup fixture");
          }
          remove(file, opts);
        }) as typeof remove;
        assertThrows(() =>
          store.replace(after, store.capture(), () => {
            published = true;
          }), Deno.errors.PermissionDenied);
        assert(published);
        assertEquals(Deno.readTextFileSync(target), after);
        Deno.renameSync = (() => {
          throw new Deno.errors.PermissionDenied("rename fixture");
        }) as typeof rename;
        const error = assertThrows(() => store.replace(before), AggregateError);
        assertEquals(error.errors.length, 2);
        assertEquals(Deno.readTextFileSync(target), after);
      } finally {
        Deno.removeSync = remove;
        Deno.renameSync = rename;
      }
    }));

  for (const kind of ["cycle", "directory", "missing-link-parent"]) {
    Deno.test(`bound file ${filename}: ${kind} is rejected without replacing deployment links`, () =>
      fixture((root) => {
        const link = `${root}/state/${filename}`;
        Deno.symlinkSync(
          kind === "cycle"
            ? filename
            : kind === "directory"
            ? `${root}/deployment`
            : `${root}/absent/${filename}`,
          link,
        );
        const ino = Deno.lstatSync(link).ino;
        assertThrows(() => new BoundFileStore(link).replace(after));
        assertEquals(Deno.lstatSync(link).ino, ino);
        assertEquals(residue(root), []);
      }));
  }
}
