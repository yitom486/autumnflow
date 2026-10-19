/**
 * AutumnFlow unified Desktop dev orchestrator.
 * Handles:
 * 1. Check development ports without stopping other applications
 * 2. Compiles desktop/main.ts and desktop/preload.ts
 * 3. Starts dev server and Vite client with color-coded prefix logs
 * 4. Waits for Vite dev server (port 5188) to be ready before launching Electron
 * 5. Watches desktop/ directory for changes and rebuilds main bundle
 * 6. Clean process-tree shutdown on Ctrl+C or when Electron exits
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { resolveRuntimeConfig } from "../shared/runtime-config";
import { assertPortAvailable } from "../server/port-availability";
import * as fs from "node:fs";
import * as path from "node:path";

const isWin = process.platform === "win32";
const runtime = resolveRuntimeConfig(process.env, process.argv, "development");
const VITE_PORT = runtime.vitePort;
const GATEWAY_PORT = runtime.gatewayPort;
const devEnv = {
  ...process.env,
  ACP_RUNTIME_MODE: "development",
  PORT: String(GATEWAY_PORT),
  HOST: "127.0.0.1",
  MCP_PORT: String(runtime.mcpPort),
  ACP_DEV_VITE_PORT: String(VITE_PORT),
  FORCE_COLOR: "1",
};

const children: ChildProcess[] = [];
let isExiting = false;

// ANSI Colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};

function log(prefix: string, color: string, msg: string) {
  const lines = msg.toString().trimEnd().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    console.log(`${color}[${prefix}]${c.reset} ${line}`);
  }
}

async function cleanupAndExit(code = 0) {
  if (isExiting) return;
  isExiting = true;
  console.log(`\n${c.yellow}[dev:desktop] 正在优雅关闭前后端与桌面进程...${c.reset}`);

  // Collect active child PIDs for atomic batch shutdown
  const pids = children
    .filter((child) => child.exitCode === null && child.signalCode === null)
    .map((child) => child.pid)
    .filter((pid): pid is number => typeof pid === "number");

  if (isWin && pids.length > 0) {
    const pidFlags = pids.flatMap((pid) => ["/PID", String(pid)]);
    try {
      execFileSync("taskkill", ["/F", "/T", ...pidFlags], { windowsHide: true, stdio: "ignore" });
    } catch (error) {
      // taskkill may race a child's normal exit. Verify below before reporting success.
      log("dev:desktop", c.yellow, `进程树关闭检查: ${(error as Error).message}`);
    }
  } else {
    for (const child of children) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  }

  const deadline = Date.now() + 5000;
  const active = () => children.filter(child => child.pid && child.exitCode === null && child.signalCode === null);
  while (active().length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (active().length) {
    log("dev:desktop", c.red, `未能关闭本次启动的进程: ${active().map(child => child.pid).join(", ")}`);
    process.exit(1);
  }
  console.log(`${c.green}[dev:desktop] 所有服务已安全退出。${c.reset}`);
  process.exit(code);
}

process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGTERM", () => cleanupAndExit(0));

async function waitForVite(port: number, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  const urls = [`http://localhost:${port}/`, `http://127.0.0.1:${port}/`];

  while (Date.now() - start < timeoutMs) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        await res.body?.cancel();
        if (res.status < 500) return true;
      } catch {
        // still starting up
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function buildElectron(): Promise<boolean> {
  const mainBuild = await Bun.build({
    entrypoints: ["desktop/main.ts"],
    target: "node",
    format: "cjs",
    // node-pty external（同 desktop/build.ts）：native 不可打包进 cjs。
    external: ["electron", "node-pty"],
    outdir: "electron-dist",
    naming: "main.cjs",
  });

  const preloadBuild = await Bun.build({
    entrypoints: ["desktop/preload.ts"],
    target: "node",
    format: "cjs",
    external: ["electron"],
    outdir: "electron-dist",
    naming: "preload.cjs",
  });

  return mainBuild.success && preloadBuild.success;
}

function startSubProcess(name: string, color: string, cmd: string, args: string[]): ChildProcess {
  const child = spawn(cmd, args, {
    shell: false,
    // Windows detached consoles can be surfaced by Bun's watch subprocess even
    // with windowsHide. Direct service PIDs avoid script-shell orphaning without
    // allocating a new console; POSIX still needs a group for tree shutdown.
    detached: !isWin,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: devEnv,
  });

  child.stdout?.on("data", (data) => log(name, color, data));
  child.stderr?.on("data", (data) => log(name, color, data));

  child.on("error", (error) => {
    log(name, c.red, `启动失败: ${error.message}`);
    void cleanupAndExit(1);
  });
  child.on("exit", (code) => {
    if (!isExiting) {
      log(name, c.red, `进程已退出 (code: ${code})`);
      void cleanupAndExit(code || 1);
    }
  });

  children.push(child);
  return child;
}

async function main() {
  console.log(`${c.bold}${c.magenta}=== AutumnFlow 桌面端集成开发环境启动中 ===${c.reset}\n`);

  // Never reclaim a port by killing its owner: it may be the release app.
  await assertPortAvailable(GATEWAY_PORT);
  await assertPortAvailable(VITE_PORT, "0.0.0.0", "Vite");
  console.log(`[launcher] 开发网关 ${GATEWAY_PORT}，开发页面 ${VITE_PORT}；正式版默认使用 13005。`);

  // 2. Build electron bundle
  console.log(`${c.cyan}[build] 正在编译 Electron 主进程与 Preload 脚本...${c.reset}`);
  const ok = await buildElectron();
  if (!ok) {
    console.error(`${c.red}[build] Electron 编译失败，请检查报错！${c.reset}`);
    process.exit(1);
  }
  console.log(`${c.green}[build] 编译完成 (electron-dist/main.cjs + preload.cjs)${c.reset}\n`);

  // 3. Start Gateway Server & Vite Client
  // 默认 Bun 网关（快、有 watch）；ACP_GATEWAY=node 时改跑 Node 网关，
  // 真 PTY（node-pty）只在 Node 网关下可用（Bun 下无 native，回落单次模式）。
  const useNodeGateway = process.env.ACP_GATEWAY === "node";
  if (useNodeGateway) {
    console.log(`${c.cyan}[launcher] ACP_GATEWAY=node：改跑 Node 网关，真 PTY 可用。${c.reset}`);
  }
  if (useNodeGateway) {
    const nodeExecutable = Bun.which("node");
    if (!nodeExecutable) throw new Error("ACP_GATEWAY=node 需要 PATH 中安装 Node.js。");
    const build = await Bun.build({ entrypoints: ["server/node.ts"], target: "node", outdir: ".tmp-node" });
    if (!build.success) throw new AggregateError(build.logs, "Node 网关编译失败");
    startSubProcess("server", c.cyan, nodeExecutable, [".tmp-node/node.js", "--development"]);
  } else {
    startSubProcess("server", c.cyan, process.execPath, ["--watch", "server/index.ts"]);
  }
  // Track Vite itself, not a bun-run/script-shell wrapper that can exit first
  // on Windows Ctrl+C and leave its node process holding the port.
  const viteCli = path.join(path.dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin/vite.js");
  startSubProcess("client", c.green, process.execPath, [viteCli]);

  // 4. Wait for Vite client ready
  console.log(`${c.yellow}[launcher] 正在等待 Vite 开发服务器就绪 (http://localhost:${VITE_PORT})...${c.reset}`);
  const viteReady = await waitForVite(VITE_PORT);
  if (!viteReady) {
    throw new Error(`Vite 启动超时 (http://localhost:${VITE_PORT})，请检查上方日志后重试。`);
  } else {
    console.log(`${c.green}[launcher] Vite 开发服务器已就绪！秒开桌面窗口...${c.reset}\n`);
  }

  if (!await waitForVite(GATEWAY_PORT)) {
    throw new Error(`开发网关启动超时 (http://127.0.0.1:${GATEWAY_PORT})，请检查上方日志后重试。`);
  }

  // Resolve the installed Electron executable and spawn it directly, without a shell.
  const electronExecutable = createRequire(import.meta.url)("electron") as string;
  const electronEnv: NodeJS.ProcessEnv = { ...devEnv, ELECTRON_DEV: "1", ELECTRON_START_URL: `http://localhost:${VITE_PORT}` };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const electronProc = spawn(electronExecutable, ["electron-dist/main.cjs"], {
    shell: false,
    detached: !isWin,
    // This is the user-facing GUI. SW_HIDE can hide Electron's first native
    // window even while its renderer and ACP connection are already running.
    windowsHide: false,
    stdio: "inherit",
    env: electronEnv,
  });
  electronProc.on("error", (error) => {
    console.error(`[electron] 启动失败: ${error.message}`);
    void cleanupAndExit(1);
  });

  children.push(electronProc);
  console.log(`[launcher] Electron 已启动 (PID ${electronProc.pid})`);

  // When Electron GUI window closes, cleanly shut down server and client
  electronProc.on("exit", (code) => {
    console.log(`\n${c.cyan}[electron] 桌面窗口已关闭${c.reset}`);
    cleanupAndExit(code || 0);
  });

  // 6. Watch desktop directory for edits
  let buildDebounce: Timer | null = null;
  fs.watch("desktop", { recursive: false }, (_event, filename) => {
    if (filename !== "main.ts" && filename !== "preload.ts") return;

    if (buildDebounce) clearTimeout(buildDebounce);
    buildDebounce = setTimeout(async () => {
      console.log(`\n${c.yellow}[watch] 检测到 desktop/${filename} 变更，正在增量构建...${c.reset}`);
      const success = await buildElectron();
      if (success) {
        console.log(`${c.green}[watch] Electron 主进程构建就绪！${c.reset}`);
      }
    }, 200);
  });
}

main().catch((err) => {
  console.error(err);
  cleanupAndExit(1);
});
