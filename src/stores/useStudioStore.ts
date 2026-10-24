import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Message } from "@/lib/message-types";
import { createAgentSlice } from "./studio/agentSlice";
import { createPrefsSlice } from "./studio/prefsSlice";
import { createSessionSlice } from "./studio/sessionSlice";
import { createUiSlice } from "./studio/uiSlice";
import { createWorkspaceSlice } from "./studio/workspaceSlice";
import { runningSessionIds, sessionOf } from "./studio/session-state";
import type { SessionState, StudioState } from "./studio/types";

export type {
  AgentPrefs,
  ModeState,
  QueuedPrompt,
  QuotaState,
  RecentWorkspace,
  SessionInfo,
  SessionKey,
  SessionState,
  SessionUi,
  StudioState,
  UsageState,
} from "./studio/types";
export { activeKey, EMPTY_SESSION, runningSessionIds, sessionOf } from "./studio/session-state";
export {
  getWorkspaceEnv,
  getWorkspaceStorageKey,
  isAppInstallPath,
  isLocalMode,
  isPosixEnvironment,
  WINDOW_WORKSPACE_KEY,
} from "./studio/workspace-env";

/**
 * The studio store, assembled from one slice per concern (see ./studio).
 * Consumers keep using this single store and its selectors.
 */
export const useStudioStore = create<StudioState>()((set, get, api) => ({
  ...createAgentSlice(set, get, api),
  ...createSessionSlice(set, get, api),
  ...createWorkspaceSlice(set, get, api),
  ...createPrefsSlice(set, get, api),
  ...createUiSlice(set, get, api),
  resetStudio: () => {
    const s = get();
    set({
      activeAgentId: "codex",
      connectingId: null,
      authOk: {},
      sessionId: null,
      commandsBySession: {},
      activeThreadId: null,
      sessions: {},
      models: null,
      configOptions: null,
      availableCommands: [],
      quota: null,
      // Persisted thread records survive a full reset (tests clear storage).
      threads: s.threads,
      busy: false,
      discovering: false,
      authOpen: false,
      settingsOpen: false,
      providersOpen: false,
      modelsOpen: false,
      respondingId: null,
      pendingPerms: [],
      pendingElic: [],
      terminalOpen: false,
      terminalPrefill: null,
      terminalCwd: null,
      gitChangesOpen: false,
      gitDiffFile: null,
    });
  },
}));

/**
 * Shallow-selected view of the studio store.
 *
 * IMPORTANT: this deliberately does **not** subscribe to `messages`. The
 * streaming hot path writes `messages` once per token; subscribing to it at
 * shell level made App re-render (and re-render every layout child) on every
 * chunk. `messages` is consumed by the leaves that actually render it
 * (`AssistantChatView` via `useStudioMessages`), while stream callbacks
 * write through `getState()` actions, which needs no subscription at all.
 *
 * The session fields below are read through the view pointer: they belong to
 * the session being looked at, not to the store.
 *
 * Per .agents/rules/state_management.md: subscribe with selectors, never the
 * whole store. `transients` (AbortController, StrictMode guards) stay in refs.
 */
const STUDIO_SHALLOW_SELECTOR = (s: StudioState) => {
  const view = sessionOf(s);
  return {
    // connection
    activeAgentId: s.activeAgentId,
    connectingId: s.connectingId,
    authOk: s.authOk,
    // session view (the session the pointer is on)
    sessionId: s.sessionId,
    sessionError: view.sessionError,
    sessionLoading: view.sessionLoading,
    modes: view.modes,
    usage: view.usage,
    sessionInfo: view.sessionInfo,
    queuedPrompts: view.queuedPrompts,
    attachments: view.attachments,
    isStreaming: view.running,
    models: s.models,
    configOptions: s.configOptions,
    availableCommands: s.availableCommands,
    quota: s.quota,
    busy: s.busy,
    discovering: s.discovering,
    // overlays
    authOpen: s.authOpen,
    settingsOpen: s.settingsOpen,
    providersOpen: s.providersOpen,
    modelsOpen: s.modelsOpen,
    // pending agent requests
    pendingPerms: s.pendingPerms,
    pendingElic: s.pendingElic,
    respondingId: s.respondingId,
    // workspace & desktop tools
    currentWorkspace: s.currentWorkspace,
    recentWorkspaces: s.recentWorkspaces,
    terminalOpen: s.terminalOpen,
    terminalPrefill: s.terminalPrefill,
    terminalCwd: s.terminalCwd,
    gitChangesOpen: s.gitChangesOpen,
    gitDiffFile: s.gitDiffFile,
    // thread bookkeeping
    threads: s.threads,
    activeThreadId: s.activeThreadId,
    agentPrefs: s.agentPrefs,
    // actions used directly from JSX (stable identity — never trigger a shallow
    // change, so including them costs nothing and avoids `getState()` in render)
    setWorkspace: s.setWorkspace,
    setTerminalOpen: s.setTerminalOpen,
    setTerminalPrefill: s.setTerminalPrefill,
    setTerminalCwd: s.setTerminalCwd,
    setGitChangesOpen: s.setGitChangesOpen,
    setAuthOpen: s.setAuthOpen,
    setSettingsOpen: s.setSettingsOpen,
    setProvidersOpen: s.setProvidersOpen,
    setModelsOpen: s.setModelsOpen,
    setAttachments: s.setAttachments,
    setMessages: s.setMessages,
    setQuota: s.setQuota,
  };
};

export type StudioShallow = ReturnType<typeof STUDIO_SHALLOW_SELECTOR>;

/** Subscribe to the studio view state without re-rendering on `messages` writes. */
export function useStudioShallow(): StudioShallow {
  return useStudioStore(useShallow(STUDIO_SHALLOW_SELECTOR));
}

/** Read one thing from the session the view is on. */
export function useActiveSession<T>(select: (b: SessionState) => T): T {
  return useStudioStore((s) => select(sessionOf(s)));
}

/**
 * Focused subscription for the single field the stream hot path mutates.
 * Kept separate so only the component that renders the transcript pays for it.
 */
export function useStudioMessages(): Message[] {
  return useStudioStore((s) => sessionOf(s).messages);
}

/** ACP session ids with a turn running right now (one per session, in parallel). */
export function useRunningSessionIds(): Record<string, true> {
  return useStudioStore(useShallow(runningSessionIds));
}

if (typeof window !== "undefined") {
  (window as any).__studioStore = useStudioStore;
}
