import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // A spec drives the whole app (zoom, fullscreen, clipboard, download) after
  // the diagram appears, so the per-test budget has to cover a slow runner.
  timeout: 120000,
  // CI runners are several times slower than a developer machine and every
  // spec drives a real Electron app (tabs, clipboard, downloads). A single
  // retry absorbs the timing flakes without hiding real failures: a broken
  // behaviour fails both attempts.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
  },
});
