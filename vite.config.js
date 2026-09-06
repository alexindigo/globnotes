import { defineConfig } from "vite";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";

const devApiUrl = "http://127.0.0.1:8000";
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// Host-owned packages a plugin's client.js may import (dual-mode plugin
// contract). Production resolves them through the plugin-sdk entry chunk
// + import map; dev serves plugin modules through vite's own transform
// pipeline so they hit the same prebundled dep URLs the app uses.
const SDK_PACKAGES = ["@milkdown/core", "@milkdown/ctx", "@milkdown/utils"];

// Dual-mode plugin client modules in dev: served fresh from disk on every
// request, but TRANSFORMED by vite (rewrite URL into /@fs and let the
// pipeline handle it). Raw proxying would leave bare imports unresolvable
// and duplicate the app's milkdown instances.
function pluginClientModules(base = "/_/") {
  return {
    name: "globnotes-plugin-client-modules",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const raw = (req.url || "").split("?")[0];
        const m = raw.match(/^\/(?:_\/)?plugins\/([^/]+)\/client\.js$/);
        if (!m) return next();
        const id = decodeURIComponent(m[1]);
        const pluginsRoot = path.resolve(repoRoot, "plugins") + path.sep;
        const file = path.resolve(pluginsRoot, id, "client.js");
        if (!file.startsWith(pluginsRoot)) return next();
        req.url = `${base}@fs${file}${(req.url || "").slice(raw.length)}`;
        next();
      });
    },
    // Production: inject the import map that resolves plugin client
    // modules' bare SDK imports to the plugin-sdk entry chunk.
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
  plugins: [vue(), pluginClientModules()],
  root: "client",
  base: "/_/",
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
  server: {
    // Note: The GLOBNOTES_PATH_PREFIX environment variable is not supported by the dev server
    port: 8080,
    // Plugin client modules are served (transformed) from ../plugins via
    // /@fs — widen the dev allow list to the repo root for exactly that.
    fs: {
      allow: [repoRoot],
    },
    proxy: {
      "/_/api/": {
        target: devApiUrl,
        changeOrigin: true,
      },
    },
  },
});
