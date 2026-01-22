import { defineConfig } from "@playwright/test";

export default defineConfig({
  timeout: 60000,
  globalSetup: "./tests/global-setup.ts",
  testDir: "./tests/playwright",
  reporter: [
    ["line"],
    ["junit", { outputFile: "report-playwright.junit.xml" }],
    [
      "monocart-reporter",
      {
        outputFile: "./test-results/report-playwright.html",
        coverage: {
          lcov: true,
          outputDir: "./coverage-playwright",
          reports: ["lcovonly", "text"],
          entryFilter: (entry: { url: string }) => {
            return entry.url.includes("packages/node/export");
          },
          sourceFilter: (sourcePath: string) => {
            return sourcePath.includes("packages/node/export");
          },
        },
      },
    ],
  ],
});
