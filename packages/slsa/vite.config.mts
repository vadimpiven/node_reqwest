import { builtinModules } from "node:module";
import { resolve } from "node:path";
import dts from "vite-plugin-dts";
import { defineConfig } from "vitest/config";

// Externalize all Node.js built-ins (with and without node: prefix)
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  define: {
    "import.meta.vitest": "undefined",
  },
  build: {
    lib: {
      entry: resolve("src/index.ts"),
      fileName: "index",
      formats: ["es"],
    },
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: nodeBuiltins,
      platform: "node",
    },
  },
  test: {
    watch: false,
    pool: "forks",
    passWithNoTests: true,
    coverage: {
      provider: "istanbul",
      reporter: ["lcovonly", "text"],
      reportsDirectory: "./coverage-vitest",
    },
    reporters: ["default"],
    detectAsyncLeaks: false,
    includeSource: ["src/**/*.ts"],
    include: ["tests/vitest/**/*.test.ts"],
  },
  plugins: [
    dts({
      staticImport: true,
      entryRoot: "src",
    }),
  ],
});
