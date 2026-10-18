/**
 * ACP Studio desktop shell (Electron main).
 * Starts the Node gateway in-process, then opens the Studio window on it.
 * Dev: ELECTRON_DEV=1 ELECTRON_START_URL=http://localhost:5188 (external vite+gateway).
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { resolveRuntimeConfig } from "../shared/runtime-config";
import { assertPortAvailable } from "../server/port-availability";
import { ensureGatewayToken, gatewayTokenPreview } from "../server/universal/security";
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

interface GatewayHandle {
  child: ChildProcess;
  close: () => Promise<void>;
}

let gateway: GatewayHandle | null = null;
let gatewayReady = false;
let hostShuttingDown = false;
let hostStderr = "";

function hostScriptPath(): string {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, "app.asar.unpacked", "electron-dist", "host.cjs"),
        path.join(process.resourcesPath, "app.asar.unpacked", "host.cjs"),
      ]
    : [
        // `electron electron-dist/main.cjs` makes appPath = .../electron-dist.
        path.join(app.getAppPath(), "electron-dist", "host.cjs"),
        path.join(app.getAppPath(), "host.cjs"),
        path.join(app.getAppPath(), "..", "electron-dist", "host.cjs"),
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function resolvePublicDir(): string {
  if (process.env.ACP_PUBLIC_DIR) return process.env.ACP_PUBLIC_DIR;
  const candidates = [
    path.join(app.getAppPath(), "dist"),
    path.join(app.getAppPath(), "..", "dist"),
    path.join(__dirname, "..", "dist"),
    path.join(process.cwd(), "dist"),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(path.join(cand, "index.html"))) return cand;
  }
  return path.join(app.getAppPath(), "dist");
}

function appendHostStderr(chunk: Buffer | string): void {
  const text = String(chunk);
  hostStderr = (hostStderr + text).slice(-16 * 1024);
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) console.error(`[Host] ${line}`);
  }
}

async function closeGateway(): Promise<void> {
  const handle = gateway;
  if (!handle) return;
  gateway = null;
  gatewayReady = false;
  hostShuttingDown = true;
  const child = handle.child;
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    child.send({ type: "shutdown" });
  } catch (err) {
    console.warn("[Electron] could not send host shutdown:", err);
  }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) {
    try {
      child.kill();
    } catch (err) {
      console.warn("[Electron] host kill failed:", err);
    }
  }
}

interface ActiveWorkSnapshot {
  count: number;
  summary: string;
  active: {
    turns: Array<{ turnId: string; agentId: string; sessionId: string; ageMs: number }>;
    ptys: Array<{ id: string; cwd: string }>;
    permissions: Array<{ agentId: string; sessionId: string; title: string }>;
    elicitations: Array<{ agentId: string; sessionId: string; message: string }>;
    subagents: Array<{ agentId: string; sessionId: string }>;
  };
}

let activeWorkConfirmed = false;

async function inspectActiveWork(): Promise<ActiveWorkSnapshot | null> {
  if (!gatewayReady || !gateway) return null;
  try {
    const token = ensureGatewayToken();
    const res = await fetch(`http://127.0.0.1:${PORT}/api/universal/active-work`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      console.warn(`[Electron] active-work inspection failed: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { ok?: boolean } & ActiveWorkSnapshot;
    return data?.ok ? data : null;
  } catch (err) {
    console.warn("[Electron] active-work inspection unavailable:", err);
    return null;
  }
}

async function confirmActiveWork(action: "quit" | "install"): Promise<boolean> {
  const work = await inspectActiveWork();
  if (!work) {
    if (action === "install") {
      dialog.showErrorBox("无法检查运行中的任务", "后端未响应，更新已取消。请稍后重试。");
      return false;
    }
    // A dead/unreachable host must not trap the user in a quit loop.
    activeWorkConfirmed = true;
    return true;
  }
  if (work.count === 0) {
    activeWorkConfirmed = true;
    return true;
  }
  const choice = dialog.showMessageBoxSync({
    type: "warning",
    title: "仍有任务在运行",
    message: `检测到 ${work.count} 个进行中的项`,
    detail: `${work.summary || "对话、终端或待确认请求"}。\n\n${
      action === "install" ? "继续安装会中断这些任务并重启应用。" : "继续退出会中断这些任务。"
    }`,
    buttons: [action === "install" ? "继续安装并重启" : "继续退出", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (choice !== 0) return false;
  activeWorkConfirmed = true;
  return true;
}

async function startGateway() {
  // 本函数只在 !isDev 时被调用：确保 token 已生成并进入进程环境，
  // 同一机器前后端共享同一 token。
  const token = ensureGatewayToken();
  if (!process.env.ACP_GATEWAY_TOKEN) process.env.ACP_GATEWAY_TOKEN = token;
  await assertPortAvailable(PORT);

  const publicDir = resolvePublicDir();
  process.env.ACP_PUBLIC_DIR = publicDir;
  try {
    process.chdir(app.getPath("home"));
  } catch {}

  const hostScript = hostScriptPath();
  if (!fs.existsSync(hostScript)) {
    throw new Error(`Gateway host entry is missing: ${hostScript}`);
  }
  hostStderr = "";
  hostShuttingDown = false;
  const child = fork(hostScript, [], {
    execPath: process.execPath,
    cwd: app.getPath("home"),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ACP_RUNTIME_MODE: "production",
      PORT: String(PORT),
      MCP_PORT: String(runtime.mcpPort),
      ACP_PUBLIC_DIR: publicDir,
      ACP_GATEWAY_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  gateway = { child, close: closeGateway };
  child.stdout?.on("data", (chunk) => process.stdout.write(`[Host] ${String(chunk)}`));
  child.stderr?.on("data", appendHostStderr);
  child.on("error", (err) => {
    console.error("[Electron] host process error:", err);
  });
  child.on("message", (message: any) => {
    if (message?.type !== "trash" || typeof message.path !== "string") return;
    void shell
      .trashItem(message.path)
      .then(() => child.send({ type: "trash-result", id: message.id, ok: true }))
      .catch((err) => {
        child.send({ type: "trash-result", id: message.id, ok: false, error: err?.message || String(err) });
      });
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Gateway host did not become ready within 30s.\n${hostStderr}`));
    }, 30_000);
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.on("message", (message: any) => {
      if (message?.type === "ready") {
        gatewayReady = true;
        console.log(`[Electron] gateway host ready at http://127.0.0.1:${PORT} (token ${gatewayTokenPreview()})`);
        settle();
      } else if (message?.type === "fatal") {
        const error = new Error(`Gateway host fatal: ${message.error || "unknown"}\n${hostStderr}`);
        recordCrash("child", gatewayReady ? "running" : "startup", error);
        if (!settled) {
          settle(error);
        } else {
          gateway = null;
          gatewayReady = false;
          dialog.showErrorBox("AutumnFlow 后端异常", `${message.error || "Gateway host crashed"}`);
          app.quit();
        }
      }
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`Gateway host exited before ready (code=${code}, signal=${signal}).\n${hostStderr}`);
      if (!settled) {
        recordCrash("child", "startup", error);
        settle(error);
        return;
      }
      if (!hostShuttingDown) {
        gateway = null;
        gatewayReady = false;
        recordCrash("child", "running", error);
        dialog.showErrorBox("AutumnFlow 后端已退出", `${error.message.split("\n")[0]}\n\n诊断日志已写入用户数据目录。`);
        app.quit();
      }
    });
  });
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
  let allowClose = false;
  let closeCheckInFlight = false;
  w.on("close", (event) => {
    if (allowClose || !gateway || activeWorkConfirmed || windows.size > 1) return;
    event.preventDefault();
    if (closeCheckInFlight) return;
    closeCheckInFlight = true;
    void confirmActiveWork("quit")
      .then((ok) => {
        closeCheckInFlight = false;
        if (!ok || w.isDestroyed()) return;
        allowClose = true;
        w.close();
      })
      .catch((err) => {
        closeCheckInFlight = false;
        console.error("[Electron] active-work close check failed:", err);
      });
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
  // Production host authentication is the HttpOnly cookie; do not expose the
  // raw token to renderer JS. Dev uses the external gateway and still needs
  // the preload token path.
  if (!isDev) return "";
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
    initUpdater({ beforeInstall: () => confirmActiveWork("install") });
  }).catch(reportStartupFailure);

  app.on("activate", () => {
    if (windows.size === 0) void createWindow().catch(reportStartupFailure);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  let quitAfterHostShutdown = false;
  let hostClosePromise: Promise<void> | null = null;
  const shutdownHost = () => {
    if (!hostClosePromise) hostClosePromise = closeGateway();
    return hostClosePromise;
  };

  let quitCheckInFlight = false;
  app.on("before-quit", (event) => {
    if (quitAfterHostShutdown) return;
    if (gateway && !activeWorkConfirmed && !quitCheckInFlight) {
      event.preventDefault();
      quitCheckInFlight = true;
      void confirmActiveWork("quit")
        .then((ok) => {
          quitCheckInFlight = false;
          if (ok) app.quit();
        })
        .catch((err) => {
          console.error("[Electron] active-work quit check failed:", err);
          quitCheckInFlight = false;
          activeWorkConfirmed = true;
          app.quit();
        });
      return;
    }
    if (!gateway && !hostClosePromise) return;
    event.preventDefault();
    void shutdownHost().finally(() => {
      quitAfterHostShutdown = true;
      app.quit();
    });
  });

  const handleSignal = () => {
    void shutdownHost().finally(() => app.quit());
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  process.on("exit", () => {
    try {
      gateway?.child.kill();
    } catch {}
  });
}

