// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { backupFixture } from "./helpers/backup_fixture.ts";
import { fixtureApiOrigin } from "./helpers/plugin_fixture.ts";
import { FsError, PluginContractError } from "../server/plugins/contracts.ts";

async function ring(vault: string, path: string, expected: string[], max = 10) {
  for (let index = 0; index < max; index++) {
    const file = `${vault}/${path}.md.${index}.bak`;
    if (index < expected.length) {
      assertEquals(
        await Deno.readTextFile(file),
        expected[index],
        `ordered slot ${index}`,
      );
    } else await assertRejects(() => Deno.stat(file), Deno.errors.NotFound);
  }
}

Deno.test("backup plugin: actual managed A B C D saves preserve default2 ordered previous text", async () => {
  const b = await backupFixture();
  try {
    await b.create("family/Note", "A");
    await b.save("family/Note", "B");
    assertEquals((await b.status()).completed, 1);
    await ring(b.fixture.vault, "family/Note", ["A"]);
    await b.save("family/Note", "C");
    await b.status();
    await ring(b.fixture.vault, "family/Note", ["B", "A"]);
    await b.save("family/Note", "D");
    const status = await b.status();
    await ring(b.fixture.vault, "family/Note", ["C", "B"]);
    assertEquals(
      await Deno.readTextFile(`${b.fixture.vault}/family/Note.md`),
      "D",
    );
    assertEquals(status.completed, 3);
    assertEquals(status.pendingRecovery, false);
  } finally {
    await b.close();
  }
});

Deno.test("backup plugin: every count1–10 and equal-content capture is distinct; prune only next successful family transaction", async () => {
  const b = await backupFixture();
  try {
    for (let count = 1; count <= 10; count++) {
      await b.configure(count);
      await b.status();
      const path = `Counts/N${count}`, history: string[] = [];
      await b.create(path, "v0");
      for (let index = 1; index <= count + 2; index++) {
        history.unshift(`v${index - 1}`);
        await b.save(path, `v${index}`);
        await b.status();
      }
      await ring(b.fixture.vault, path, history.slice(0, count));
    }
    await b.configure(3);
    await b.create("Equal", "same");
    for (let i = 0; i < 4; i++) {
      await b.save("Equal", "same");
      await b.status();
    }
    await ring(b.fixture.vault, "Equal", ["same", "same", "same"]);
    await b.configure(1);
    await b.status();
    await ring(b.fixture.vault, "Equal", ["same", "same", "same"]);
    await b.save("Equal", "new");
    await b.status();
    await ring(b.fixture.vault, "Equal", ["same"]);
    await b.configure(10);
    await b.save("Equal", "next");
    await b.status();
    await ring(b.fixture.vault, "Equal", ["new", "same"]);
  } finally {
    await b.close();
  }
});

Deno.test("backup canonical root: adjacent relative absolute and symlink spellings continue one physical family", async () => {
  const b = await backupFixture();
  try {
    await b.configure(5);
    await b.create("nested/雪", "A");
    await b.save("nested/雪", "B");
    await b.status();
    await Deno.symlink(b.fixture.vault, `${b.fixture.vault}/alias`);
    const bases = [".", b.fixture.vault, "alias"];
    for (const [index, base] of bases.entries()) {
      await b.configure(5, base);
      await b.save("nested/雪", String.fromCharCode(67 + index));
      await b.status();
    }
    await ring(b.fixture.vault, "nested/雪", ["D", "C", "B", "A"]);
    const families = [
      ...Deno.readDirSync(`${b.fixture.vault}/.globnotes-backup`),
    ].filter((entry) => entry.name.startsWith("family-"));
    assertEquals(
      families.length,
      1,
      "equivalent aliases must not split metadata families",
    );
  } finally {
    await b.close();
  }
});

Deno.test("backup plugin: empty Unicode CRLF frontmatter and invalid UTF8 use captured Markdown text", async () => {
  const b = await backupFixture();
  try {
    const versions = [
      "",
      "雪 📝\n",
      "one\r\ntwo\r\n",
      "---\r\ntag: yes\r\n---\r\nbody\r\n",
      "trailing\n",
    ];
    for (const [index, text] of versions.entries()) {
      const path = `Text${index}`;
      await b.create(path, text);
      await b.save(path, "replacement");
      await b.status();
      await ring(b.fixture.vault, path, [text]);
    }
    const bytes = new Uint8Array([97, 255, 98]);
    await Deno.writeFile(`${b.fixture.vault}/Invalid.md`, bytes);
    await b.save("Invalid", "new");
    await b.status();
    assertEquals(
      await Deno.readFile(`${b.fixture.vault}/Invalid.md.0.bak`),
      new TextEncoder().encode(new TextDecoder().decode(bytes)),
    );
  } finally {
    await b.close();
  }
});

Deno.test("backup plugin: rename delete recreate preserve original-path histories and batch rewrite backs up each note", async () => {
  const b = await backupFixture();
  try {
    await b.create("Original", "old");
    await b.operations.updateNote(
      "Original",
      { newContent: "new", newPath: "Renamed" },
      "none",
      fixtureApiOrigin(b.lifecycle),
    );
    await b.status();
    await ring(b.fixture.vault, "Original", ["old"]);
    assertEquals(
      (await b.status()).completed,
      1,
      "combined rename/save fact pair must capture once",
    );
    await b.save("Renamed", "later");
    await b.status();
    await ring(b.fixture.vault, "Renamed", ["new"]);
    await b.remove("Renamed");
    await b.status();
    await ring(b.fixture.vault, "Renamed", ["later", "new"]);
    await b.create("Renamed", "recreated");
    await b.save("Renamed", "changed");
    await b.status();
    await ring(b.fixture.vault, "Renamed", ["recreated", "later"]);
    await Deno.writeTextFile(
      `${b.fixture.vault}/asset.png`,
      "fixture attachment",
    );
    await b.create("RefA", "[asset](asset.png) A");
    await b.create("RefB", "[asset](asset.png) B");
    await b.operations.rewriteRefs(
      "asset.png",
      "renamed.png",
      fixtureApiOrigin(b.lifecycle),
    );
    await b.status();
    await ring(b.fixture.vault, "RefA", ["[asset](asset.png) A"]);
    await ring(b.fixture.vault, "RefB", ["[asset](asset.png) B"]);
  } finally {
    await b.close();
  }
});

Deno.test("backup plugin: H1-derived and explicit heading renames capture original text once per path", async () => {
  const b = await backupFixture();
  const original = "# Original\n\nliteral original text\n";
  const renamed = "# Renamed\n\nliteral renamed text\n";
  try {
    await b.create("heading/Original", original);
    const saved = await b.save("heading/Original", renamed);
    assertEquals(saved.path, "heading/Renamed");
    assertEquals(
      (await b.status()).completed,
      1,
      "combined H1 rename/save captures once",
    );
    await ring(b.fixture.vault, "heading/Original", [original]);
    await ring(b.fixture.vault, "heading/Renamed", []);
    assertEquals(
      await Deno.readTextFile(`${b.fixture.vault}/heading/Renamed.md`),
      renamed,
    );
    await assertRejects(
      () => Deno.stat(`${b.fixture.vault}/heading/Original.md`),
      Deno.errors.NotFound,
    );
    const moved = await b.operations.updateNote(
      "heading/Renamed",
      { newPath: "heading/Explicit" },
      "none",
      fixtureApiOrigin(b.lifecycle),
    );
    assertEquals(moved.path, "heading/Explicit");
    assertEquals((await b.status()).completed, 2);
    await ring(b.fixture.vault, "heading/Renamed", [renamed]);
    const rewrittenHeading = "# Explicit\n\nliteral renamed text\n";
    assertEquals(
      await Deno.readTextFile(`${b.fixture.vault}/heading/Explicit.md`),
      rewrittenHeading,
    );
    await b.save("heading/Explicit", "# Explicit\n\nnext text\n");
    assertEquals((await b.status()).completed, 3);
    await ring(b.fixture.vault, "heading/Explicit", [rewrittenHeading]);
    await ring(b.fixture.vault, "heading/Original", [original]);
    await ring(b.fixture.vault, "heading/Renamed", [renamed]);
  } finally {
    await b.close();
  }
});

Deno.test("backup plugin: ordinary fractions reject generically; near-integer setting is acknowledged but visibly rejects processing", async () => {
  const b = await backupFixture();
  try {
    for (const value of [0, 11, 2.5, NaN]) {
      await assertRejects(() => b.configure(value), PluginContractError);
    }
    await b.create("Count", "before");
    const acknowledged = await b.configure(2.000000001);
    assertEquals(acknowledged.values.retention, 2.000000001);
    const settingStatus = await b.status();
    assertEquals(settingStatus.lastError?.code, "invalid_backup_configuration");
    await b.save("Count", "successful note");
    const status = await b.status();
    assert(status.failed >= 1);
    assertEquals(status.lastError?.code, "invalid_backup_configuration");
    assertEquals(
      await Deno.readTextFile(`${b.fixture.vault}/Count.md`),
      "successful note",
    );
    await ring(b.fixture.vault, "Count", []);
    assert(b.runtime.status(b.id)?.degraded);
  } finally {
    await b.close();
  }
});

Deno.test("backup plugin: alien slot fails visibly after successful save without modifying it", async () => {
  const b = await backupFixture();
  try {
    await b.create("Alien", "before");
    await Deno.writeTextFile(`${b.fixture.vault}/Alien.md.0.bak`, "alien");
    await b.save("Alien", "after");
    const status = await b.status();
    assertEquals(status.completed, 0);
    assertEquals(status.lastError?.code, "backup_alien_slot");
    assertEquals(
      await Deno.readTextFile(`${b.fixture.vault}/Alien.md.0.bak`),
      "alien",
    );
    assertEquals(
      await Deno.readTextFile(`${b.fixture.vault}/Alien.md`),
      "after",
    );
  } finally {
    await b.close();
  }
});

Deno.test("backup plugin: publication failure retains intent and original note; restart resumes exact ring without replay", async () => {
  let armed = false, fired = false;
  const b = await backupFixture({
    fault: (method, args, boundary) => {
      if (
        armed && !fired && boundary === "before" && method === "fs.writeFile" &&
        String(args[0]).endsWith(".0.bak")
      ) {
        fired = true;
        throw new FsError("fs_io_error");
      }
    },
  });
  let restarted: Awaited<ReturnType<typeof backupFixture>> | undefined;
  try {
    await b.create("Recover", "A");
    await b.save("Recover", "B");
    await b.status();
    armed = true;
    await b.save("Recover", "C");
    const failed = await b.status();
    assertEquals(failed.pendingRecovery, true);
    assertEquals(failed.lastError?.code, "fs_io_error");
    assertEquals(await Deno.readTextFile(`${b.fixture.vault}/Recover.md`), "C");
    const journal = JSON.parse(
      await Deno.readTextFile(
        `${b.fixture.vault}/.globnotes-backup/active.json`,
      ),
    );
    assertEquals(journal.phase, "prepared");
    await b.close();
    restarted = await backupFixture({ fixture: b.fixture });
    const recovered = await restarted.status();
    assertEquals(recovered.pendingRecovery, false);
    await ring(b.fixture.vault, "Recover", ["B", "A"]);
    assertEquals(await Deno.readTextFile(`${b.fixture.vault}/Recover.md`), "C");
  } finally {
    if (restarted) await restarted.close();
    else await b.close();
  }
});

Deno.test("backup review: an intervening alien with identical planned bytes cannot be adopted before publication", async () => {
  let vault = "", armed = false, injected = false;
  const b = await backupFixture({
    fault: async (method, args, boundary) => {
      if (
        armed && !injected && boundary === "after" && method === "fs.mkdir" &&
        String(args[0]) === vault
      ) {
        injected = true;
        await Deno.writeTextFile(`${vault}/Intervene.md.0.bak`, "A");
      }
    },
  });
  vault = b.fixture.vault;
  try {
    await b.create("Intervene", "A");
    armed = true;
    await b.save("Intervene", "B");
    const status = await b.status();
    assert(injected);
    assertEquals(
      status.completed,
      0,
      "unattempted matching bytes are still alien",
    );
    assertEquals(status.lastError?.code, "backup_alien_slot");
    assertEquals(await Deno.readTextFile(`${vault}/Intervene.md.0.bak`), "A");
  } finally {
    await b.close();
  }
});

for (const corruption of ["journal-recent", "family-schema"] as const) {
  Deno.test(`backup review: ${corruption} rejects before recovered slot effects or cleanup`, async () => {
    let armed = false, fired = false;
    const b = await backupFixture({
      fault: (method, args, boundary) => {
        if (!armed || fired || method !== "fs.writeFile") return;
        if (
          corruption === "journal-recent"
            ? boundary === "before" && String(args[0]).endsWith(".0.bak")
            : boundary === "after" && String(args[0]).includes("/family-")
        ) {
          fired = true;
          throw new FsError(
            "fs_io_error",
            boundary === "after" ? "committed" : "none",
          );
        }
      },
    });
    let restarted: Awaited<ReturnType<typeof backupFixture>> | undefined;
    try {
      await b.create("Corrupt", "A");
      await b.save("Corrupt", "B");
      await b.status();
      armed = true;
      await b.save("Corrupt", "C");
      await b.status();
      const workspace = `${b.fixture.vault}/.globnotes-backup`,
        journalFile = `${workspace}/active.json`,
        journal = JSON.parse(await Deno.readTextFile(journalFile));
      if (corruption === "journal-recent") {
        delete journal.recent;
        await Deno.writeTextFile(journalFile, JSON.stringify(journal));
      } else {
        const file = `${workspace}/family-${journal.familyKey}.json`,
          metadata = JSON.parse(await Deno.readTextFile(file));
        metadata.schema = 999;
        await Deno.writeTextFile(file, JSON.stringify(metadata));
      }
      const before = await Deno.readFile(`${b.fixture.vault}/Corrupt.md.0.bak`);
      await b.close();
      restarted = await backupFixture({ fixture: b.fixture });
      const status = await restarted.status();
      assertEquals(status.pendingRecovery, true);
      assertEquals(
        await Deno.readFile(`${b.fixture.vault}/Corrupt.md.0.bak`),
        before,
      );
      assert(await Deno.stat(journalFile));
      assertEquals(
        status.lastError?.code,
        corruption === "journal-recent"
          ? "backup_journal_corrupt"
          : "backup_family_corrupt",
      );
    } finally {
      if (restarted) await restarted.close();
      else await b.close();
    }
  });
}

Deno.test("backup canonical root: external unseen alias after restart continues history; distinct equal roots never mix", async () => {
  const b = await backupFixture();
  let restarted: Awaited<ReturnType<typeof backupFixture>> | undefined;
  const first = `${b.fixture.root}/first`,
    second = `${b.fixture.root}/second`,
    alias = `${b.fixture.root}/unseen-alias`;
  try {
    await Deno.mkdir(first);
    await Deno.mkdir(second);
    await Deno.symlink(first, alias);
    await b.configure(2, first);
    await b.create("nested/Same", "A");
    await b.save("nested/Same", "B");
    await b.status();
    await b.configure(2, alias);
    await b.status();
    await b.close();
    restarted = await backupFixture({ fixture: b.fixture });
    await restarted.save("nested/Same", "C");
    await restarted.status();
    await ring(first, "nested/Same", ["B", "A"]);
    await restarted.configure(2, second);
    await restarted.save("nested/Same", "D");
    await restarted.status();
    await ring(second, "nested/Same", ["C"]);
    await ring(first, "nested/Same", ["B", "A"]);
    const metadata = [
      ...Deno.readDirSync(`${b.fixture.vault}/.globnotes-backup`),
    ].filter((row) => row.name.startsWith("family-"));
    assertEquals(metadata.length, 2);
  } finally {
    if (restarted) await restarted.close();
    else await b.close();
  }
});

Deno.test("backup plugin: rapid captures stay literal while live disk is newer; unavailable external facts skip", async () => {
  const b = await backupFixture();
  try {
    await b.create("Rapid", "A");
    await b.save("Rapid", "B");
    await b.save("Rapid", "C");
    await b.save("Rapid", "D");
    await b.status();
    await ring(b.fixture.vault, "Rapid", ["C", "B"]);
    for (
      const before of [null, {
        path: "Rapid",
        contentAvailable: false,
        content: "invented",
      }, { path: "Rapid", contentAvailable: true }]
    ) {
      b.runtime.post("on-save", {
        operationId: crypto.randomUUID(),
        action: "save",
        origin: "api",
        timestamp: new Date().toISOString(),
        before,
      });
    }
    b.runtime.post("on-save", {
      operationId: crypto.randomUUID(),
      action: "save",
      origin: "external",
      timestamp: new Date().toISOString(),
      before: { path: "Rapid", content: "external", contentAvailable: true },
    });
    const status = await b.status();
    assertEquals(status.skipped, 4);
    await ring(b.fixture.vault, "Rapid", ["C", "B"]);
  } finally {
    await b.close();
  }
});

for (
  const boundary of [
    "stage-before",
    "stage-after",
    "slot0-before",
    "slot0-after",
    "slot1-after",
    "metadata-before",
    "metadata-after",
    "prune-before",
    "prune-after",
    "cleanup-before",
    "cleanup-after",
    "journal-clear-after",
  ] as const
) {
  Deno.test(`backup plugin recovery: interruption ${boundary} preserves old/planned ring and resumes without replay`, async () => {
    let armed = false, fired = false;
    const b = await backupFixture({
      fault: (method, args, at) => {
        if (!armed || fired) return;
        const file = String(args[0]),
          value = args[1] instanceof Uint8Array
            ? new TextDecoder().decode(args[1])
            : "";
        const match = boundary.startsWith("stage-")
          ? method === "fs.writeFile" && file.includes("/stage-") &&
            file.endsWith("-0.bin")
          : boundary.startsWith("slot0-")
          ? method === "fs.writeFile" && file.endsWith(".0.bak")
          : boundary.startsWith("slot1-")
          ? method === "fs.writeFile" && file.endsWith(".1.bak")
          : boundary.startsWith("metadata-")
          ? method === "fs.writeFile" && file.includes("/family-")
          : boundary.startsWith("prune-")
          ? method === "fs.remove" && file.endsWith(".2.bak")
          : boundary.startsWith("cleanup-")
          ? method === "fs.remove" && file.includes("/stage-")
          : method === "fs.remove" && file.endsWith("/active.json");
        if (
          match && at === (boundary.endsWith("before") ? "before" : "after")
        ) {
          fired = true;
          throw new FsError(
            "fs_io_error",
            at === "after" ? "committed" : "none",
          );
        }
        void value;
      },
    });
    let restarted: Awaited<ReturnType<typeof backupFixture>> | undefined;
    try {
      await b.configure(3);
      await b.create("Fault", "A");
      for (const value of ["B", "C", "D"]) {
        await b.save("Fault", value);
        await b.status();
      }
      await b.configure(boundary.startsWith("prune") ? 1 : 2);
      await b.status();
      armed = true;
      await b.save("Fault", "E");
      const failed = await b.status();
      assert(fired, "fault boundary was not reached");
      assertEquals(await Deno.readTextFile(`${b.fixture.vault}/Fault.md`), "E");
      assert(failed.failed > 0);
      await b.close();
      restarted = await backupFixture({ fixture: b.fixture });
      const status = await restarted.status();
      if (boundary === "stage-before") {
        assertEquals(status.pendingRecovery, true);
        assertEquals(status.lastError?.code, "backup_incomplete_capture");
        await ring(b.fixture.vault, "Fault", ["C", "B", "A"]);
      } else {
        assertEquals(status.pendingRecovery, false, boundary);
        await ring(
          b.fixture.vault,
          "Fault",
          boundary.startsWith("prune") ? ["D"] : ["D", "C"],
        );
      }
      assertEquals(await Deno.readTextFile(`${b.fixture.vault}/Fault.md`), "E");
    } finally {
      if (restarted) await restarted.close();
      else await b.close();
    }
  });
}

for (
  const boundary of [
    "workspace-before",
    "owner-before",
    "setup-intent-after",
    "root-mkdir-after",
    "root-token-after",
    "root-binding-before-stage",
  ] as const
) {
  Deno.test(`backup canonical root: interruption ${boundary} exposes incomplete or uncertain setup and retains evidence`, async () => {
    let armed = false, fired = false, selected = "";
    const b = await backupFixture({
      fault: (method, args, at) => {
        if (!armed || fired) return;
        const file = String(args[0]),
          text = args[1] instanceof Uint8Array
            ? new TextDecoder().decode(args[1])
            : "";
        const match = boundary === "workspace-before"
          ? method === "fs.mkdir" && file.endsWith("/.globnotes-backup") &&
            at === "before"
          : boundary === "owner-before"
          ? method === "fs.writeFile" && file.endsWith("/owner.json") &&
            at === "before"
          : boundary === "setup-intent-after"
          ? method === "fs.writeFile" && file.endsWith("/active.json") &&
            text.includes('"phase":"preparing-root"') &&
            text.includes('"createdToken":null') && at === "after"
          : boundary === "root-mkdir-after"
          ? method === "fs.mkdir" && file === selected && at === "after"
          : boundary === "root-token-after"
          ? method === "fs.writeFile" && file.endsWith("/active.json") &&
            text.includes('"phase":"preparing-root"') &&
            !text.includes('"createdToken":null') && at === "after"
          : method === "fs.writeFile" && file.includes("/stage-") &&
            at === "before";
        if (match) {
          fired = true;
          throw new FsError(
            "fs_io_error",
            at === "after" ? "committed" : "none",
          );
        }
      },
    });
    let restarted: Awaited<ReturnType<typeof backupFixture>> | undefined;
    selected = `${b.fixture.root}/selected`;
    try {
      await b.configure(2, selected);
      await b.status();
      await b.create("Root", "A");
      armed = true;
      await b.save("Root", "B");
      await b.status();
      assert(fired);
      await b.close();
      restarted = await backupFixture({ fixture: b.fixture });
      const status = await restarted.status();
      assertEquals(status.completed, 0);
      if (boundary === "workspace-before") assertEquals(status.lastError, null);
      else {assert(
          status.lastError,
          "retained incomplete setup must remain visible",
        );}
      if (!["workspace-before", "owner-before"].includes(boundary)) {
        assertEquals(status.pendingRecovery, true);
      }
      await assertRejects(
        () => Deno.stat(`${selected}/Root.md.0.bak`),
        Deno.errors.NotFound,
      );
      assertEquals(await Deno.readTextFile(`${b.fixture.vault}/Root.md`), "B");
    } finally {
      if (restarted) await restarted.close();
      else await b.close();
    }
  });
}

Deno.test("backup review: known staging-read failure cannot claim a target publication attempt", async () => {
  let prepared = false, fired = false;
  const b = await backupFixture({
    fault: (method, args, at) => {
      if (
        method === "fs.writeFile" && String(args[0]).endsWith("/active.json") &&
        at === "after" &&
        new TextDecoder().decode(args[1] as Uint8Array).includes(
          '"phase":"prepared"',
        )
      ) prepared = true;
      if (
        prepared && !fired && method === "fs.readFile" &&
        String(args[0]).endsWith("-0.bin") && at === "before"
      ) {
        fired = true;
        throw new FsError("fs_io_error");
      }
    },
  });
  try {
    await b.create("Attempt", "A");
    await b.save("Attempt", "B");
    await b.status();
    assert(fired);
    const journal = JSON.parse(
      await Deno.readTextFile(
        `${b.fixture.vault}/.globnotes-backup/active.json`,
      ),
    );
    assertEquals(
      journal.attempted,
      [false],
      "pre-publication failure must retain the original absent condition",
    );
    await assertRejects(
      () => Deno.stat(`${b.fixture.vault}/Attempt.md.0.bak`),
      Deno.errors.NotFound,
    );
  } finally {
    await b.close();
  }
});

Deno.test("backup canonical root: alias retarget after pin continues authorized canonical slots, never the new alias root", async () => {
  let armed = false, retargeted = false, alias = "", second = "";
  const b = await backupFixture({
    fault: async (method, args, at) => {
      if (
        armed && !retargeted && method === "fs.writeFile" &&
        String(args[0]).endsWith("/active.json") && at === "after" &&
        new TextDecoder().decode(args[1] as Uint8Array).includes(
          '"phase":"prepared"',
        )
      ) {
        retargeted = true;
        await Deno.remove(alias);
        await Deno.symlink(second, alias);
      }
    },
  });
  const first = `${b.fixture.vault}/first`;
  second = `${b.fixture.vault}/second`;
  alias = `${b.fixture.vault}/alias`;
  try {
    await Deno.mkdir(first);
    await Deno.mkdir(second);
    await Deno.symlink(first, alias);
    await b.configure(2, alias);
    await b.create("Pinned", "A");
    await b.save("Pinned", "B");
    await b.status();
    armed = true;
    await b.save("Pinned", "C");
    const status = await b.status();
    assert(retargeted);
    assertEquals(status.pendingRecovery, false);
    await ring(first, "Pinned", ["B", "A"]);
    await ring(second, "Pinned", []);
  } finally {
    await b.close();
  }
});

Deno.test("backup canonical root: two positively owned equal-byte roots remain distinct families", async () => {
  const b = await backupFixture(),
    first = `${b.fixture.root}/equal-first`,
    second = `${b.fixture.root}/equal-second`;
  try {
    await Deno.mkdir(first);
    await Deno.mkdir(second);
    await b.create("Twin", "A");
    await b.configure(2, first);
    await b.save("Twin", "B");
    await b.status();
    await ring(first, "Twin", ["A"]);
    await b.configure(2, second);
    await Deno.writeTextFile(`${b.fixture.vault}/Twin.md`, "A");
    await b.save("Twin", "B");
    await b.status();
    await ring(second, "Twin", ["A"]);
    await b.configure(2, first);
    await b.save("Twin", "C");
    await b.status();
    await ring(first, "Twin", ["B", "A"]);
    await ring(second, "Twin", ["A"]);
    assertEquals(
      [...Deno.readDirSync(`${b.fixture.vault}/.globnotes-backup`)].filter(
        (row) => row.name.startsWith("family-"),
      ).length,
      2,
    );
  } finally {
    await b.close();
  }
});

Deno.test("backup plugin: ENOSPC write fault preserves saved note and owned ring", async () => {
  const b = await backupFixture(), original = Deno.open;
  let full = false;
  try {
    await b.create("Disk", "A");
    await b.save("Disk", "B");
    await b.status();
    Deno.open = async (...args: Parameters<typeof Deno.open>) => {
      const file = await original(...args);
      if (
        full && args[1]?.createNew &&
        String(args[0]).startsWith(
          `${b.fixture.vault}/.globnotes-backup/.auxiliary-`,
        )
      ) {
        // Bounded fault at the actual retained-handle write seam. Direct
        // /dev/full requires Deno allow-all, which the approved gates deny.
        file.write = () =>
          Promise.reject(
            Object.assign(new Error("No space left on device (os error 28)"), {
              code: "ENOSPC",
            }),
          );
      }
      return file;
    };
    full = true;
    await b.save("Disk", "C");
    const status = await b.status();
    assertEquals(status.lastError, { code: "fs_io_error", effect: "none" });
    assertEquals(
      status.pendingRecovery,
      false,
      "known no-effect intent failure must not claim a journal exists",
    );
    assertEquals(await Deno.readTextFile(`${b.fixture.vault}/Disk.md`), "C");
    await ring(b.fixture.vault, "Disk", ["A"]);
    assertEquals(
      [...Deno.readDirSync(`${b.fixture.vault}/.globnotes-backup`)].filter(
        (entry) => entry.name.startsWith(".auxiliary-"),
      ).length,
      0,
    );
  } finally {
    Deno.open = original;
    await b.close();
  }
});

for (const code of ["fs_denied", "fs_deadline"]) {
  Deno.test(`backup plugin: ${code} after note ACK is visible with no fictitious rollback`, async () => {
    let armed = false;
    const b = await backupFixture({
      fault: (method, args, at) => {
        if (
          armed && at === "before" && method === "fs.writeFile" &&
          String(args[0]).endsWith(".0.bak")
        ) throw new FsError(code);
      },
    });
    try {
      await b.create("Failure", "A");
      await b.save("Failure", "B");
      await b.status();
      armed = true;
      await b.save("Failure", "C");
      const status = await b.status();
      assertEquals(status.lastError, { code, effect: "none" });
      assert(status.pendingRecovery);
      assertEquals(
        await Deno.readTextFile(`${b.fixture.vault}/Failure.md`),
        "C",
      );
      await ring(b.fixture.vault, "Failure", ["A"]);
    } finally {
      await b.close();
    }
  });
}

Deno.test("backup plugin: retirement at held publication preserves ACK and never publishes late; new owner recovers", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let armed = false;
  const b = await backupFixture({
    fault: async (method, args, at) => {
      if (
        armed && at === "before" && method === "fs.writeFile" &&
        String(args[0]).endsWith(".0.bak")
      ) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  let restarted: Awaited<ReturnType<typeof backupFixture>> | undefined;
  try {
    await b.create("Retired", "A");
    await b.save("Retired", "B");
    await b.status();
    armed = true;
    await b.save("Retired", "C");
    await entered.promise;
    await b.runtime.retireOwner(b.id, false, true);
    release.resolve();
    await ring(b.fixture.vault, "Retired", ["A"]);
    assertEquals(await Deno.readTextFile(`${b.fixture.vault}/Retired.md`), "C");
    await b.close();
    restarted = await backupFixture({ fixture: b.fixture });
    await restarted.status();
    await ring(b.fixture.vault, "Retired", ["B", "A"]);
  } finally {
    release.resolve();
    if (restarted) await restarted.close();
    else await b.close();
  }
});
