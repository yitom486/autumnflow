import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { TEST_GATEWAY_TOKEN } from "../../tests/helpers/gateway-auth";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

const availablePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(selected));
  });
});

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  port: number;
  userDataDir: string;
  cleanup: () => Promise<void>;
}

export async function launchElectronApp(options?: {
  port?: number;
  developmentUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LaunchedApp> {
  const port = options?.port || await availablePort();
  const mcpPort = await availablePort();
  const tmpDir = path.join(
    os.tmpdir(),
    `autumnflow-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  const workspace = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspace);

  // The desktop shell keeps running in the tray when the last window closes
  // with work in flight, so app.close() would never resolve and the temp dir
  // would stay locked. E2E runs are not interactive: residency is off.
  fs.writeFileSync(
    path.join(tmpDir, "background.json"),
    JSON.stringify({ enabled: false, idleExitMinutes: 0 }),
    "utf-8"
  );

  const agentFixturePath = path.join(projectRoot, "tests/fixtures/e2e-studio-agent.ts");
  const agentsConfig = [
    {
      id: "e2e-agent",
      name: "e2e-agent",
      title: "E2E Test Agent",
      command: process.platform === "win32" ? "bun.exe" : "bun",
      args: ["run", agentFixturePath],
      builtin: false,
    },
  ];

  // Path to built Electron main bundle
  const mainScript = path.join(projectRoot, "electron-dist/main.cjs");

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_START_URL;
  const app = await electron.launch({
    cwd: projectRoot,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      mainScript,
      `--user-data-dir=${tmpDir}`,
    ],
    env: {
      ...env,
      PORT: String(port),
      MCP_PORT: String(mcpPort),
      ACP_PUBLIC_DIR: path.join(projectRoot, "dist"),
      ACP_USER_DATA_DIR: tmpDir,
      AUTUMNFLOW_HOME: path.join(tmpDir, "home"),
      ACP_GATEWAY_TOKEN: TEST_GATEWAY_TOKEN,
      ACP_AGENTS_FILE: path.join(tmpDir, "agents.json"),
      AUTUMNFLOW_RESOURCES_DIR: path.join(tmpDir, "resources"),
      ACP_AGENTS_JSON: JSON.stringify(agentsConfig),
      ELECTRON_DEV: options?.developmentUrl ? "1" : "0",
      NODE_ENV: "production",
      ACP_DISABLE_UI_PROMPT_HINT: "1",
      ACP_DEFAULT_AGENT_ID: "e2e-agent",
      ACP_DISABLE_UPDATES: "1",
      // The quit guard is a modal dialog: nothing can answer it in a test, so
      // a programmatic close would hang until the test times out.
      ACP_DISABLE_ACTIVE_WORK_GUARD: "1",
      ELECTRON_START_URL: `http://127.0.0.1:${port}/?cwd=${encodeURIComponent(workspace)}`,
      ...options?.env,
      ...(options?.developmentUrl ? {
        ELECTRON_START_URL: `${options.developmentUrl}/?cwd=${encodeURIComponent(workspace)}`,
      } : {}),
    },
  });

  const cleanup = async () => {
    try { await app.close(); } finally {
      const target = path.resolve(tmpDir);
      if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith("autumnflow-e2e-")) {
        // Cleanup must never mask the real failure: a still-locked directory
        // (Windows keeps handles for a moment) is reported, not thrown.
        try {
          fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        } catch (err) {
          console.warn(`[e2e] temp dir cleanup skipped: ${(err as Error).message}`);
        }
      }
    }
  };

  // Listen as soon as launch returns, before waiting for the renderer.
  app.process().stdout?.on("data", (chunk) => console.log(`[Electron] ${chunk.toString().trim()}`));
  app.process().stderr?.on("data", (chunk) => console.error(`[Electron] ${chunk.toString().trim()}`));
  let page: Page;
  try {
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
  } catch (error) {
    await cleanup();
    throw error;
  }

  // Pipe logs for clear diagnostics
  page.on("console", (msg) => {
    console.log(`[Browser ${msg.type().toUpperCase()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    console.error(`[Browser PageError]`, err);
  });
  page.on("response", async (res) => {
    if (res.status() >= 400) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {}
      console.error(`[HTTP ${res.status()}] ${res.url()} -> ${bodyText}`);
    }
  });

  return {
    app,
    page,
    port,
    userDataDir: tmpDir,
    cleanup,
  };
}
