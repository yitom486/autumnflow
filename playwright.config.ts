import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // A spec drives the whole app (zoom, fullscreen, clipboard, download) after
  // the diagram appears, so the per-test budget has to cover a slow runner.
  timeout: 120000,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
  },
});
