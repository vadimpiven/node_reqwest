import { resolve } from "node:path";
import { codecovVitePlugin } from "@codecov/vite-plugin";
import nodeResolve from "@rollup/plugin-node-resolve";
import nodeExternals from "rollup-plugin-node-externals";
import dts from "vite-plugin-dts";
import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    lib: {
      entry: resolve("export/index.ts"),
      fileName: "index",
      formats: ["es", "cjs"],
    },
    outDir: "export_dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {},
  },
  test: {
    testTimeout: 30000,
    globalSetup: "./tests/global-setup.ts",
    watch: false,
    pool: "threads",
    maxWorkers: 1,
    isolate: false,
    passWithNoTests: true,
    coverage: {
      provider: "istanbul",
      reporter: ["lcovonly", "text"],
      reportsDirectory: "./coverage-vitest",
    },
    reporters: ["default", ["junit", { outputFile: "report-vitest.junit.xml" }]],
    include: ["tests/vitest/**/*.test.ts"],
  },
  plugins: [
    nodeExternals(),
    nodeResolve(),
    dts({
      staticImport: true,
      entryRoot: "export",
    }),
    codecovVitePlugin({
      enableBundleAnalysis: process.env.CODECOV_TOKEN !== undefined,
      bundleName: "node-reqwest",
      uploadToken: process.env.CODECOV_TOKEN,
    }),
  ],
});
