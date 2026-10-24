import type { StateCreator } from "zustand";
import { saveThreads, threadForAgent, toEnvironmentNativeCwd } from "@/lib/threads";
import { cmdsFor, DRAFT_KEY, emptySession, ensureSessionIn, pruneLive, sessionOf } from "./session-state";
import { readCachedCatalog } from "./persistence";
import {
  getWorkspaceStorageKey,
  isAppInstallPath,
  isLocalMode,
  isPosixEnvironment,
  loadInitialWorkspaces,
  WINDOW_WORKSPACE_KEY,
} from "./workspace-env";
import type { RecentWorkspace, StudioState } from "./types";

const initialWorkspaces = loadInitialWorkspaces();

/** The window's workspace (and the session that goes with it), plus the terminal / git drawers. */
export interface WorkspaceSlice {
  currentWorkspace: string | null;
  recentWorkspaces: RecentWorkspace[];
  terminalOpen: boolean;
  /** 聊天卡片“在终端中打开”预填的命令：只填行、不执行，由抽屉消费后清零。 */
  terminalPrefill: string | null;
  /** 同卡片携带的工具执行 cwd（可空：空即回落工作区）；抽屉消费后清零。 */
  terminalCwd: string | null;
  gitChangesOpen: boolean;
  gitDiffFile: string | null;
  setWorkspace: (path: string, name?: string) => void;
  setTerminalOpen: (v: boolean) => void;
  setTerminalPrefill: (cmd: string | null) => void;
  setTerminalCwd: (cwd: string | null) => void;
  setGitChangesOpen: (v: boolean, file?: string | null) => void;
}

export const createWorkspaceSlice: StateCreator<StudioState, [], [], WorkspaceSlice> = (set, get) => ({
  currentWorkspace: initialWorkspaces.current,
  recentWorkspaces: initialWorkspaces.recents,
  terminalOpen: false,
  terminalPrefill: null,
  terminalCwd: null,
  gitChangesOpen: false,
  gitDiffFile: null,
  setWorkspace: (targetPath, optName) =>
    set((s) => {
      // Runtime boundary: workspace pickers/menus occasionally hand over an
      // event or a recent-workspace record instead of a path string. Treating
      // it as a path used to crash the caller in toEnvironmentNativeCwd.
      if (typeof targetPath !== "string" || !targetPath.trim()) {
        console.warn("[Studio] setWorkspace 收到非路径值，已忽略:", targetPath);
        return {};
      }
      const isPosix = isPosixEnvironment();
      // 提纯为当前目标环境的原生 CWD 路径（零硬编码，剥离 Windows UNC 或误拼盘符）
      const cleanPath = toEnvironmentNativeCwd(targetPath, isPosix);

      // 环境合法性检验：
      // POSIX 环境（WSL / SSH / Linux）绝不允许接收 Windows 盘符路径；
      // Windows 本地环境绝不允许接收纯 Linux 路径
      if (isPosix && /^[a-zA-Z]:/.test(cleanPath)) {
        return {};
      }
      if (!isPosix && cleanPath.startsWith("/") && !/^[a-zA-Z]:/.test(cleanPath)) {
        return {};
      }
      if (isAppInstallPath(cleanPath)) {
        return {};
      }

      const name = optName || cleanPath.split(/[/\\]/).filter(Boolean).pop() || cleanPath;
      const prevRecents = Array.isArray(s.recentWorkspaces) ? s.recentWorkspaces : [];
      const filtered = prevRecents.filter((r) => r.path !== cleanPath);
      const nextRecents = [{ path: cleanPath, name, lastOpened: Date.now() }, ...filtered].slice(0, 8);
      const envKey = getWorkspaceStorageKey();
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(`${envKey}_current`, cleanPath);
          localStorage.setItem(`${envKey}_recents`, JSON.stringify(nextRecents));
          if (isLocalMode()) {
            localStorage.setItem("acp_current_workspace", cleanPath);
            localStorage.setItem("acp_recent_workspaces", JSON.stringify(nextRecents));
          }
        }
        if (typeof sessionStorage !== "undefined") sessionStorage.setItem(WINDOW_WORKSPACE_KEY, cleanPath);
        void window.autumnflow?.workbench?.recentAdd(cleanPath)?.catch?.(() => {});
      } catch {
        // ignore storage errors
      }

      // 若工作区发生改变，自动切换到目标工作区专属的会话上下文，杜绝跨工作区串话
      if (s.currentWorkspace !== cleanPath) {
        // 1. 若当前会话有内容，先妥善保存到当前工作区
        const live = sessionOf(s);
        if (s.activeThreadId && live.messages.length > 0) {
          const cur = s.threads[s.activeThreadId];
          if (cur) {
            const updated = {
              ...cur,
              messages: live.messages,
              sessionId: s.sessionId ?? (cur.stale ? cur.sessionId : null),
              cwd: s.currentWorkspace,
              updatedAt: Date.now(),
            };
            const nextThreads = pruneLive(s, { ...s.threads, [cur.id]: updated }, [cur.id]);
            saveThreads(nextThreads);
          }
        }

        // 2. 检索目标工作区是否已有历史会话：切过去只是换指针，它自己的格子原样在
        const existing = threadForAgent(s.threads, s.activeAgentId, targetPath);
        const cached = readCachedCatalog(s.activeAgentId);
        if (existing) {
          const sid = existing.stale ? null : existing.sessionId;
          return {
            currentWorkspace: targetPath,
            recentWorkspaces: nextRecents,
            models: cached?.models ?? null,
            configOptions: cached?.configOptions ?? null,
            sessionId: sid,
            availableCommands: cmdsFor(s, s.activeAgentId, sid),
            activeThreadId: existing.id,
            sessions: ensureSessionIn(s, existing.id),
          };
        } else {
          // 3. 目标工作区尚无会话：指向一份崭新的草稿
          return {
            currentWorkspace: targetPath,
            recentWorkspaces: nextRecents,
            models: cached?.models ?? null,
            configOptions: cached?.configOptions ?? null,
            sessionId: null,
            availableCommands: [],
            activeThreadId: null,
            sessions: { ...s.sessions, [DRAFT_KEY]: emptySession() },
          };
        }
      }

      return { currentWorkspace: targetPath, recentWorkspaces: nextRecents };
    }),
  setTerminalOpen: (v) => set({ terminalOpen: v }),
  setTerminalPrefill: (cmd) => set({ terminalPrefill: cmd }),
  setTerminalCwd: (cwd) => set({ terminalCwd: cwd }),
  setGitChangesOpen: (v, file) => set({ gitChangesOpen: v, gitDiffFile: file ?? null }),
});
