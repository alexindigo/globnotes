// Switcher panel row-uniformity: every note row is exactly two lines
// (line 1 = title + key tag flush right; line 2 = path, highlighted inline
// for path/file hits, `alias:`-prefixed for alias hits, plain for title
// hits); the pinned search row is a sticky footer outside the scroll list
// with its Ctrl+Enter tag flush right; the list is capped at 9 so every
// row has a Ctrl+N shortcut.
import { describe, it, expect, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import PrimeVue from "primevue/config";
import ToastService from "primevue/toastservice";

import SwitcherPanel from "../components/SwitcherPanel.vue";
import { useGlobalStore } from "../globalStore.js";
import router from "../router";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Row anatomy reader: line 1 = the title-line div (title span + key tag);
// line 2 = the path/alias line; footer = the pinned search row element.
function readPanel() {
  const ul = document.querySelector("ul.switcher-results");
  const rows = [...(ul ? ul.querySelectorAll("li") : [])].filter(
    (li) => !li.textContent.includes("No matching notes."),
  );
  const detail = (li) => {
    // Row anatomy: li > wrapper div > [line-1 div (title + hint), line-2
    // div (path/alias)]. Line 2 always exists (uniform rows).
    const lineDivs = li.querySelectorAll(":scope > div > div");
    const line1 = lineDivs[0];
    const line2 = lineDivs[lineDivs.length - 1];
    const titleSpan = line1?.querySelector(".text-theme-text");
    const brandOf = (root) =>
      root
        ? [...root.querySelectorAll(".text-theme-brand")]
            .map((s) => s.textContent)
            .join("")
        : "";
    return {
      title: titleSpan?.textContent.trim() ?? "",
      titleBrand: brandOf(titleSpan),
      line2Text: line2?.textContent.trim() ?? "",
      line2Brand: brandOf(line2),
      hasAliasPrefix: !!line2 && line2.textContent.trim().startsWith("alias:"),
      hint: li.querySelector(".key-tag")?.textContent ?? null,
      divCount: lineDivs.length,
    };
  };
  // The footer ROW: contains the search text, the full-search line 2, and
  // the Ctrl+Enter tag — the deepest such div.
  const footer = [...document.querySelectorAll("div")]
    .filter(
      (d) =>
        d.textContent.includes("Search for") &&
        d.textContent.includes("full search") &&
        d.querySelector(".key-tag")?.textContent.includes("Enter"),
    )
    .at(-1);
  return { ul, rows: rows.map(detail), footer };
}

function typeQuery(value) {
  const input = document.querySelector("input");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("switcher panel row uniformity", () => {
  it("uniform two-line rows across match kinds, footer aligned, cap at 9", async () => {
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

    // --- "mom": file hit first, then folder hits — all rows uniform
    // (line 1 title + hint; line 2 always present).
    typeQuery("mom");
    await sleep(30);
    let panel = readPanel();
    expect(panel.rows.length).toBeGreaterThanOrEqual(3);
    // Uniform anatomy: every row has a hint and a line 2.
    for (const row of panel.rows) {
      expect(row.hint, "key tag on every row").toBeTruthy();
      expect(row.divCount, "exactly two line-divs per row").toBe(2);
    }
    // File hit ranks first (docs/mom), path hits after.
    expect(panel.rows[0].title).toBe("Shopping list");
    expect(panel.rows[0].line2Text).toContain("notes/docs/mom");
    expect(panel.rows[0].line2Brand).toBe("mom");
    expect(panel.rows[1].title).toBe("readme");
    expect(panel.rows[1].line2Text).toContain("notes/mom/readme");
    // Title hit: line 2 shows the path PLAIN (highlight is in the title).
    const align = panel.rows.find((r) => r.title.startsWith("Switcher alignment"));
    expect(align.titleBrand).toBe("mom");
    expect(align.line2Text).toContain("notes/switcher-alignment");
    expect(align.line2Brand).toBe("");

    // --- Footer: tag flush right (same anatomy family as Ctrl+N tags).
    expect(panel.footer.textContent).toContain("Ctrl+Enter");
    const footerTag = panel.footer.querySelector(".key-tag");
    expect(footerTag).toBeTruthy();
    // The tag is right-aligned via justify-between on line 1, and the
    // footer is a two-line row: "full search" sits on line 2, styled like
    // the result rows' path lines.
    expect(footerTag.parentElement.className).toContain("justify-between");
    const footerLine2 = [...panel.footer.querySelectorAll("div")].find((d) =>
      d.textContent.trim() === "full search",
    );
    expect(footerLine2, "footer line 2").toBeTruthy();
    expect(footerLine2.className).toContain("text-theme-text-very-muted");

    // --- Alias hit: muted "alias:" prefix on line 2.
    typeQuery("cooking");
    await sleep(30);
    panel = readPanel();
    expect(panel.rows.length).toBe(1);
    expect(panel.rows[0].hasAliasPrefix).toBe(true);
    expect(panel.rows[0].line2Text).toBe("alias: cooking");
    expect(panel.rows[0].line2Brand).toBe("cooking");
    expect(panel.rows[0].hint).toBe("Ctrl+1");

    // --- Key tags stay: Ctrl+N jump + Ctrl+Enter search still work.
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

    // --- Top-9 cap: every shown row carries a Ctrl+N shortcut (15 notes
    // match "a" — 9 rows shown, each with a hint).
    typeQuery("a");
    await sleep(30);
    const capped = document.querySelectorAll("ul.switcher-results > li");
    expect(capped.length).toBe(9);
    for (const [i, li] of [...capped].entries()) {
      expect(li.textContent, `row ${i + 1} hint`).toContain(`Ctrl+${i + 1}`);
    }

    app.unmount();
    mountEl.remove();
    localStorage.clear();
  }, 15000);
});
