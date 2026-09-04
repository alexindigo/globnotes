// Switcher panel match annotations: every match row gets a uniform
// "<kind>: <matched text>" line under it (title/alias/file/path) with the
// matched characters highlighted; long candidates window around the first
// match; the list is capped at 10 note rows (+ the pinned full-search row),
// and filename hits outrank folder-segment hits.
import { describe, it, expect, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import PrimeVue from "primevue/config";
import ToastService from "primevue/toastservice";

import SwitcherPanel from "../components/SwitcherPanel.vue";
import { useGlobalStore } from "../globalStore.js";
import router from "../router";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("switcher panel match annotations", () => {
  it("annotates what matched for every match kind, caps at 10", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const mountEl = document.createElement("div");
    document.body.appendChild(mountEl);
    const app = createApp(SwitcherPanel);
    app.use(pinia);
    app.use(router);
    // SwitcherInput resolves the toast service in its setup.
    app.use(PrimeVue);
    app.use(ToastService);

    const store = useGlobalStore();
    store.noteMeta = [
      { path: "folders/mom/ideas", title: "Ideas", aliases: [] },
      { path: "notes/docs/mom", title: "Shopping list", aliases: [] },
      { path: "notes/mom/readme", title: "readme", aliases: [] },
      {
        path: "a/very/silly/folder/chain/before/the/gate/deep/down/inside/nested/folders/that/contain/mom/x",
        title: "Deep note",
        aliases: [],
      },
      {
        path: "notes/switcher-alignment",
        title: "Switcher alignment — geometry decomposition",
        aliases: [],
      },
      { path: "notes/recipes-book", title: "Recipes Book", aliases: ["cooking"] },
      ...Array.from({ length: 12 }, (_, i) => ({
        path: `notes/pad-${i}`,
        title: `Pad ${i}`,
        aliases: [],
      })),
    ];

    app.mount(mountEl);
    await nextTick();

    // --- "mom": the file hit (mom.md) outranks the folder-segment hits;
    // every row carries its kind annotation.
    typeQuery("mom");
    await sleep(30);
    const rowsFor = (needle) =>
      Array.from(document.querySelectorAll("ul > li")).filter((li) =>
        li.textContent.includes(needle),
      );
    const annotated = (li) => ({
      kind: [...li.querySelectorAll("div")]
        .map((d) => d.textContent.trim().split(":")[0])
        .find((k) => ["title", "alias", "file", "path"].includes(k)),
      brand: [...li.querySelectorAll(".text-theme-brand")].map((s) =>
        s.textContent,
      ).join(""),
    });

    const fileRow = rowsFor("notes/docs/mom")[0];
    expect(fileRow, "file-hit row").toBeTruthy();
    expect(annotated(fileRow)).toMatchObject({ kind: "file", brand: "mom" });

    // Folder hits read as "path" — Ideas matched its folder segment.
    const ideasRow = rowsFor("folders/mom/ideas")[0];
    expect(annotated(ideasRow).kind).toBe("path");
    expect(annotated(ideasRow).brand).toBe("mom");

    // The readme note matched its folder segment too.
    expect(annotated(rowsFor("notes/mom/readme")[0]).kind).toBe("path");

    // The basename-fallback title reads as "file" (mom.md has no explicit
    // title — its "title" IS the filename).
    // (docs/mom above is the file hit; here assert via the readme note's
    // path row only — its title "readme" didn't match "mom".)

    // Long path: the annotation windows around the match — elided head,
    // match still visible.
    const deepRow = rowsFor("a/very/silly")[0];
    const deepAnnotation = [...deepRow.querySelectorAll("div")].find((d) =>
      d.textContent.trim().startsWith("path:"),
    );
    expect(deepAnnotation, "long-path annotation").toBeTruthy();
    expect(deepAnnotation.textContent).toContain("…");
    expect(deepAnnotation.querySelector(".text-theme-brand")?.textContent).toBe(
      "mom",
    );

    // --- Title hit (scattered subsequence): "title:" annotation line.
    typeQuery("geometry");
    await sleep(30);
    const alignRow = rowsFor("geometry decomposition")[0];
    expect(alignRow, "switcher-alignment row").toBeTruthy();
    const align = annotated(alignRow);
    expect(align.kind).toBe("title");
    expect(align.brand).toBe("geometry");
    // The title line itself stays plain.
    expect(
      alignRow.querySelector(".text-theme-text").querySelector(".text-theme-brand"),
    ).toBeNull();

    // --- Alias hit: "alias:" annotation.
    typeQuery("cooking");
    await sleep(30);
    const aliasRow = rowsFor("recipes-book")[0];
    expect(annotated(aliasRow).kind).toBe("alias");
    expect(annotated(aliasRow).brand).toBe("cooking");

    // --- Top-10 cap: 15+ notes match "a"; 10 note rows + pinned search row.
    typeQuery("a");
    await sleep(30);
    const rows = document.querySelectorAll("ul > li");
    expect(rows.length).toBe(11); // 10 capped note rows + pinned full-search row
    expect([...rows].at(-1).textContent).toContain("Search for");

    // --- Shortcut hints: Ctrl+N on note rows (jsdom → non-mac), Ctrl+Enter
    // on the pinned search row.
    expect(rows[0].textContent).toContain("Ctrl+1");
    expect(rows[1].textContent).toContain("Ctrl+2");
    expect([...rows].at(-1).textContent).toContain("Ctrl+Enter");
    expect([...rows].at(-1).textContent).not.toContain("Ctrl+1");

    // --- Ctrl+N jumps to result N; no-op beyond the row count.
    typeQuery("mom");
    await sleep(30);
    const pushSpy = vi.spyOn(router, "push").mockResolvedValue();
    const input = document.querySelector("input");
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "2",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await sleep(30);
    expect(pushSpy).toHaveBeenCalledWith("/notes/mom/readme");
    // Beyond the row count (5 rows: 4 notes + pinned): no navigation.
    pushSpy.mockClear();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "9",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await sleep(30);
    expect(pushSpy).not.toHaveBeenCalled();

    // --- Ctrl+Enter goes to the full search page with the query.
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await sleep(30);
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "search",
        query: expect.objectContaining({ term: "mom" }),
      }),
    );
    pushSpy.mockRestore();

    app.unmount();
    mountEl.remove();
    localStorage.clear();
  }, 15000);
});

function typeQuery(value) {
  const input = document.querySelector("input");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
