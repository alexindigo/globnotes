// SPDX-License-Identifier: LGPL-3.0-only

// globnotes-properties — client half of the dual-mode Properties plugin.
// Default-exports an array of Milkdown plugin factories (the contract):
//
//   $view  — the interactive Properties panel over the CORE frontmatter
//            node (overrides the core fallback view; the node's schema,
//            position-0 parser, and YAML serializer stay in core because
//            file-format integrity cannot depend on a plugin toggle).
//   $prose — the empty-state "+ Add property" affordance for notes
//            without frontmatter (creates the block at position 0).
//
// Editing re-serializes through the shared YAML subset and dispatches a
// node markup update — the ordinary doc-changed listener marks the note
// dirty; source mode keeps raw YAML; toggles re-parse both ways.

import { $prose, $view } from "@milkdown/utils";
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { frontmatterSchema } from "@globnotes/frontmatter-node";
import {
  parseFrontmatter,
  serializeFrontmatter,
} from "@globnotes/frontmatter";

const LIST_KEYS = new Set(["tags", "aliases"]);
const KNOWN_KEYS = ["title", "aliases", "tags"];

const ICON_PATHS = {
  title: "M6 4h8a4 4 0 0 1 0 8h-8zM6 12h9a4 4 0 0 1 0 8h-9z",
  tags:
    "M7.5 4.5h6l4 4-6.5 6.5a1.5 1.5 0 0 1-2.1 0l-3.9-3.9a1.5 1.5 0 0 1 0-2.1zM9 8v.01",
  aliases: "M7 7l5 5-5 5M13 7l5 5-5 5",
  unknown:
    "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37c1 .608 2.296.07 2.572-1.065z",
  plus: "M12 5v14M5 12h14",
};

const pathPrefix =
  document.querySelector('meta[name="globnotes-prefix"]')?.content || "";

function iconSvg(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "properties-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON_PATHS[name] ?? ICON_PATHS.unknown);
  svg.appendChild(path);
  return svg;
}

function iconFor(key) {
  if (key === "title") return iconSvg("title");
  if (key === "tags") return iconSvg("tags");
  if (key === "aliases") return iconSvg("aliases");
  return iconSvg("unknown");
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let tagsPromise = null;
function fetchVaultTags() {
  if (!tagsPromise) {
    tagsPromise = fetch(`${pathPrefix}/_/api/tags`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return tagsPromise;
}

/** The interactive panel nodeView. */
function propertiesView(initialNode, view, getPos) {
  const dom = el("div", "properties-panel");
  let entries = parseFrontmatter(initialNode.attrs.value);
  let lastDispatched = initialNode.attrs.value;

  function dispatch() {
    const value = serializeFrontmatter(entries);
    lastDispatched = value;
    const pos = typeof getPos === "function" ? getPos() : getPos?.pos;
    if (pos == null) return;
    view.dispatch(
      view.state.tr.setNodeMarkup(pos, undefined, { value }),
    );
  }

  function keyRow(entry, keyInput) {
    const row = el("div", "properties-row");
    row.dataset.key = entry.key;
    row.appendChild(iconFor(entry.key));
    keyInput.value = entry.key;
    row.appendChild(keyInput);
    return row;
  }

  function keyInputFor(entry) {
    const input = el("input", "properties-key-input");
    input.type = "text";
    input.value = entry.key;
    input.setAttribute("aria-label", "property name");
    input.addEventListener("input", () => {
      const newKey = input.value.trim();
      if (!newKey || newKey === entry.key) return;
      entry.key = newKey;
      dispatch();
    });
    return input;
  }

  function scalarEditor(entry) {
    const input = el("input", "properties-value-input");
    input.type = "text";
    input.value = entry.value.text;
    input.placeholder = entry.key;
    input.addEventListener("input", () => {
      entry.value = { kind: "scalar", text: input.value };
      dispatch();
    });
    return input;
  }

  function rawEditor(entry) {
    const area = el("textarea", "properties-value-input properties-value-raw");
    area.value = entry.value.text;
    area.rows = Math.min(4, area.value.split("\n").length);
    area.addEventListener("input", () => {
      entry.value = { kind: "raw", text: area.value };
      dispatch();
    });
    return area;
  }

  function chipAdder(entry, chipsWrap) {
    const wrap = el("span", "properties-chip-adder");
    const input = el("input", "properties-chip-input");
    input.type = "text";
    input.placeholder = "add…";
    const menu = el("div", "properties-menu");
    menu.hidden = true;

    let items = [];
    async function openMenu() {
      const tags = await fetchVaultTags();
      const existing = new Set(entry.value.items.map((i) => i.toLowerCase()));
      items = tags.filter((t) => !existing.has(t.toLowerCase()));
      if (!items.length) {
        menu.hidden = true;
        return;
      }
      menu.replaceChildren(
        ...items.slice(0, 8).map((t) => {
          const item = el("div", "properties-menu-item", t);
          item.addEventListener("mousedown", (e) => {
            e.preventDefault();
            addItem(t);
          });
          return item;
        }),
      );
      menu.hidden = false;
    }

    function addItem(text) {
      const value = text.trim();
      if (!value) return;
      entry.value.items.push(value);
      input.value = "";
      menu.hidden = true;
      dispatch();
      chipsWrap.replaceChildren(...entry.value.items.map(chipFor), wrap);
    }

    function chipFor(text) {
      const chip = el("span", "properties-chip");
      chip.appendChild(el("span", undefined, text));
      const remove = el("button", "properties-chip-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `remove ${text}`);
      remove.addEventListener("click", () => {
        entry.value.items = entry.value.items.filter((i) => i !== text);
        dispatch();
        chipsWrap.replaceChildren(
          ...entry.value.items.map(chipFor),
          wrap,
        );
      });
      chip.appendChild(remove);
      return chip;
    }

    input.addEventListener("focus", openMenu);
    input.addEventListener("input", openMenu);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addItem(input.value);
      }
    });

    // One construction path: the wrap is assembled ONCE here and reused
    // (moved, never rebuilt) by every re-render below — a second builder
    // for this subtree is what detached the input in the first place.
    wrap.appendChild(input);
    wrap.appendChild(menu);
    return wrap;
  }

  function listEditor(entry) {
    const chipsWrap = el("span", "properties-value properties-chips");
    const renderChips = () => {
      chipsWrap.replaceChildren(
        ...entry.value.items.map((item) => {
          const chip = el("span", "properties-chip");
          chip.appendChild(el("span", undefined, item));
          const remove = el("button", "properties-chip-remove", "×");
          remove.type = "button";
          remove.setAttribute("aria-label", `remove ${item}`);
          remove.addEventListener("click", () => {
            entry.value.items = entry.value.items.filter((i) => i !== item);
            dispatch();
            renderChips();
          });
          chip.appendChild(remove);
          return chip;
        }),
      );
      chipsWrap.appendChild(chipAdder(entry, chipsWrap));
    };
    renderChips();
    return chipsWrap;
  }

  function valueEditorFor(entry) {
    if (entry.value.kind === "list") return listEditor(entry);
    if (entry.value.kind === "raw") return rawEditor(entry);
    return scalarEditor(entry);
  }

  function addMenu() {
    const wrap = el("div", "properties-add-wrap");
    const button = el("button", "properties-add", "+ Add property");
    button.type = "button";
    const menu = el("div", "properties-menu");
    menu.hidden = true;

    function addItem(key) {
      const entry = {
        key,
        value: LIST_KEYS.has(key)
          ? { kind: "list", items: [] }
          : { kind: "scalar", text: "" },
      };
      entries.push(entry);
      dispatch();
      render();
    }

    for (const key of KNOWN_KEYS) {
      const item = el("div", "properties-menu-item", key);
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        menu.hidden = true;
        addItem(key);
      });
      menu.appendChild(item);
    }

    const custom = el("input", "properties-key-input");
    custom.type = "text";
    custom.placeholder = "custom key…";
    custom.setAttribute("aria-label", "custom property name");
    custom.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const key = custom.value.trim();
        if (!key) return;
        menu.hidden = true;
        addItem(key);
      }
    });
    menu.appendChild(custom);

    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
      menu.hidden = !menu.hidden;
      if (!menu.hidden) custom.focus();
    });

    wrap.appendChild(button);
    wrap.appendChild(menu);
    return wrap;
  }

  function render() {
    dom.replaceChildren();
    for (const entry of entries) {
      const row = keyRow(entry, keyInputFor(entry));
      row.appendChild(valueEditorFor(entry));
      dom.appendChild(row);
    }
    dom.appendChild(addMenu());
  }

  render();

  return {
    dom,
    stopEvent: () => true,
    ignoreMutation: () => true,
    update(node) {
      if (node.type.name !== "frontmatter") return false;
      if (node.attrs.value === lastDispatched) return true;
      // External change (undo, mode transfer, setMarkdown): re-parse.
      entries = parseFrontmatter(node.attrs.value);
      lastDispatched = node.attrs.value;
      render();
      return true;
    },
    selectNode() {
      dom.classList.add("properties-selected");
    },
    deselectNode() {
      dom.classList.remove("properties-selected");
    },
  };
}

/** Interactive panel over the core frontmatter node. */
const propertiesPanel = $view(frontmatterSchema.node, () => {
  return propertiesView;
});

/** Empty state: notes without frontmatter get a lone "+ Add property"
 * affordance at position 0; using it creates the block there. */
const propertiesEmptyState = $prose((ctx) => {
  const nodeType = frontmatterSchema.type(ctx);
  let viewRef = null;
  return new Plugin({
    view(editorView) {
      viewRef = editorView;
      return {
        destroy() {
          viewRef = null;
        },
      };
    },
    props: {
      decorations(state) {
        if (state.doc.firstChild?.type?.name === "frontmatter") {
          return DecorationSet.empty;
        }
        const button = el("button", "properties-add", "+ Add property");
        button.type = "button";
        button.addEventListener("mousedown", (e) => {
          e.preventDefault();
          if (!viewRef) return;
          viewRef.dispatch(
            viewRef.state.tr.insert(0, nodeType.create({ value: "" })),
          );
        });
        const widget = Decoration.widget(
          0,
          () => {
            const wrap = el("div", "properties-empty");
            wrap.appendChild(button);
            return wrap;
          },
          { side: -1, ignoreSelection: true },
        );
        return DecorationSet.create(state.doc, [widget]);
      },
    },
  });
});

export default [propertiesPanel, propertiesEmptyState];
