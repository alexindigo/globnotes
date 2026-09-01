import { defineConfig } from "vite";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import vue from "@vitejs/plugin-vue";

const devApiUrl = "http://127.0.0.1:8000";

export default defineConfig({
  css: {
    // Loader-time resolution of postcss.config.js silently drops plugins
    // under Deno; inject the plugins explicitly instead.
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  plugins: [vue()],
  root: "client",
  base: "/_/",
  server: {
    // Note: The GLOBNOTES_PATH_PREFIX environment variable is not supported by the dev server
    port: 8080,
    proxy: {
      "/_/api/": {
        target: devApiUrl,
        changeOrigin: true,
      },
    },
  },
});
