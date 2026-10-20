// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __setLatestCacheForTest, clearLatestCache, latestVersionCached,
  refreshLatestVersion, MANAGED_AGENTS, checkAgent,
} from "../../server/universal/agent-installer";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-npm-query-"));
const calls = path.join(root, "calls.log");
const keys = ["ACP_NPM_BIN", "ACP_LATEST_TTL_MS", "ACP_TEST_NPM_CALLS", "ACP_TEST_NPM_DELAY"];
const previous = keys.map((key) => process.env[key]);
beforeAll(() => {
  const fixture = fs.readFileSync(path.resolve("tests/fixtures/mock-npm-cli.cjs"), "utf8");
  if (process.platform === "win32") {
    process.env.ACP_NPM_BIN = path.join(root, "npm.cmd");
    fs.writeFileSync(process.env.ACP_NPM_BIN, "@echo off\r\n");
    const cliDir = path.join(root, "node_modules", "npm", "bin");
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, "npm-cli.js"), fixture);
  } else {
    process.env.ACP_NPM_BIN = path.join(root, "npm");
    fs.writeFileSync(process.env.ACP_NPM_BIN, `#!${process.execPath}\n${fixture}`);
    fs.chmodSync(process.env.ACP_NPM_BIN, 0o755);
  }
  process.env.ACP_TEST_NPM_CALLS = calls;
  process.env.ACP_LATEST_TTL_MS = "600000";
  process.env.ACP_TEST_NPM_DELAY = "250";
});
afterAll(() => {
  keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
  clearLatestCache();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Wait until the mock registry recorded another query, then return the log. */
async function waitForCallLog(previousLength: number, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = fs.readFileSync(calls, "utf8");
    if (current.length > previousLength) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the mock registry never recorded the query");
}

describe("background registry version refresh (offline subprocess)", () => {
  it("returns immediately on a cold status read, deduplicates queries and keeps timers running", async () => {
    clearLatestCache();
    MANAGED_AGENTS.push({ id: "test-async-version", pkg: "test-success", exeRel: "none", headlessRel: "none" });
    try {
      let completed = false;
      let heartbeatRan = false;
      const heartbeat = new Promise<void>((resolve) => setTimeout(() => { heartbeatRan = true; resolve(); }, 20));
      expect(checkAgent("test-async-version").latestVersion).toBeNull();
      const pending = refreshLatestVersion("test-success");
      expect(refreshLatestVersion("test-success")).toBe(pending);
      const settled = pending.then((version) => { completed = true; return version; });
      for (let index = 0; index < 10; index++) expect(latestVersionCached("test-success")).toBeNull();
      await heartbeat;
      expect(heartbeatRan).toBe(true);
      expect(completed).toBe(false);
      expect(await settled).toBe("9.9.9-test");
      expect(latestVersionCached("test-success")).toBe("9.9.9-test");
      expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      MANAGED_AGENTS.splice(MANAGED_AGENTS.findIndex((spec) => spec.id === "test-async-version"), 1);
    }
  });
  it("serves an expired value while one fresh query is pending", async () => {
    clearLatestCache();
    __setLatestCacheForTest("test-stale", "1.0.0", 0);
    expect(latestVersionCached("test-stale")).toBe("1.0.0");
    expect(await refreshLatestVersion("test-stale")).toBe("9.9.9-test");
    expect(latestVersionCached("test-stale")).toBe("9.9.9-test");
  });
  it("logs failed queries and caches the failure without a retry storm", async () => {
    clearLatestCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const before = fs.readFileSync(calls, "utf8");
      expect(await refreshLatestVersion("test-failure")).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("mock registry unavailable"));
      // The mock appends to the call log as it starts; on a loaded machine the
      // append can land a moment after the query settles, so wait for it
      // instead of assuming it is already there.
      const after = await waitForCallLog(before.length);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fs.readFileSync(calls, "utf8")).toBe(after);
    } finally { warn.mockRestore(); }
  });
  it("kills and settles a timed-out query", async () => {
    clearLatestCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await refreshLatestVersion("test-timeout", 40)).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it("does not let a cleared in-flight query overwrite a new cache", async () => {
    clearLatestCache();
    const pending = refreshLatestVersion("test-reset");
    clearLatestCache();
    __setLatestCacheForTest("test-reset", "2.0.0");
    await pending;
    expect(latestVersionCached("test-reset")).toBe("2.0.0");
  });
});
