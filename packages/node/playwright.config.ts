import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/electron',
  reporter: [
    ['line'],
    ['junit', { outputFile: 'report-electron.junit.xml' }],
    [
      'monocart-reporter',
      {
        outputFile: './test-results/electron-report.html',
        coverage: {
          lcov: true,
          outputDir: './coverage-electron',
          reports: ['lcovonly', 'text'],
          entryFilter: (entry: { url: string }) => {
            return entry.url.includes('packages/node/export');
          },
          sourceFilter: (sourcePath: string) => {
            return sourcePath.includes('packages/node/export');
          }
        }
      }
    ]
  ]
});
