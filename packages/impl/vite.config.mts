import { resolve } from 'node:path';
import { codecovVitePlugin } from '@codecov/vite-plugin';
import nodeResolve from '@rollup/plugin-node-resolve';
import nodeExternals from 'rollup-plugin-node-externals';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    lib: {
      entry: resolve('export/index.ts'),
      fileName: 'index',
      formats: ['es', 'cjs']
    },
    outDir: 'export_dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {}
  },
  test: {
    watch: false,
    pool: 'threads',
    maxWorkers: 1,
    isolate: false,
    passWithNoTests: true,
    coverage: {
      provider: 'istanbul',
      reporter: ['lcov'],
      reportsDirectory: './coverage-unittest'
    },
    reporters: ['default', ['junit', { outputFile: 'report-unittest.junit.xml' }]],
    include: ['tests/unittest/**/*.test.ts']
  },
  plugins: [
    nodeExternals(),
    nodeResolve(),
    dts({
      staticImport: true,
      entryRoot: 'export'
    }),
    codecovVitePlugin({
      enableBundleAnalysis: process.env.CODECOV_TOKEN !== undefined,
      bundleName: 'node-reqwest',
      uploadToken: process.env.CODECOV_TOKEN
    })
  ]
});
