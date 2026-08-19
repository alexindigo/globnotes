import "./prism-global.js";
import codeSyntaxHighlight from "@toast-ui/editor-plugin-code-syntax-highlight/dist/toastui-editor-plugin-code-syntax-highlight-all.js";

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
  // Style Obsidian-style callouts (> [!note] ...) with per-type classes.
  // The convertor key is camelCase: blockQuote (matching toastui's base
  // convertor name — a lowercase key would never be invoked).
  blockQuote(node, { entering, getChildrenText, origin }) {
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
  // Text tokens carry their text at .content (top level), not
  // .attributes.content — read both to stay compatible.
  text(_, { entering, origin }) {
    const original = origin();
    if (!entering) {
      return original;
    }
    const source = original.content ?? original.attributes?.content ?? "";
    let content = source;
    if (pendingCalloutMarker) {
      pendingCalloutMarker = false;
      content = content.replace(/^\s*\[!\w+\]\s*/, "");
    }
    if (!content.includes("==")) {
      if (content === source) {
        return original;
      }
      return { ...original, content };
    }
    const parts = content.split(/(==[^=\n]+==)/g);
    if (parts.length === 1) {
      return { ...original, content };
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
          content: highlight[1],
        });
        tokens.push({ type: "closeTag", tagName: "mark" });
      } else {
        tokens.push({ ...original, content: part });
      }
    }
    return tokens;
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
