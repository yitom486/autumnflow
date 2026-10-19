import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * Minimal bridge: version/platform info + native dialogs + gateway token.
 * All ACP traffic stays on HTTP; the token authenticates it (see src/lib/gateway-auth.ts).
 */
contextBridge.exposeInMainWorld("autumnflow", {
  platform: process.platform,
  // Production Gateway host sets an HttpOnly SameSite=Strict cookie on the
  // document response; the renderer never needs the raw token. Dev still uses
  // the external Vite/gateway pair and the preload token path.
  authMode: process.env.ELECTRON_DEV === "1" ? "token" : "cookie",
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  getGatewayToken: (): Promise<string> => ipcRenderer.invoke("gateway:getToken"),
  openDirectory: (opts?: { defaultPath?: string }): Promise<string | null> => ipcRenderer.invoke("dialog:openDirectory", opts),
  openPath: (p: string): Promise<void> => ipcRenderer.invoke("shell:openPath", p),
  setTitleBarOverlay: (opts: { color?: string; symbolColor?: string; height?: number }): Promise<void> =>
    ipcRenderer.invoke("window:setTitleBarOverlay", opts),
  minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  maximize: (): Promise<void> => ipcRenderer.invoke("window:maximize"),
  close: (): Promise<void> => ipcRenderer.invoke("window:close"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),
  updates: {
    getInfo: (): Promise<UpdateInfo> => ipcRenderer.invoke("update:getInfo"),
    check: (): Promise<void> => ipcRenderer.invoke("update:check"),
    setAutoCheck: (v: boolean): Promise<UpdateInfo> => ipcRenderer.invoke("update:setAutoCheck", v),
    download: (): Promise<void> => ipcRenderer.invoke("update:download"),
    install: (): Promise<void> => ipcRenderer.invoke("update:install"),
    openReleases: (): Promise<void> => ipcRenderer.invoke("update:openReleases"),
    onEvent: (cb: (e: unknown) => void): (() => void) => {
      const h = (_: unknown, e: unknown) => cb(e);
      ipcRenderer.on("update:event", h);
      return () => ipcRenderer.removeListener("update:event", h);
    },
  },
  workbench: {
    newWindow: (cwd?: string): Promise<void> => ipcRenderer.invoke("window:new", cwd),
    recentList: (): Promise<string[]> => ipcRenderer.invoke("recent:list"),
    recentAdd: (p: string): Promise<string[]> => ipcRenderer.invoke("recent:add", p),
    reveal: (p: string): Promise<void> => ipcRenderer.invoke("shell:reveal", p),
    copyText: (t: string): Promise<void> => ipcRenderer.invoke("clipboard:writeText", t),
    /** 拖入的系统文件 → 本机绝对路径（Electron 32+ 不再提供 File.path） */
    pathForFile: (f: File): string => {
      try {
        return webUtils.getPathForFile(f);
      } catch {
        return "";
      }
    },
    onCommand: (cb: (id: string, payload?: unknown) => void): (() => void) => {
      const h = (_: unknown, id: string, payload?: unknown) => cb(id, payload);
      ipcRenderer.on("app:command", h);
      return () => ipcRenderer.removeListener("app:command", h);
    },
  },
});

type UpdateInfo = {
  version: string;
  enabled: boolean;
  isDev: boolean;
  canAutoInstall: boolean;
  autoCheck: boolean;
  lastChecked: number | null;
  platform: string;
};
