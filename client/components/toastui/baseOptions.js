import codeSyntaxHighlight from "@toast-ui/editor-plugin-code-syntax-highlight/dist/toastui-editor-plugin-code-syntax-highlight-all.js";
import router from "../../router.js";

// The directory (relative to the notes root) of the note currently being
// viewed or edited. Used to resolve relative file/note URLs. Set by the
// note view whenever the note changes.
let currentNoteDir = "";

export function setCurrentNoteDir(dir) {
  currentNoteDir = dir || "";
}

function isRelativeUrl(url) {
  // Absolute URLs (scheme, protocol-relative, root-relative) and pure
  // anchors are left untouched.
  return !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url);
}

export function resolveFileUrl(url) {
  // A relative file URL is resolved against the current note's directory
  // and served by the /files route. Kept root-relative (no leading slash)
  // so the <base href> tag applies any path prefix.
  const path = currentNoteDir ? `${currentNoteDir}/${url}` : url;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `files/${encoded}`;
}

function resolveNoteUrl(url) {
  // A relative markdown link (e.g. [x](../other.md)) resolves to the note
  // route for the corresponding note.
  const decoded = decodeURIComponent(url);
  const title = currentNoteDir
    ? `${currentNoteDir}/${decoded.slice(0, -".md".length)}`
    : decoded.slice(0, -".md".length);
  return router.resolve({ name: "note", params: { title } }).href;
}

export function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-\s]*/g, "")
    .trim()
    .replace(/\s/g, "-");
}

// Set when a callout blockquote (e.g. > [!note]) is entered, so the first
// text node inside it can strip the [!type] marker.
let pendingCalloutMarker = false;

const customHTMLRenderer = {
  // Add id attribute to headings
  heading(node, { entering, getChildrenText, origin }) {
    const original = origin();
    if (entering) {
      original.attributes = {
        id: slugifyHeading(getChildrenText(node)),
      };
    }
    return original;
  },
  // Style Obsidian-style callouts (> [!note] ...) with per-type classes
  blockquote(node, { entering, getChildrenText, origin }) {
    const original = origin();
    if (entering) {
      const match = getChildrenText(node)
        .trimStart()
        .match(/^\[!(\w+)\]/);
      if (match) {
        pendingCalloutMarker = true;
        original.attributes = {
          ...original.attributes,
          class: `callout callout-${match[1].toLowerCase()}`,
        };
      }
    }
    return original;
  },
  // ==highlight== and callout marker stripping
  text(_, { entering, origin }) {
    const original = origin();
    if (!entering) {
      return original;
    }
    let content = original.attributes?.content ?? "";
    if (pendingCalloutMarker) {
      pendingCalloutMarker = false;
      content = content.replace(/^\s*\[!\w+\]\s*/, "");
    }
    if (!content.includes("==")) {
      if (content === original.attributes?.content) {
        return original;
      }
      return { ...original, attributes: { ...original.attributes, content } };
    }
    const parts = content.split(/(==[^=\n]+==)/g);
    if (parts.length === 1) {
      return { ...original, attributes: { ...original.attributes, content } };
    }
    const tokens = [];
    for (const part of parts) {
      if (!part) {
        continue;
      }
      const highlight = part.match(/^==([^=\n]+)==$/);
      if (highlight) {
        tokens.push({ type: "openTag", tagName: "mark" });
        tokens.push({
          type: "text",
          attributes: { content: highlight[1] },
        });
        tokens.push({ type: "closeTag", tagName: "mark" });
      } else {
        tokens.push({
          ...original,
          attributes: { ...original.attributes, content: part },
        });
      }
    }
    return tokens;
  },
  // Convert relative hash links to absolute links; resolve relative file
  // and note links against the current note's directory
  link(_, { entering, origin }) {
    const original = origin();
    if (entering) {
      const href = original.attributes.href;
      if (href.startsWith("#")) {
        const targetRoute = {
          ...router.currentRoute.value,
          hash: href,
        };
        original.attributes.href = router.resolve(targetRoute).href;
      } else if (isRelativeUrl(href)) {
        original.attributes.href = href.toLowerCase().endsWith(".md")
          ? resolveNoteUrl(href)
          : resolveFileUrl(href);
      }
    }
    return original;
  },
  // Resolve relative image URLs against the current note's directory
  image(_, { entering, origin }) {
    const original = origin();
    if (entering && isRelativeUrl(original.attributes.src)) {
      original.attributes.src = resolveFileUrl(original.attributes.src);
    }
    return original;
  },
  // Render mermaid code blocks as diagrams (rendered client-side by
  // mermaid.js after mount)
  codeBlock(node, { origin }) {
    if ((node.info || "").trim().toLowerCase() !== "mermaid") {
      return origin();
    }
    return [
      { type: "openTag", tagName: "pre", attributes: { class: "mermaid" } },
      { type: "text", attributes: { content: node.literal } },
      { type: "closeTag", tagName: "pre" },
    ];
  },
};

const baseOptions = {
  height: "100%",
  plugins: [codeSyntaxHighlight],
  customHTMLRenderer: customHTMLRenderer,
  frontMatter: true,
  usageStatistics: false,
};

export default baseOptions;
