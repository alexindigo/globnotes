import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
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
    ],
  },
  test: {
    environment: "jsdom",
    include: ["client/tests/**/*.test.js"],
    setupFiles: ["client/tests/setup.js"],
  },
});
