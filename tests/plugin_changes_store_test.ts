// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { HubStore } from "../server/hub/store.ts";
import { encodedBytes } from "../server/plugins/change_contract.ts";
import type { Mutation } from "../server/hub/types.ts";

function rows(count: number, prefix = "note"): Mutation[] {
  return Array.from({ length: count }, (_, i) => {
    const path = `${prefix}-${i}.md`;
    return {
      path,
      file: {
        key: path,
        diskPath: path,
        hash: "a".repeat(64),
        size: 7,
        mtimeMs: 1,
      },
    };
  });
}
function fixture(limit = 100_000) {
  const root = Deno.makeTempDirSync();
  const store = new HubStore(root, { changeLimit: limit });
  return {
    root,
    store,
    close() {
      store.close();
      Deno.removeSync(root, { recursive: true });
    },
  };
}

Deno.test("changes store: v4 migration preserves metadata/secret and adds stable vault identity and isolated cursor CAS", () => {
  const a = fixture(), b = fixture();
  let reopened: HubStore | undefined;
  try {
    a.store.apply(rows(1), "local", null);
    const secret = a.store.secret;
    a.store.db.exec(
      "DROP TABLE plugin_cursors; DELETE FROM meta WHERE key='log_id'; UPDATE meta SET value='4' WHERE key='schema_version'",
    );
    a.store.close();
    reopened = new HubStore(a.root);
    const id = reopened.logId;
    assert(id !== b.store.logId);
    assertEquals(reopened.secret, secret);
    assertEquals(reopened.fileState("note-0.md")!.seq, 1);
    assertEquals(
      reopened.db.prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get()!.value,
      "5",
    );
    const cursor = { logId: id, seq: 1, authorityKey: "grant-fingerprint" };
    assert(reopened.advancePluginCursor("one", null, cursor));
    assert(!reopened.advancePluginCursor("one", null, cursor));
    assertEquals(reopened.pluginCursor("two"), null);
    assertEquals(b.store.pluginCursor("one"), null);
    assert(!b.store.advancePluginCursor("one", null, cursor));
    assert(!reopened.advancePluginCursor("one", cursor, { ...cursor, seq: 2 }));
    assert(
      !reopened.advancePluginCursor(
        "one",
        { ...cursor, authorityKey: "other" },
        cursor,
      ),
    );
    reopened.close();
    reopened = new HubStore(a.root);
    assertEquals(reopened.logId, id);
    assertEquals(reopened.pluginCursor("one"), cursor);
    reopened.removePluginCursor("one");
    assertEquals(reopened.pluginCursor("one"), null);
  } finally {
    reopened?.close();
    Deno.removeSync(a.root, { recursive: true });
    b.close();
  }
});

Deno.test("changes store: snapshot reset retains exact CAS and log bounds without relaxing ordinary progress", () => {
  const f = fixture();
  try {
    f.store.apply(rows(3), "local", null);
    const cursor = { logId: f.store.logId, seq: 3, authorityKey: "all" };
    assert(f.store.advancePluginCursor("one", null, cursor));
    const reset = { ...cursor, seq: 1 };
    assert(!f.store.advancePluginCursor("one", cursor, reset));
    assert(!f.store.resetPluginCursor("one", { ...cursor, seq: 2 }, reset));
    assert(
      !f.store.resetPluginCursor(
        "one",
        { ...cursor, authorityKey: "other" },
        reset,
      ),
    );
    assert(
      !f.store.resetPluginCursor("one", cursor, {
        ...reset,
        logId: "other-log",
      }),
    );
    assert(!f.store.resetPluginCursor("one", cursor, { ...reset, seq: 4 }));
    assert(f.store.resetPluginCursor("one", cursor, reset));
    assertEquals(f.store.pluginCursor("one"), reset);
    assert(!f.store.resetPluginCursor("one", cursor, reset));
    assertEquals(f.store.pluginCursor("two"), null);
  } finally {
    f.close();
  }
});

Deno.test("changes store: bounded keyset replay keeps whole fitting batches and explicit stable multipart offsets", () => {
  const f = fixture();
  try {
    f.store.apply(rows(3, "first"), "local", null);
    f.store.apply(rows(4, "second"), "globnotes", "api");
    f.store.apply(rows(130, "large"), "instance", "external");
    const options = { maxEntries: 128, maxBytes: 1024 * 1024 };
    const first = f.store.changesSince(0, options);
    assertEquals(first.entries.length, 7);
    assertEquals(first.batches, [{ batch: 1, part: 1, complete: true }, {
      batch: 4,
      part: 1,
      complete: true,
    }]);
    const split = f.store.changesSince(7, options);
    assertEquals(split.entries.length, 128);
    assertEquals(split.batches, [{ batch: 8, part: 1, complete: false }]);
    const tail = f.store.changesSince(135, options);
    assertEquals(tail.entries.length, 2);
    assertEquals(tail.batches, [{ batch: 8, part: 129, complete: true }]);
    assertEquals(f.store.changesSince(0).entries.length, 137);
    assertEquals(Object.keys(f.store.changesSince(0)).sort(), [
      "entries",
      "gap",
    ]);
    for (const seq of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assertThrows(() => f.store.changesSince(seq), TypeError);
    }
    for (const maxEntries of [0, 129, 1.5]) {
      assertThrows(
        () => f.store.changesSince(0, { ...options, maxEntries }),
        TypeError,
      );
    }
  } finally {
    f.close();
  }
});

Deno.test("changes store: UTF-8 encoded bytes independently bound replay and cursors do not pin retention", () => {
  const f = fixture(140);
  try {
    f.store.apply(rows(130, "\u00e9".repeat(2000)), "local", null);
    const options = { maxEntries: 128, maxBytes: 32 * 1024 };
    const page = f.store.changesSince(0, options);
    assert(page.entries.length < 128);
    assert(
      encodedBytes({ entries: page.entries, batches: page.batches }) <=
        options.maxBytes,
    );
    assertEquals(page.batches?.[0].complete, false);
    let seq = page.entries.at(-1)!.seq;
    while (seq < 130) {
      const next = f.store.changesSince(seq, options);
      assertEquals(next.batches?.[0].part, seq + 1);
      assert(
        encodedBytes({ entries: next.entries, batches: next.batches }) <=
          options.maxBytes,
      );
      seq = next.entries.at(-1)!.seq;
    }
    assertEquals(seq, 130);
    const cursor = { logId: f.store.logId, seq: 0, authorityKey: "all" };
    assert(f.store.advancePluginCursor("slow", null, cursor));
    f.store.apply(rows(141, "later"), "globnotes", "api");
    assertEquals(f.store.changesSince(0, options), { gap: true, entries: [] });
    assertEquals(f.store.pluginCursor("slow"), cursor);
    assertEquals(
      f.store.db.prepare("SELECT count(*) AS n FROM changes").get()!.n,
      140,
    );
  } finally {
    f.close();
  }
});
