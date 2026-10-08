import { defineConfig } from "vite";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// Host-owned packages a plugin module may import (dual-mode contract).
// Production resolves them through the plugin-sdk entry chunk + import
// map, using the same module instances and shared aliases as the app.
const SDK_PACKAGES = [
  "@milkdown/core",
  "@milkdown/ctx",
  "@milkdown/utils",
  "prosemirror-state",
  "prosemirror-view",
  "@globnotes/frontmatter-node",
  "@globnotes/frontmatter",
  "@globnotes/plugin-sdk",
];

// Build-time import map for backend-served plugin browser/editor entries.
function pluginSdkImportMap() {
  return {
    name: "globnotes-plugin-sdk-import-map",
    apply: "build",
    enforce: "pre",
    // Production: inject the import map that resolves plugin modules'
    // bare SDK imports to the plugin-sdk entry chunk.
    transformIndexHtml(html, ctx) {
      if (!ctx.bundle) return html;
      const sdk = Object.values(ctx.bundle).find(
        (chunk) => chunk.isEntry && chunk.name === "plugin-sdk",
      );
      if (!sdk) return html;
      const map = {
        imports: Object.fromEntries(
          SDK_PACKAGES.map((p) => [p, `/_/${sdk.fileName}`]),
        ),
      };
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: { type: "importmap" },
            children: JSON.stringify(map),
            injectTo: "head-prepend",
          },
        ],
      };
    },
  };
}

export default defineConfig({
  css: {
    // Loader-time resolution of postcss.config.js silently drops plugins
    // under Deno; inject the plugins explicitly instead.
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  plugins: [vue(), pluginSdkImportMap()],
  root: "client",
  base: "/_/",
  experimental: {
    // HTML is stamped with the deployment prefix by the server. URLs inside
    // bundles must follow their owning file so the same build supports it.
    renderBuiltUrl(_filename, { hostType }) {
      if (hostType === "js" || hostType === "css") return { relative: true };
    },
  },
  // The @globnotes/* specifiers are the host-owned shared halves a plugin
  // client module imports (frontmatter node + YAML subset); they resolve
  // to the same files the app itself imports, so module instances dedupe.
  resolve: {
    alias: [
      {
        find: /^@globnotes\/frontmatter-node$/,
        replacement: path.resolve(repoRoot, "client/frontmatter-node.js"),
      },
      {
        find: /^@globnotes\/frontmatter$/,
        replacement: path.resolve(repoRoot, "shared/frontmatter.ts"),
      },
      {
        find: /^@globnotes\/plugin-sdk$/,
        replacement: path.resolve(repoRoot, "client/plugin-sdk.js"),
      },
    ],
  },
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(repoRoot, "client", "index.html"),
        "plugin-sdk": path.resolve(repoRoot, "client", "plugin-sdk-entry.js"),
      },
      // The sdk entry's public API IS its re-exports; nothing inside the
      // app consumes them, so the entry signature must be pinned or the
      // treeshaker prunes the whole namespace.
      preserveEntrySignatures: "strict",
    },
  },
});
