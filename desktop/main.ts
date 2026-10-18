/**
 * ACP Studio desktop shell (Electron main).
 * Starts the Node gateway in-process, then opens the Studio window on it.
 * Dev: ELECTRON_DEV=1 ELECTRON_START_URL=http://localhost:5188 (external vite+gateway).
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { setupEnv, buildApp, shutdownBridges } from "../server/gateway";
import { resolveRuntimeConfig } from "../shared/runtime-config";
import { assertPortAvailable } from "../server/port-availability";
import { ensureGatewayToken, gatewayTokenPreview } from "../server/universal/security";
import { attachPtyUpgrade } from "../server/universal/pty";
import { initUpdater, checkForUpdatesFromMenu } from "./updater";
import { buildAppMenu, type MenuActions } from "./menu";
import { addRecent, loadRecent } from "./recent";
import { isTrustedSenderUrl } from "./sender-policy";
import {
  RendererConsoleTail,
  pruneCrashReports,
  writeCrashReport,
  type CrashReportApp,
  type CrashReportPhase,
  type CrashReportSource,
} from "./crash-report";
import { setTrashImpl } from "../server/universal/http/files";
import { startMcpUiServer, stopMcpUiServer } from "../server/universal/mcp-ui-server";

const isDev = !app.isPackaged && process.env.ELECTRON_DEV === "1";
const runtime = resolveRuntimeConfig(process.env, process.argv, isDev ? "development" : "production");
const PORT = runtime.gatewayPort;
const START_URL = process.env.ELECTRON_START_URL || (isDev
  ? `http://localhost:${runtime.vitePort}` : `http://127.0.0.1:${PORT}`);

// 设置 Windows 任务栏应用标识与独立分组，确保任务栏图标显示 ACP Studio 猫咪图标而非 Electron 默认原子图标
if (process.platform === "win32") {
  app.setAppUserModelId(isDev ? "studio.acp.app.dev" : "studio.acp.app");
}

// 隔离应用名称与 userData 路径，避免开发模式下与本地其他未打包的 Electron 应用（如 inkdown）
// 共享 %APPDATA%\Electron 导致 Chromium ProcessSingleton 单例锁冲突（0x20 锁文件被占用错误）
app.name = isDev ? "acp-studio-dev" : "acp-studio";
try {
  const customUserData =
    process.env.ACP_USER_DATA_DIR ||
    path.join(app.getPath("appData"), isDev ? "acp-studio-dev" : "acp-studio");
  app.setPath("userData", customUserData);
} catch (err) {
  console.warn("[Electron] 无法设置独立 userData 路径:", err);
}

/** 所有窗口；每个窗口一个工作区（渲染端按窗口用 sessionStorage 隔离“当前工作区”）。 */
const windows = new Set<BrowserWindow>();
let win: BrowserWindow | null = null; // 最近聚焦的窗口
let gateway: { close: (cb?: () => void) => void } | null = null;

const rendererConsole = new RendererConsoleTail();
const crashReportDir = () => path.join(app.getPath("userData"), "logs", "crashes");

function crashAppFacts(): CrashReportApp {
  return {
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron || "unknown",
    node: process.versions.node,
    locale: app.getLocale(),
  };
}

/** Best-effort async crash file; never blocks quitting or masks the failure. */
function recordCrash(source: CrashReportSource, phase: CrashReportPhase, error: unknown): void {
  try {
    const dir = crashReportDir();
    void writeCrashReport(dir, {
      source,
      phase,
      error,
      rendererConsole: rendererConsole.snapshot(),
      app: crashAppFacts(),
      time: new Date(),
    }).then((file) => {
      if (file) console.error(`[Electron] crash report written: ${file}`);
    });
  } catch (err) {
    console.error("[Electron] crash report setup failed:", err);
  }
}

async function startGateway() {
  setupEnv();
  // 本函数只在 !isDev 时被调用：确保 token 已生成并进入进程环境，
  // createWindow 在其之后执行，同一机器前后端共享同一 token。
  const token = ensureGatewayToken();
  if (!process.env.ACP_GATEWAY_TOKEN) process.env.ACP_GATEWAY_TOKEN = token;
  await assertPortAvailable(PORT);

  // 启动专用的 Studio UI MCP Server (自动层叠端口 13920+)
  await startMcpUiServer(runtime.mcpPort).catch((err) => {
    console.warn(`[Electron] 启动 MCP UI 端口服务失败: ${(err as Error)?.message || err}`);
  });

  // Packaged layout: frontend lives under <app>/dist, not cwd.
  // Runner era: agents spawn via bunx/npx directly (windowsHide, no shim);
  // only an explicit AGY_HEADLESS_LAUNCHER env opts back into shimmed spawn.
  if (!isDev) {
    if (!process.env.ACP_PUBLIC_DIR) {
      const candidates = [
        path.join(app.getAppPath(), "dist"),
        path.join(app.getAppPath(), "..", "dist"),
        path.join(__dirname, "..", "dist"),
        path.join(process.cwd(), "dist"),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(path.join(cand, "index.html"))) {
          process.env.ACP_PUBLIC_DIR = cand;
          break;
        }
      }
      if (!process.env.ACP_PUBLIC_DIR) {
        process.env.ACP_PUBLIC_DIR = path.join(app.getAppPath(), "dist");
      }
    }
    try {
      process.chdir(app.getPath("home"));
    } catch {}
  }
  const honoApp = buildApp();
  // hostname 127.0.0.1：只绑回环（ACP_PUBLIC_DIR 逻辑不动）。
  let srv!: Server;
  await new Promise<void>((resolve, reject) => {
    srv = serve({ fetch: honoApp.fetch, port: PORT, hostname: "127.0.0.1" }, () => {
      console.log(`[Electron] gateway listening at http://127.0.0.1:${PORT} (token ${gatewayTokenPreview()})`);
      resolve();
    }) as Server;
    srv.once("error", reject);
  });
  // Never cut long-lived SSE streams.
  srv.requestTimeout = 0;
  srv.headersTimeout = 0;
  // 真 PTY 的 WS 升级（与 server/node.ts 同源；Bun dev 网关无此挂载）。
  void attachPtyUpgrade(srv as never);
  gateway = srv;
  // 删除文件走系统回收站
  setTrashImpl((abs) => shell.trashItem(abs));
}

async function loadURLWithRetry(targetWin: BrowserWindow, url: string, maxRetries = 30, intervalMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    if (targetWin.isDestroyed()) return;
    try {
      await targetWin.loadURL(url);
      return;
    } catch (err: any) {
      if (targetWin.isDestroyed()) return;
      if (i === maxRetries - 1) {
        throw new Error(`无法加载页面 ${url}: ${err?.message || err}`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

function getAppIcon(): Electron.NativeImage | undefined {
  const candidateDirs = [
    isDev ? path.join(app.getAppPath(), "public") : path.join(app.getAppPath(), "dist"),
    path.join(app.getAppPath(), "public"),
    path.join(app.getAppPath(), "dist"),
    path.join(process.cwd(), "public"),
  ];

  const candidateNames = process.platform === "win32"
    ? ["icon.ico", "icon.png"]
    : ["icon.png", "icon.ico"];

  for (const dir of candidateDirs) {
    for (const name of candidateNames) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        try {
          const img = nativeImage.createFromPath(p);
          if (!img.isEmpty()) return img;
        } catch {
          // ignore and continue
        }
      }
    }
  }

  return undefined;
}

function getSavedOverlayConfig(): { color: string; symbolColor: string } {
  try {
    const configPath = path.join(app.getPath("userData"), "theme-overlay.json");
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (data && typeof data.color === "string" && typeof data.symbolColor === "string") {
        return data;
      }
    }
  } catch {
    // fallback
  }
  return { color: "#171717", symbolColor: "#a5a5a5" };
}

function saveOverlayConfig(cfg: { color: string; symbolColor: string }) {
  try {
    const dir = app.getPath("userData");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const configPath = path.join(dir, "theme-overlay.json");
    fs.writeFileSync(configPath, JSON.stringify(cfg), "utf-8");
  } catch {
    // ignore
  }
}

function getPreloadPath(): string {
  const candidates = [
    path.join(app.getAppPath(), "preload.cjs"),
    path.join(app.getAppPath(), "electron-dist", "preload.cjs"),
    path.join(process.cwd(), "electron-dist", "preload.cjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(app.getAppPath(), "electron-dist", "preload.cjs");
}

function windowUrl(cwd?: string): string {
  const u = new URL(START_URL);
  if (cwd) u.searchParams.set("cwd", cwd);
  if (process.env.ACP_DEFAULT_AGENT_ID) {
    u.searchParams.set("agent", process.env.ACP_DEFAULT_AGENT_ID);
  }
  return u.toString();
}

const senderWin = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);
const isOurWindow = (e: Electron.IpcMainInvokeEvent) => {
  const w = senderWin(e);
  return !!w && windows.has(w) && e.senderFrame === w.webContents.mainFrame;
};

/** Only the app-owned main frame may invoke native IPC. */
function assertOurSender(e: Electron.IpcMainInvokeEvent, channel: string): void {
  if (!isOurWindow(e) || !isTrustedSenderUrl(e.senderFrame?.url, START_URL)) {
    throw new Error(`${channel} denied: caller is not the AutumnFlow main window`);
  }
}

async function createWindow(cwd?: string) {
  const isMac = process.platform === "darwin";
  const appIcon = getAppIcon();
  const initialOverlay = getSavedOverlayConfig();

  const w = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    autoHideMenuBar: true,
    // 首帧底色跟随上次保存的主题标题栏色，避免启动时闪一下旧的蓝黑底
    backgroundColor: initialOverlay.color,
    title: "AutumnFlow",
    show: false,
    icon: appIcon,
    titleBarStyle: "hidden",
    ...(isMac
      ? {
          trafficLightPosition: { x: 12, y: 10 },
        }
      : {}),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: false,
    },
  });
  // 先登记再加载页面：渲染端一启动就会通过 gateway:getToken 校验“是否本应用窗口”
  windows.add(w);
  win = w;
  w.webContents.on("console-message", (_event, details) => {
    if (details.level >= 3) {
      rendererConsole.push(`[${new Date().toISOString()}] ${details.message}`);
    }
  });
  w.webContents.on("render-process-gone", (_event, details) => {
    recordCrash(
      "renderer",
      "running",
      new Error(`Renderer process gone: ${details.reason} (exitCode=${details.exitCode})`)
    );
  });
  console.log(`[Electron] 桌面窗口已创建 (${isDev ? "开发版" : "正式版"})`);
  w.once("ready-to-show", () => {
    if (!w.isDestroyed()) { w.show(); w.focus(); }
  });
  w.on("closed", () => {
    windows.delete(w);
    if (win === w) win = [...windows][0] || null;
  });

  if (appIcon && !w.isDestroyed()) {
    try {
      w.setIcon(appIcon);
    } catch {
      // ignore
    }
  }

  try {
    if (isDev) {
      // 开发模式快捷键：F12 开启开发者工具，F5 刷新
      w.webContents.on("before-input-event", (event, input) => {
        if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) {
          w.webContents.toggleDevTools();
          event.preventDefault();
        }
        if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) {
          w.webContents.reload();
          event.preventDefault();
        }
      });
      await loadURLWithRetry(w, windowUrl(cwd));
    } else {
      await w.loadURL(windowUrl(cwd));
    }
    if (!w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      console.log(`[Electron] 页面已加载，窗口已显示 (visible=${w.isVisible()})`);
    }
  } catch (error) {
    if (!w.isDestroyed()) w.destroy();
    throw new Error(`无法打开 AutumnFlow 页面 (${windowUrl(cwd)})。请检查服务是否成功启动后重试。`, { cause: error });
  }

  // 外链（target=_blank / window.open）一律交给系统浏览器，不在应用里开新窗口
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // 注册全局编辑上下文右键菜单（输入框、聊天框、文本选区）
  w.webContents.on("context-menu", (_event, params) => {
    const { isEditable, selectionText } = params;
    const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

    if (isEditable) {
      menuTemplate.push(
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { type: "separator" },
        { role: "selectAll", label: "全选" }
      );
    } else if (selectionText.trim().length > 0) {
      menuTemplate.push(
        { role: "copy", label: "复制" },
        { role: "selectAll", label: "全选" }
      );
    }

    if (isDev) {
      if (menuTemplate.length > 0) menuTemplate.push({ type: "separator" });
      menuTemplate.push({
        label: "检查元素",
        click: () => w.webContents.inspectElement(params.x, params.y),
      });
    }

    if (menuTemplate.length > 0) {
      Menu.buildFromTemplate(menuTemplate).popup({ window: w });
    }
  });
  w.on("focus", () => {
    win = w;
  });
  return w;
}

function reportStartupFailure(error: unknown) {
  console.error("[Electron] 启动或页面加载失败:", error);
  recordCrash("web-boot", "startup", error);
  dialog.showErrorBox("AutumnFlow 启动失败", error instanceof Error ? error.message : String(error));
  if (windows.size === 0) app.quit();
}

// Native Desktop IPC Handlers: Folder selection & system explorer reveal
ipcMain.handle("dialog:openDirectory", async (event, opts?: { defaultPath?: string }) => {
  assertOurSender(event, "dialog:openDirectory");
  const targetWin = senderWin(event) || win || BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(targetWin!, {
    properties: ["openDirectory"],
    title: "选择项目工作区目录",
    defaultPath: opts?.defaultPath,
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle("shell:openPath", async (event, targetPath: string) => {
  assertOurSender(event, "shell:openPath");
  if (!targetPath) return;
  await shell.openPath(targetPath);
});

// Window controls styling (pure React handles 100% of the UI; kept as no-op for IPC compatibility)
ipcMain.handle("window:setTitleBarOverlay", (event) => {
  assertOurSender(event, "window:setTitleBarOverlay");
});

ipcMain.handle("window:minimize", (e) => {
  assertOurSender(e, "window:minimize");
  senderWin(e)?.minimize();
});

ipcMain.handle("window:maximize", (e) => {
  assertOurSender(e, "window:maximize");
  const w = senderWin(e);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});

ipcMain.handle("window:close", (e) => {
  assertOurSender(e, "window:close");
  senderWin(e)?.close();
});

ipcMain.handle("window:isMaximized", (e) => {
  assertOurSender(e, "window:isMaximized");
  return senderWin(e)?.isMaximized() ?? false;
});

// ---- 工作台：新窗口 / 最近文件夹 / 在文件管理器中显示 / 复制路径 ----
ipcMain.handle("window:new", (e, cwd?: string) => {
  assertOurSender(e, "window:new");
  void createWindow(typeof cwd === "string" && cwd ? cwd : undefined).catch(reportStartupFailure);
});
ipcMain.handle("recent:list", (e) => {
  assertOurSender(e, "recent:list");
  return loadRecent();
});
ipcMain.handle("recent:add", (e, p: string) => {
  assertOurSender(e, "recent:add");
  if (typeof p !== "string" || !p || !fs.existsSync(p)) return loadRecent();
  const list = addRecent(p);
  buildAppMenu(menuActions, { isDev });
  return list;
});
ipcMain.handle("shell:reveal", (e, p: string) => {
  assertOurSender(e, "shell:reveal");
  if (typeof p === "string" && p && fs.existsSync(p)) shell.showItemInFolder(p);
});
ipcMain.handle("clipboard:writeText", (e, t: string) => {
  assertOurSender(e, "clipboard:writeText");
  if (typeof t === "string") clipboard.writeText(t);
});

/** 打开文件夹：当前窗口已有工作区就开新窗口，否则在当前窗口打开（与 VS Code 相近）。 */
async function openFolderInto(p: string) {
  addRecent(p);
  buildAppMenu(menuActions, { isDev });
  const target = BrowserWindow.getFocusedWindow() || win;
  if (target && !target.isDestroyed()) target.webContents.send("app:command", "workspace.open", p);
  else await createWindow(p);
}

const menuActions: MenuActions = {
  openFolder: async () => {
    const target = BrowserWindow.getFocusedWindow() || win;
    if (target && !target.isDestroyed()) {
      target.webContents.send("app:command", "workspace.openFolder");
      return;
    }
    const res = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "打开文件夹" });
    if (!res.canceled && res.filePaths[0]) await openFolderInto(res.filePaths[0]);
  },
  openRecent: (p) => void openFolderInto(p),
  newWindow: () => void createWindow().catch(reportStartupFailure),
  checkForUpdates: () => checkForUpdatesFromMenu(),
};

// 网关 token 交给页面：preload 透出 `acpStudio.getGatewayToken()`，前端
// （src/lib/gateway-auth.ts）启动时取一次，之后所有 /api/universal/* 请求带
// `Authorization: Bearer <token>`，PTY WebSocket 带 `?token=`。
// 只响应本应用自己加载的页面（主窗口），其他 webContents 拿不到。
ipcMain.handle("gateway:getToken", (event) => {
  assertOurSender(event, "gateway:getToken");
  return process.env.ACP_GATEWAY_TOKEN || ensureGatewayToken();
});

process.on("uncaughtException", (error) => {
  recordCrash("main", "running", error);
  console.error("[Electron] uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  recordCrash("main", "running", reason);
  console.error("[Electron] unhandled rejection:", reason);
});
app.on("child-process-gone", (_event, details) => {
  if (details.reason === "clean-exit") return;
  recordCrash(
    "child",
    "running",
    new Error(
      `Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode} ` +
        `service=${details.serviceName || "n/a"} name=${details.name || "n/a"}`
    )
  );
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    // 第二次启动带了目录参数（如 `acp-studio .`）→ 新窗口打开该目录；否则聚焦已有窗口
    const dir = argv.slice(1).reverse().find((a) => !a.startsWith("-") && fs.existsSync(a) && fs.statSync(a).isDirectory());
    if (dir) {
      void createWindow(path.resolve(dir)).catch(reportStartupFailure);
      return;
    }
    if (win) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    void pruneCrashReports(crashReportDir());
    if (!isDev) await startGateway();
    buildAppMenu(menuActions, { isDev });
    await createWindow();
    initUpdater();
  }).catch(reportStartupFailure);

  app.on("activate", () => {
    if (windows.size === 0) void createWindow().catch(reportStartupFailure);
  });

  app.on("window-all-closed", async () => {
    try {
      gateway?.close();
    } catch (err) {
      // 关闭已关的 server 属确定性无害，留痕即可。
      console.warn(`[Electron] 关闭网关时异常（已忽略）：${(err as Error).message}`);
    }
    await shutdownBridges().catch((err) => {
      console.warn(`[Electron] 关闭 agent 桥接失败：${(err as Error)?.message || err}`);
    });
    await stopMcpUiServer().catch(() => {});
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", async () => {
    await shutdownBridges().catch((err) => {
      console.warn(`[Electron] 退出前关闭桥接失败：${(err as Error)?.message || err}`);
    });
    await stopMcpUiServer().catch(() => {});
  });

  const handleSignal = () => {
    try {
      gateway?.close();
    } catch {}
    app.quit();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

