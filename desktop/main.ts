/**
 * AutumnFlow desktop shell (Electron main).
 * Starts the Node gateway in-process, then opens the Studio window on it.
 * Dev: ELECTRON_DEV=1 ELECTRON_START_URL=http://localhost:5188 (external vite+gateway).
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
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
  BackgroundKeeper,
  IDLE_EXIT_CHOICES,
  readBackgroundSettings,
  writeBackgroundSettings,
  type BackgroundSettings,
} from "./background-policy";
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

// 设置 Windows 任务栏应用标识与独立分组，确保任务栏图标显示 AutumnFlow 图标而非 Electron 默认原子图标
if (process.platform === "win32") {
  app.setAppUserModelId(isDev ? "com.autumnflow.app.dev" : "com.autumnflow.app");
}

// 隔离应用名称与 userData 路径，避免开发模式下与本地其他未打包的 Electron 应用（如 inkdown）
// 共享 %APPDATA%\Electron 导致 Chromium ProcessSingleton 单例锁冲突（0x20 锁文件被占用错误）。
// 首次运行时把旧目录 acp-studio 复制到 autumnflow，之后的读写只走新目录。
app.name = isDev ? "autumnflow-dev" : "autumnflow";
try {
  const appDataRoot = app.getPath("appData");
  const userDataDir =
    process.env.ACP_USER_DATA_DIR ||
    path.join(appDataRoot, isDev ? "autumnflow-dev" : "autumnflow");
  if (!process.env.ACP_USER_DATA_DIR) {
    const legacyDir = path.join(appDataRoot, isDev ? "acp-studio-dev" : "acp-studio");
    if (!fs.existsSync(userDataDir) && fs.existsSync(legacyDir)) {
      try {
        fs.cpSync(legacyDir, userDataDir, { recursive: true, force: false, errorOnExist: false });
      } catch (err) {
        console.warn("[Electron] 迁移旧 userData 失败（保留旧目录）:", err);
      }
    }
  }
  app.setPath("userData", userDataDir);
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
  // Automation (E2E, scripted restarts) cannot answer the modal, and a
  // blocking message box would trap the quit forever. The guard is skipped
  // only when the caller opted out explicitly.
  if (process.env.ACP_DISABLE_ACTIVE_WORK_GUARD === "1") {
    activeWorkConfirmed = true;
    return true;
  }
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

// ---- 后台常驻（混合策略） ----
// 关掉最后一个窗口时：没有进行中的任务就照常退出；有活跃任务（对话轮次 / 终端 /
// 待确认权限 / 子智能体）则缩到托盘继续跑，任务全部结束后发系统通知，空闲超过
// 设定时长（默认 30 分钟）自动退出。托盘菜单可以改这个时长，也可以立刻退出。
const backgroundDir = () => app.getPath("userData");
let backgroundSettings: BackgroundSettings = readBackgroundSettings(backgroundDir());
let tray: Tray | null = null;
let backgroundTimer: ReturnType<typeof setInterval> | null = null;
let backgroundPollInFlight = false;
let backgroundHintShown = false;
let quitting = false;

const backgroundKeeper = new BackgroundKeeper({
  settings: backgroundSettings,
  onAllWorkDone: () => notifyBackground("后台任务已完成", "AutumnFlow 里已经没有进行中的任务了。"),
  onIdleExit: () => {
    console.log(`[Electron] 后台空闲超过 ${backgroundSettings.idleExitMinutes} 分钟，自动退出`);
    quitApp();
  },
});

function quitApp(): void {
  quitting = true;
  app.quit();
}

function notifyBackground(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  try {
    const notification = new Notification({ title, body });
    notification.on("click", () => openMainWindow());
    notification.show();
  } catch (err) {
    console.warn("[Electron] background notification failed:", err);
  }
}

function trayImage(): Electron.NativeImage | undefined {
  const icon = getAppIcon();
  if (!icon || icon.isEmpty()) return undefined;
  try {
    return icon.resize({ width: process.platform === "darwin" ? 22 : 16, height: process.platform === "darwin" ? 22 : 16 });
  } catch {
    return icon;
  }
}

function openMainWindow(): void {
  leaveBackground();
  const existing = win && !win.isDestroyed() ? win : [...windows].find((w) => !w.isDestroyed());
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    if (!existing.isVisible()) existing.show();
    existing.focus();
    return;
  }
  void createWindow().catch(reportStartupFailure);
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 AutumnFlow", click: () => openMainWindow() },
      { type: "separator" },
      {
        label: "空闲后自动退出",
        submenu: IDLE_EXIT_CHOICES.map((minutes) => ({
          label: minutes === 0 ? "不自动退出" : `${minutes} 分钟`,
          type: "radio" as const,
          checked: backgroundSettings.idleExitMinutes === minutes,
          click: () => {
            backgroundSettings = { ...backgroundSettings, idleExitMinutes: minutes };
            writeBackgroundSettings(backgroundDir(), backgroundSettings);
            backgroundKeeper.updateSettings(backgroundSettings);
            refreshTrayMenu();
          },
        })),
      },
      { type: "separator" },
      { label: "退出 AutumnFlow", click: () => quitApp() },
    ])
  );
}

function showTray(): void {
  if (tray) return;
  const image = trayImage();
  if (!image) {
    console.warn("[Electron] 托盘图标缺失，后台常驻将没有托盘入口");
    return;
  }
  tray = new Tray(image);
  tray.setToolTip("AutumnFlow · 任务仍在后台运行");
  refreshTrayMenu();
  tray.on("double-click", () => openMainWindow());
}

function enterBackground(reason: string): void {
  if (tray || backgroundTimer) return;
  backgroundKeeper.begin();
  showTray();
  backgroundTimer = setInterval(() => void pollBackground(), 4000);
  void pollBackground();
  if (!backgroundHintShown) {
    backgroundHintShown = true;
    notifyBackground("AutumnFlow 仍在后台运行", "关闭窗口不会中断任务。双击托盘图标可以重新打开，或从托盘菜单退出。");
  }
  console.log(`[Electron] 窗口已关闭但保留后台运行（${reason}）`);
}

function leaveBackground(): void {
  if (!tray && !backgroundTimer) return;
  backgroundKeeper.end();
  if (backgroundTimer) clearInterval(backgroundTimer);
  backgroundTimer = null;
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

/**
 * One background sample. A dead/unreachable host means the tray would point at
 * nothing, so residency ends there instead of lingering.
 */
async function pollBackground(): Promise<void> {
  if (backgroundPollInFlight || quitting) return;
  backgroundPollInFlight = true;
  try {
    const work = await inspectActiveWork();
    if (!work) {
      console.warn("[Electron] 后台巡检拿不到 active-work，停止常驻");
      leaveBackground();
      quitApp();
      return;
    }
    if (tray) tray.setToolTip(`AutumnFlow · ${work.count > 0 ? `${work.count} 项任务进行中` : "空闲中"}`);
    if (!backgroundKeeper.markWork(work.count)) {
      leaveBackground();
      quitApp();
    }
  } finally {
    backgroundPollInFlight = false;
  }
}

/** window-all-closed：有活跃工作才常驻，否则保持原来的“关窗即退出”。 */
async function exitOrStayResident(): Promise<void> {
  if (quitting || activeWorkConfirmed) {
    app.quit();
    return;
  }
  if (!isDev && gateway && backgroundSettings.enabled) {
    const work = await inspectActiveWork();
    if (work && work.count > 0) {
      enterBackground(work.summary || `${work.count} 项进行中`);
      return;
    }
  }
  app.quit();
}

let hostRestarts = 0;
let hostRecovering = false;
const HOST_RESTART_DELAYS = [1000, 3000, 8000];

/**
 * A long-lived shell must not go silent when the host dies: a tray icon with no
 * backend is worse than a crashed window. Restart with backoff, reload windows.
 */
async function handleHostLoss(child: ChildProcess, kind: string, error: Error): Promise<void> {
  if (hostRecovering) return;
  if (gateway && gateway.child !== child) return; // superseded by a newer host
  hostRecovering = true;
  try {
    gateway = null;
    gatewayReady = false;
    const attempt = hostRestarts;
    if (quitting || attempt >= HOST_RESTART_DELAYS.length) {
      leaveBackground();
      dialog.showErrorBox(
        "AutumnFlow 后端已退出",
        `${error.message.split("\n")[0]}\n\n已尝试自动恢复 ${attempt} 次。诊断日志已写入用户数据目录。`
      );
      quitApp();
      return;
    }
    hostRestarts += 1;
    const delay = HOST_RESTART_DELAYS[attempt];
    console.warn(`[Electron] 后端${kind}异常，${delay}ms 后第 ${hostRestarts} 次自动恢复`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (quitting) return;
    try {
      await startGateway();
    } catch (err) {
      const next = err instanceof Error ? err : new Error(String(err));
      recordCrash("child", "running", next);
      hostRecovering = false;
      await handleHostLoss(child, "重启失败", next);
      return;
    }
    // A host that stays up for a minute resets the backoff budget.
    setTimeout(() => {
      hostRestarts = 0;
    }, 60_000).unref?.();
    for (const w of windows) {
      if (!w.isDestroyed()) w.webContents.reload();
    }
    if (windows.size === 0) notifyBackground("后端已重启", "后台服务已恢复；正在运行的轮次已中断。");
  } finally {
    hostRecovering = false;
  }
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
          void handleHostLoss(child, "fatal", error);
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
        recordCrash("child", "running", error);
        void handleHostLoss(child, "退出", error);
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
  // A visible window means the tray is no longer the only entry point.
  leaveBackground();
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
  // Electron ≥35 passes (event, details); older builds passed
  // (event, level, message, line, sourceId). Accept both so renderer warnings
  // keep reaching crash reports on either shape.
  w.webContents.on("console-message", ((...args: any[]) => {
    const details = args[1];
    const level = typeof details === "number" ? details : details?.level;
    const message = typeof details === "number" ? String(args[2] ?? "") : String(details?.message ?? "");
    const severe = typeof level === "number" ? level >= 3 : level === "error" || level === "warning";
    if (severe) rendererConsole.push(`[${new Date().toISOString()}] ${message}`);
  }) as never);
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
    // 常驻模式：关窗不再等于退出，也不该弹“仍有任务在运行”的阻断对话框。
    // 缩到托盘还是直接退出，统一由 window-all-closed 的 active-work 巡检决定。
    if (backgroundSettings.enabled && !isDev) return;
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

// 网关 token 交给页面：preload 透出 `autumnflow.getGatewayToken()`，前端
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
    leaveBackground();
    // 第二次启动带了目录参数（如 `autumnflow .`）→ 新窗口打开该目录；否则聚焦已有窗口
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
    initUpdater({ beforeInstall: () => confirmActiveWork("install"), onOpenWindow: () => openMainWindow() });
  }).catch(reportStartupFailure);

  app.on("activate", () => {
    if (windows.size === 0) void createWindow().catch(reportStartupFailure);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") void exitOrStayResident();
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
    quitting = true;
    leaveBackground();
    if (gateway && !activeWorkConfirmed && !quitCheckInFlight) {
      event.preventDefault();
      quitCheckInFlight = true;
      void confirmActiveWork("quit")
        .then((ok) => {
          quitCheckInFlight = false;
          if (ok) {
            app.quit();
            return;
          }
          // User chose to keep working: put the tray back that quitting removed.
          quitting = false;
          if (windows.size === 0 && !isDev && gateway && backgroundSettings.enabled) {
            enterBackground("已取消退出");
          } else if (windows.size === 0) {
            // Residency is off, so a cancelled quit would otherwise leave a
            // window-less app: hand the user a window back.
            openMainWindow();
          }
        })
        .catch((err) => {
          console.error("[Electron] active-work quit check failed:", err);
          quitCheckInFlight = false;
          activeWorkConfirmed = true;
          quitting = true;
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

