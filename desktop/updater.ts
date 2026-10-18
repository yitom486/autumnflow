/**
 * 自动更新（electron-updater + GitHub Releases）。
 * - autoDownload=false：发现新版只通知，用户点“更新”才下载（差分 blockmap）。
 * - autoInstallOnAppQuit=true：下载完不重启也行，退出/下次启动前静默安装，不走安装向导。
 * - 手动“检查更新”一定给结果（已是最新 / 有新版 / 出错）；自动检查可在设置里关掉。
 * - 窗口不在前台时，发现新版 / 下载完成发系统通知，点通知打开“设置 → 关于”。
 * - macOS 未签名时 Squirrel.Mac 无法安装 → 只提示并打开 Release 页；Linux 仅 AppImage 可自动更新。
 */
import { app, BrowserWindow, ipcMain, Notification, shell } from "electron";
import { autoUpdater } from "electron-updater";
import * as fs from "node:fs";
import * as path from "node:path";

const RELEASES_URL = "https://github.com/yitom486/acp-studio/releases/latest";
const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** 当前平台/打包形态能否自动安装更新。 */
export function canAutoInstall(platform = process.platform, env = process.env): boolean {
  if (platform === "win32") return true;
  if (platform === "linux") return Boolean(env.APPIMAGE);
  // 未签名的 mac 包无法被 Squirrel.Mac 安装；签名后设 ACP_MAC_SIGNED=1 打包即可开启
  if (platform === "darwin") return env.ACP_MAC_SIGNED === "1";
  return false;
}

interface UpdateSettings {
  autoCheck: boolean;
  lastChecked: number | null;
}
const settingsFile = () => path.join(app.getPath("userData"), "update-settings.json");
function loadSettings(): UpdateSettings {
  try {
    const d = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return { autoCheck: d.autoCheck !== false, lastChecked: typeof d.lastChecked === "number" ? d.lastChecked : null };
  } catch {
    return { autoCheck: true, lastChecked: null };
  }
}
function saveSettings(s: UpdateSettings) {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
  } catch {}
}

function broadcast(payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("update:event", payload);
}

function notifyIfBackground(title: string, body: string) {
  const anyFocused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
  if (anyFocused || !Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on("click", () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.focus();
    w.webContents.send("app:command", "settings.about");
  });
  n.show();
}

let manualCheck = false;
let doCheck: (manual: boolean) => Promise<void> = async () => {};

/** 菜单“检查更新…”：打开关于页并手动检查。 */
export function checkForUpdatesFromMenu() {
  const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  w?.webContents.send("app:command", "settings.about");
  void doCheck(true);
}

export interface UpdaterOptions {
  /** Native confirmation before quitting into an update; false cancels install. */
  beforeInstall?: () => Promise<boolean>;
}

export function initUpdater(options: UpdaterOptions = {}) {
  const enabled = app.isPackaged && process.env.ACP_DISABLE_UPDATES !== "1";
  const autoInstall = canAutoInstall();
  let settings = loadSettings();

  const info = () => ({
    version: app.getVersion(),
    enabled,
    isDev: !app.isPackaged,
    canAutoInstall: autoInstall,
    autoCheck: settings.autoCheck,
    lastChecked: settings.lastChecked,
    platform: process.platform,
  });

  doCheck = async (manual: boolean) => {
    if (!enabled) {
      if (manual) broadcast({ type: "disabled", manual: true });
      return;
    }
    manualCheck = manual;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e: any) {
      broadcast({ type: "error", message: String(e?.message || e), manual });
    } finally {
      settings = { ...settings, lastChecked: Date.now() };
      saveSettings(settings);
    }
  };

  ipcMain.handle("update:getInfo", () => info());
  ipcMain.handle("update:check", () => doCheck(true));
  ipcMain.handle("update:setAutoCheck", (_e, v: boolean) => {
    settings = { ...settings, autoCheck: !!v };
    saveSettings(settings);
    return info();
  });
  ipcMain.handle("update:download", async () => {
    if (!enabled) return;
    if (!autoInstall) {
      await shell.openExternal(RELEASES_URL);
      return;
    }
    await autoUpdater.downloadUpdate().catch((e) => broadcast({ type: "error", message: String(e?.message || e) }));
  });
  ipcMain.handle("update:install", async () => {
    if (!enabled) return;
    if (options.beforeInstall) {
      try {
        if (!(await options.beforeInstall())) return;
      } catch (e: any) {
        broadcast({ type: "error", message: `无法检查运行中的任务: ${String(e?.message || e)}`, manual: true });
        return;
      }
    }
    // isSilent=true → 安装器带 /S 静默运行，沿用注册表 InstallLocation 的原目录；isForceRunAfter=true → 装完重新打开
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });
  ipcMain.handle("update:openReleases", () => shell.openExternal(RELEASES_URL));

  if (!enabled) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = autoInstall;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("checking-for-update", () => broadcast({ type: "checking", manual: manualCheck }));
  autoUpdater.on("update-not-available", () => broadcast({ type: "not-available", manual: manualCheck, version: app.getVersion() }));
  autoUpdater.on("update-available", (u) => {
    broadcast({
      type: "available",
      version: u.version,
      notes: typeof u.releaseNotes === "string" ? u.releaseNotes : undefined,
      canAutoInstall: autoInstall,
    });
    notifyIfBackground("AutumnFlow 有新版本", `${u.version} 可以更新了`);
  });
  autoUpdater.on("download-progress", (p) => broadcast({ type: "progress", percent: p.percent }));
  autoUpdater.on("update-downloaded", (u) => {
    broadcast({ type: "downloaded", version: u.version });
    notifyIfBackground("AutumnFlow 更新已就绪", `${u.version} 已下载，重启即可完成更新`);
  });
  autoUpdater.on("error", (e) => broadcast({ type: "error", message: String(e?.message || e), manual: manualCheck }));

  const autoCheck = () => {
    if (settings.autoCheck) void doCheck(false);
  };
  setTimeout(autoCheck, FIRST_CHECK_DELAY_MS);
  setInterval(autoCheck, CHECK_INTERVAL_MS).unref?.();
}
