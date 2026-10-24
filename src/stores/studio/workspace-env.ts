import { toEnvironmentNativeCwd } from "@/lib/threads";
import type { RecentWorkspace } from "./types";

export const WINDOW_WORKSPACE_KEY = "acp_window_workspace";

/**
 * 当前所处环境（local / wsl_<distro> / remote_<host>），用于彻底隔离不同系统的工作区与会话
 */
export function getWorkspaceEnv(): string {
  if (typeof localStorage === "undefined") return "local";
  const distro = localStorage.getItem("acp_wsl_native_distro");
  // 只要设置了 WSL 发行版，即视为 WSL 原生真环境，彻底隔离工作区、历史与会话
  if (distro && distro.trim()) {
    return `wsl_${distro.trim().toLowerCase()}`;
  }
  const base = localStorage.getItem("acp_gateway_base");
  if (base) {
    try {
      const u = new URL(base);
      return `remote_${u.host.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    } catch {
      return "remote";
    }
  }
  return "local";
}

/**
 * 判断当前目标运行环境是否属于 POSIX 体系（Linux / WSL / SSH 远程 Linux / macOS 等）：
 * 在 POSIX 体系下，所有路径必须为纯正的 POSIX 原生绝对路径，绝不包含 Windows 盘符或 UNC 包装。
 */
export function isPosixEnvironment(): boolean {
  const env = getWorkspaceEnv();
  if (env.startsWith("wsl_") || env.startsWith("remote_")) return true;
  if (typeof process !== "undefined" && process.platform && process.platform !== "win32") {
    return true;
  }
  return false;
}

export function isLocalMode(): boolean {
  return getWorkspaceEnv() === "local";
}

export function getWorkspaceStorageKey(): string {
  return `acp_workspace_${getWorkspaceEnv()}`;
}

export function isAppInstallPath(p?: string | null): boolean {
  if (!p) return false;
  const norm = p.replace(/\\/g, "/").toLowerCase();
  return (
    norm.includes("appdata/local/programs/autumnflow") ||
    norm.includes("program files/autumnflow") ||
    norm.includes("program files (x86)/autumnflow")
  );
}

export function loadInitialWorkspaces(): { current: string | null; recents: RecentWorkspace[] } {
  try {
    // 多窗口：每个窗口的“当前工作区”优先取地址栏 ?cwd=（新窗口打开文件夹）→ 本窗口 sessionStorage
    // → 当前环境上次使用（localStorage 隔离键，仅作新窗口的默认值）。
    const fromUrl = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("cwd") : null;
    const fromWindow = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(WINDOW_WORKSPACE_KEY) : null;
    const envKey = getWorkspaceStorageKey();
    const isPosix = isPosixEnvironment();

    let current = fromUrl || fromWindow || (typeof localStorage !== "undefined" ? localStorage.getItem(`${envKey}_current`) : null);
    let raw = typeof localStorage !== "undefined" ? localStorage.getItem(`${envKey}_recents`) : null;

    // 本机 Windows 模式兼容旧存储键
    if (isLocalMode() && typeof localStorage !== "undefined") {
      if (!current) current = localStorage.getItem("acp_current_workspace");
      if (!raw) raw = localStorage.getItem("acp_recent_workspaces");
    }

    // 绝对不允许将应用程序安装目录作为工作区缓存
    if (current && isAppInstallPath(current)) {
      current = null;
    }

    // 路径提纯为当前目标环境的原生格式（若为 POSIX 自动剥离 UNC 包装与残留盘符）
    if (current) {
      current = toEnvironmentNativeCwd(current, isPosix);
      if (isPosix && /^[a-zA-Z]:/.test(current)) {
        current = null;
      }
    }

    if (fromUrl && typeof sessionStorage !== "undefined") sessionStorage.setItem(WINDOW_WORKSPACE_KEY, fromUrl);
    const recents = raw ? JSON.parse(raw) : [];
    const validRecents: RecentWorkspace[] = [];
    if (Array.isArray(recents)) {
      for (const r of recents) {
        if (!r?.path || isAppInstallPath(r.path)) continue;
        const nativePath = toEnvironmentNativeCwd(r.path, isPosix);
        if (isPosix && /^[a-zA-Z]:/.test(nativePath)) continue;
        if (!isPosix && nativePath.startsWith("/") && !/^[a-zA-Z]:/.test(nativePath)) continue;
        validRecents.push({ ...r, path: nativePath });
      }
    }
    return { current: current || null, recents: validRecents };
  } catch {
    return { current: null, recents: [] };
  }
}
