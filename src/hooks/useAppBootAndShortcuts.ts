import { useEffect } from "react";
import { useThemeStore } from "@/stores/useThemeStore";
import { useStudioStore, getWorkspaceEnv, isAppInstallPath } from "@/stores/useStudioStore";
import { useWorkspaceDefaultQuery } from "@/lib/acp-queries";
import { validateWorkspace, type AgentSummary } from "@/lib/universal-api";

export interface UseAppBootAndShortcutsOptions {
  agents: AgentSummary[];
  agentsRef: React.RefObject<AgentSummary[]>;
  activeAgentId: string;
  sessionId?: string | null;
  activeThreadId?: string | null;
  currentWorkspace?: string | null;
}

const {
  setActiveAgentId,
  restoreThread,
  newThread,
  snapshotThread,
} = useStudioStore.getState();

/**
 * App initialization & global shortcuts controller hook.
 *
 * Responsibilities:
 * 1. Boot: initialize theme, restore initial agent thread.
 * 2. Keep selected agent valid as registry list changes.
 * 3. Trailing snapshot: throttled thread persistence.
 * 4. Workspace default query: populate workspace when empty.
 * 5. Global hotkeys: Ctrl+` (Terminal), Ctrl+Shift+D (Git Diff), Ctrl+O (Open Directory).
 */
export function useAppBootAndShortcuts({
  agents,
  agentsRef,
  activeAgentId,
  sessionId,
  activeThreadId,
  currentWorkspace,
}: UseAppBootAndShortcutsOptions) {
  // Keep the selected agent valid as the registry list arrives/changes.
  useEffect(() => {
    agentsRef.current = agents;
    if (agents.length > 0 && !agents.find((a) => a.id === activeAgentId)) {
      const next = agents[0].id;
      // setActiveAgentId clears the previous agent's live session/messages.
      // Restore (or create) the target agent's own thread immediately so the
      // fallback never leaves agent A's transcript under agent B's id.
      setActiveAgentId(next);
      if (!restoreThread(next)) newThread(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  // Boot: instant-render the agent's last thread from local cache and init theme.
  useEffect(() => {
    useThemeStore.getState().initTheme();
    const st = useStudioStore.getState();
    if (!restoreThread(st.activeAgentId)) newThread(st.activeAgentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the live view (trailing throttle): crash/reload-safe threads.
  // Reads messages imperatively so this shell never subscribes to the
  // streaming hot path; the effect re-arms on the session/thread identities.
  useEffect(() => {
    const t = setTimeout(() => {
      const st = useStudioStore.getState();
      if (st.activeThreadId) snapshotThread();
    }, 1500);
    return () => clearTimeout(t);
  }, [sessionId, activeAgentId, activeThreadId]);

  // Gateway default workspace (TanStack Query: cached 5min, retried once).
  // Applied into the store only when the user has no workspace yet, or when in WSL
  // but holding a legacy Windows mount /mnt/... path.
  const isWsl = getWorkspaceEnv().startsWith("wsl_");
  const isMntWorkspace = Boolean(currentWorkspace && /^\/mnt\/[a-zA-Z](\/|$)/i.test(currentWorkspace));
  const workspaceDefaultQuery = useWorkspaceDefaultQuery(!currentWorkspace || (isWsl && isMntWorkspace));
  useEffect(() => {
    const res = workspaceDefaultQuery.data;
    if (res?.path && !isAppInstallPath(res.path)) {
      const cur = useStudioStore.getState().currentWorkspace;
      if (!cur || (isWsl && /^\/mnt\/[a-zA-Z](\/|$)/i.test(cur)) || isAppInstallPath(cur)) {
        useStudioStore.getState().setWorkspace(res.path, res.name);
      }
    }
    if (workspaceDefaultQuery.isError) {
      console.warn("[App] 获取默认工作区失败 (已忽略，将保持空工作区):", workspaceDefaultQuery.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceDefaultQuery.data, workspaceDefaultQuery.isError, isWsl]);

  // Global shortcuts (Ctrl+`, Ctrl+Shift+D, Ctrl+O)
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Toggle Terminal: Ctrl + `
      if ((e.ctrlKey || e.metaKey) && e.key === "`") {
        e.preventDefault();
        const cur = useStudioStore.getState();
        cur.setTerminalOpen(!cur.terminalOpen);
        return;
      }
      // Toggle Git diff: Ctrl + Shift + D
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        const cur = useStudioStore.getState();
        cur.setGitChangesOpen(!cur.gitChangesOpen);
        return;
      }
      // Open Directory: Ctrl + O
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        import("@/stores/useWorkbenchStore").then(({ useWorkbenchStore }) => {
          useWorkbenchStore.getState().openWorkspacePicker();
        });
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
