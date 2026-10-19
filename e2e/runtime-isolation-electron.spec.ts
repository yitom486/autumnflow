import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createViteServer } from "vite";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchElectronApp, type LaunchedApp } from "./helpers/launch-electron";
import { TEST_GATEWAY_TOKEN } from "../tests/helpers/gateway-auth";

async function freePort() {
  const listener = createNetServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as { port: number };
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

for (const order of ["development-first", "release-first"] as const) {
  test(`development and release coexist: ${order}`, async ({}, testInfo) => {
    test.setTimeout(90000);
    const root = fileURLToPath(new URL("../", import.meta.url));
    const developmentPort = await freePort();
    const mcpPort = await freePort();
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-runtime-isolation-"));
    const tokenEnv = { ACP_GATEWAY_TOKEN: TEST_GATEWAY_TOKEN };
    const developmentEnv = { ...tokenEnv, AUTUMNFLOW_HOME: path.join(stateRoot, "dev-home"),
      ACP_AGENTS_FILE: path.join(stateRoot, "dev-agents.json"),
      AUTUMNFLOW_RESOURCES_DIR: path.join(stateRoot, "dev-resources") };
    const developmentAgent = [{ id: "e2e-agent", name: "e2e-agent", title: "Development Test Agent",
      command: process.platform === "win32" ? "bun.exe" : "bun",
      args: ["run", path.join(root, "tests/fixtures/e2e-studio-agent.ts")], builtin: false }];
    const headers = { Authorization: `Bearer ${TEST_GATEWAY_TOKEN}` };
    const backend = spawn(process.platform === "win32" ? "bun.exe" : "bun", ["server/index.ts", "--development"], {
      cwd: root, windowsHide: true, stdio: "pipe",
      env: { ...process.env, ...developmentEnv, PORT: String(developmentPort), MCP_PORT: String(mcpPort),
        ACP_AGENTS_JSON: JSON.stringify(developmentAgent) },
    });
    backend.stdout?.resume();
    backend.stderr?.resume();
    let development: LaunchedApp | undefined;
    let release: LaunchedApp | undefined;
    let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
    try {
      await expect.poll(async () => {
        try { return (await fetch(`http://127.0.0.1:${developmentPort}/api/universal/agents`, { headers })).status; }
        catch { return 0; }
      }, { timeout: 20000 }).toBe(200);
      vite = await createViteServer({
        server: { host: "127.0.0.1", port: await freePort(), strictPort: true,
          proxy: { "/api": { target: `http://127.0.0.1:${developmentPort}` } } },
      });
      await vite.listen();
      const { port: vitePort } = vite.httpServer!.address() as { port: number };
      const startDevelopment = async () => {
        development = await launchElectronApp({ port: developmentPort,
          developmentUrl: `http://127.0.0.1:${vitePort}`, env: developmentEnv });
        await expect(development.page.locator("aside").first()).toBeVisible({ timeout: 20000 });
      };
      const startRelease = async () => {
        release = await launchElectronApp({ env: { ...tokenEnv, MCP_PORT: String(await freePort()),
          ACP_AGENTS_FILE: path.join(stateRoot, "release-agents.json"),
          AUTUMNFLOW_RESOURCES_DIR: path.join(stateRoot, "release-resources") } });
        await expect(release.page.locator("aside").first()).toBeVisible({ timeout: 20000 });
      };
      if (order === "development-first") { await startDevelopment(); await startRelease(); }
      else { await startRelease(); await startDevelopment(); }
      expect(development!.app.process().exitCode).toBeNull();
      expect(release!.app.process().exitCode).toBeNull();
      for (const launched of [development!, release!]) {
        await expect(launched.page.locator("textarea").first()).toBeVisible();
        const result = await launched.page.evaluate(async () => {
          const token = await window.autumnflow!.getGatewayToken!();
          const response = await fetch(
            "/api/universal/agents",
            token ? { headers: { Authorization: `Bearer ${token}` } } : {},
          );
          return (await response.json()).agents.find((agent: { id: string }) => agent.id === "e2e-agent").title;
        });
        expect(result).toBe(launched === development ? "Development Test Agent" : "E2E Test Agent");
        const gap = await launched.page.locator('[role="treeitem"][aria-expanded]').first().evaluate(row => {
          const slot = row.firstElementChild!;
          const text = slot.nextElementSibling!;
          return text.getBoundingClientRect().left - Math.max(...[...slot.querySelectorAll("svg")].map(icon => icon.getBoundingClientRect().right));
        });
        expect(gap).toBeGreaterThanOrEqual(7.9);
        await launched.page.screenshot({ path: testInfo.outputPath(launched === development ? "development.png" : "release.png") });
      }
      if (order === "development-first") {
        await release!.cleanup(); release = undefined;
        await expect(development!.page.locator("aside").first()).toBeVisible();
        expect((await fetch(`http://127.0.0.1:${developmentPort}/api/universal/agents`, { headers })).status).toBe(200);
      } else {
        await development!.cleanup(); development = undefined;
        await expect(release!.page.locator("aside").first()).toBeVisible();
        expect((await fetch(`http://127.0.0.1:${release!.port}/api/universal/agents`, { headers })).status).toBe(200);
      }
    } finally {
      if (development) await development.cleanup();
      if (release) await release.cleanup();
      if (vite) await vite.close();
      const stopped = once(backend, "exit");
      backend.kill();
      if (backend.exitCode === null) await stopped;
      const target = path.resolve(stateRoot);
      if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith("acp-runtime-isolation-")) {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      }
    }
  });
}
