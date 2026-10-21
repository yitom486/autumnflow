import { permissionInScope, elicitationInScope } from "@/lib/interaction-scope";
import { usePermissionSync } from "@/hooks/usePermissionSync";
import React, { Suspense, lazy, useRef, useState, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AcpAssistantProvider } from "@/components/assistant/AcpAssistantProvider";
import { AcpComposer } from "@/components/assistant/AcpComposer";
import { AssistantChatView } from "@/components/assistant/AssistantChatView";
import { StudioHeader } from "@/components/universal/StudioHeader";
import { StatusBar } from "@/components/universal/StatusBar";
import { ExternalHistoryDialog } from "@/components/universal/SessionHistoryTools";
import { Sidebar, type SessionItem } from "@/components/universal/Sidebar";
import { InteractionPanel } from "@/components/universal/InteractionPanel";
import { useElicitationSync } from "@/hooks/useElicitationSync";
import { Skeleton } from "@/components/ui/skeleton";
import { TitleBar } from "@/components/universal/TitleBar";
import { MountOnFirstOpen } from "@/components/MountOnFirstOpen";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { usePanelRef, useDefaultLayout, type PanelSize } from "react-resizable-panels";
import { useWorkbenchCommands } from "@/hooks/useWorkbenchCommands";
import { useSlashCommands } from "@/hooks/useSlashCommands";
const FileTreePanel = lazy(() => import("@/components/workbench/FileTreePanel"));
const EditorPane = lazy(() => import("@/components/workbench/EditorPane"));
import { useStudioStore, useStudioShallow } from "@/stores/useStudioStore";
import { useAgentsQuery, useSessionsQuery, invalidateAgents, invalidateSessions } from "@/lib/acp-queries";
import {
  logoutAgent,
  sessionRpc,
  findConfigOption,
  type AgentSummary,
} from "@/lib/universal-api";
import {
  useAppBootAndShortcuts,
  useAgentConfig,
  useSessionLifecycle,
  useChatSend,
  useTurnRecovery,
  useEmptySessionCleanup,
} from "@/hooks";
import { isDefaultSessionTitle, titleForThread } from "@/lib/threads";
import { visibleSessions } from "@/lib/session-visibility";
import { appSessionList } from "@/lib/app-sessions";
import {
  formatGenerativeActionPrompt,
  type GenerativeCardAction,
} from "@/lib/present-result";


/**
 * Heavy modals/drawers are code-split so the first paint only ships the
 * shell (Sidebar/Header/Chat/Composer). Each chunk loads on demand via
 * Suspense; failures are loud (console.error) and surface through the root
 * ErrorBoundary instead of a blank screen.
 */
function lazyModal(name: string, loader: () => Promise<React.ComponentType<any>>) {
  return lazy(() =>
    loader()
      .then((comp) => ({ default: comp }))
      .catch((err) => {
        console.error(`[App] lazy chunk "${name}" failed to load:`, err);
        throw err;
      })
  );
}

const SessionSettingsModal = lazyModal(
  "SessionSettingsModal",
  () => import("@/components/universal/SessionSettingsModal").then((m) => m.SessionSettingsModal as any)
);
const ProvidersModal = lazyModal(
  "ProvidersModal",
  () => import("@/components/universal/ProvidersModal").then((m) => m.ProvidersModal as any)
);
const UniversalAuthModal = lazyModal(
  "UniversalAuthModal",
  () => import("@/components/universal/AuthModal").then((m) => m.UniversalAuthModal as any)
);
const CustomAgentModal = lazyModal(
  "CustomAgentModal",
  () => import("@/components/universal/CustomAgentModal").then((m) => m.CustomAgentModal as any)
);
const GitChangesModal = lazyModal(
  "GitChangesModal",
  () => import("@/components/universal/GitChangesModal").then((m) => m.GitChangesModal as any)
);
const TerminalWorkspace = lazyModal(
  "TerminalWorkspace",
  () => import("@/components/universal/TerminalWorkspace").then((m) => m.TerminalWorkspace as any)
);
const ModelBrowserModal = lazyModal(
  "ModelBrowserModal",
  () => import("@/components/universal/ModelBrowserModal").then((m) => m.ModelBrowserModal as any)
);

/** Suspense placeholder for lazily loaded modals/drawers. */
function LazyModalFallback() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
      <div className="w-full max-w-md space-y-2 rounded-2xl border border-border bg-card p-4">
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-3/5" />
      </div>
    </div>
  );
}

/**
 * AutumnFlow Universal — full ACP v1 client.
 * Decoupled controller layer via focused hooks:
 * 1. useAppBootAndShortcuts: theme, thread restore, agent validation, trailing snapshot, hotkeys.
 * 2. useAgentConfig: model config, fallback model, preferences migration, discovery.
 * 3. useSessionLifecycle: resume-first session resolution, race-condition guard, open/fork/delete.
 * 4. useChatSend: streaming orchestration, wall-clock timing, permissions & elicitations.
 *
 * Re-render discipline: this shell subscribes via `useStudioShallow`, which
 * excludes `messages`. Streaming chunks therefore re-render only the
 * transcript leaves, not the whole layout.
 */
/** 把 store 里的开关同步到可收起面板（命令 / 快捷键 → 面板）。 */
function useSyncPanel(ref: ReturnType<typeof usePanelRef>, open: boolean) {
  React.useEffect(() => {
    const p = ref.current;
    if (!p) return;
    if (open && p.isCollapsed()) p.expand();
    else if (!open && !p.isCollapsed()) p.collapse();
  }, [ref, open]);
}

export default function App() {
  useElicitationSync();
  usePermissionSync();
  const qc = useQueryClient();
  const agentsRef = useRef<AgentSummary[]>([]);
  const [customOpen, setCustomOpen] = useState(false);
  const [importHistoryOpen, setImportHistoryOpen] = useState(false);
  const s = useStudioShallow();

  // Server state (TanStack Query)
  const agentsQuery = useAgentsQuery();
  const agents = agentsQuery.data ?? [];
  const activeAgent = agents.find((a) => a.id === s.activeAgentId);
  const connected = !!activeAgent?.status?.connected;
  const sessionsQuery = useSessionsQuery(s.activeAgentId, connected);
  const sessionsRaw = sessionsQuery.data ?? [];
  // 本应用打开过/使用过的会话（跨运行时）：本地线程缓存是主干——每个线程都知道
  // 自己绑的是哪个运行时；再加上当前运行时的 agent 侧历史（应用外建的）。
  // 一个会话只对应一个运行时，一个运行时可以有多个会话。
  const sessions = useMemo<SessionItem[]>(
    () =>
      appSessionList({
        threads: s.threads,
        agentSessions: visibleSessions(sessionsRaw, s.threads, s.activeAgentId),
        activeAgentId: s.activeAgentId,
        agentTitle: (id) => agents.find((a) => a.id === id)?.title || id,
        streamingSessionId: s.streamingSessionId,
      }),
    [agents, s.threads, sessionsRaw, s.activeAgentId, s.streamingSessionId]
  );
  const activeThread = s.activeThreadId ? s.threads[s.activeThreadId] : undefined;
  /** 本会话是否在生成：别的会话在跑不该让这个会话排队。 */
  const sessionBusy = s.isStreaming && (!s.streamingSessionId || s.streamingSessionId === s.sessionId);
  const activeThreadTitle = titleForThread(activeThread);
  const agentSessionTitle = isDefaultSessionTitle(s.sessionInfo?.title) ? undefined : s.sessionInfo?.title;
  const headerSessionTitle = agentSessionTitle || activeThreadTitle || undefined;
  const sessionCwd = sessionsRaw.find((x) => x.sessionId === s.sessionId)?.cwd || null;

  // Filter is immediate; this eventually deletes abandoned empty drafts from
  // the Agent store too (only app-owned threads, never imported ones).
  useEmptySessionCleanup({
    agentId: s.activeAgentId,
    sessions: sessionsRaw,
    threads: s.threads,
    currentSessionId: s.sessionId,
    connected,
    qc,
  });
  const isWsl = Boolean(typeof localStorage !== "undefined" && localStorage.getItem("acp_wsl_native_distro"));
  const rawEffective = s.currentWorkspace || sessionCwd;
  // WSL 纯净模式：绝不把 Windows 挂载盘 /mnt/... 当作有效工作区
  const effectiveCwd = (isWsl && rawEffective && /^\/mnt\/[a-zA-Z](\/|$)/i.test(rawEffective))
    ? (s.currentWorkspace && !/^\/mnt\//i.test(s.currentWorkspace) ? s.currentWorkspace : null)
    : rawEffective;

  const caps = (activeAgent?.status?.agentCapabilities || {}) as any;
  const sessionCaps = (caps.sessionCapabilities || {}) as Record<string, unknown>;
  const promptCaps = (caps.promptCapabilities || {}) as Record<string, unknown>;
  const mcpCaps = (caps.mcpCapabilities || {}) as Record<string, unknown>;
  const supportsList = "list" in sessionCaps;
  const supportsFork = "fork" in sessionCaps;
  const supportsProviders = !!caps.providers;
  const supportsAdditionalDirs = "additionalDirectories" in sessionCaps;
  const supportImage = !!promptCaps.image;

  // 1. Boot initialization & global shortcuts
  useAppBootAndShortcuts({
    agents,
    agentsRef,
    activeAgentId: s.activeAgentId,
    sessionId: s.sessionId,
    activeThreadId: s.activeThreadId,
    currentWorkspace: s.currentWorkspace,
  });

  // Refresh/window recovery: reattach an accepted turn from its last seq.
  useTurnRecovery();

  // Dynamic forward-reference for ensureSession between useAgentConfig & useSessionLifecycle
  const ensureSessionRef = useRef<(agentId?: string, force?: boolean) => Promise<string | null>>(async () => null);

  // 2. Agent configuration & model preferences
  const {
    applyDefaultConfigOptions,
    setSessionConfig,
    handleFallbackModel,
    handleApplyModel,
    handleDiscoverModels,
  } = useAgentConfig({
    agentsRef,
    ensureSession: (agentId, force) => ensureSessionRef.current(agentId, force),
  });

  // Forward ref for abortRef in session lifecycle (e.g. aborting on agent switch)
  const abortRefProxy = useRef<AbortController | null>(null);

  // 3. Session lifecycle & resume-first resolution
  const {
    ensureSession,
    resolveSession,
    handleSelectAgent,
    handleConnect,
    handleCreateSession,
    handleDirectNewSession,
    handleOpenSession,
    handleForkSession,
    handleDeleteSession,
    handleCleanupEmpty,
    cleaningEmpty,
  } = useSessionLifecycle({
    qc,
    agents,
    agentsRef,
    applyDefaultConfigOptions,
    abortRef: abortRefProxy,
  });
  ensureSessionRef.current = ensureSession;

  // 4. Chat turn execution & streaming
  const { runLocal } = useSlashCommands();
  const {
    abortRef,
    handleSend,
    handleStop,
    handleSteer,
    handleWithdraw,
    handlePermRespond,
    handleElicRespond,
  } = useChatSend({
    qc,
    agentsRef,
    resolveSession,
  });
  abortRefProxy.current = abortRef.current;

  // 5. Generative UI Interactive feedback loop
  const handleGenerativeAction = useCallback(
    async (action: GenerativeCardAction) => {
      const prompt = formatGenerativeActionPrompt(action);
      if (!prompt) return;
      const cur = useStudioStore.getState();
      if (cur.isStreaming) {
        throw new Error("智能体正在生成回答中，请稍候再提交。");
      }
      if (!runLocal(prompt)) {
        void handleSend(prompt);
      }
    },
    [runLocal, handleSend]
  );

  // Stable Sidebar callbacks & silent background loading decoupling
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const handleRefreshSessions = useCallback(async () => {
    setManualRefreshing(true);
    try {
      await invalidateSessions(qc, s.activeAgentId);
    } finally {
      setManualRefreshing(false);
    }
  }, [qc, s.activeAgentId]);

  const handleNewSession = useCallback((targetCwd?: string) => {
    handleDirectNewSession(targetCwd);
  }, [handleDirectNewSession]);

  const handleForkSessionItem = useCallback(
    (item: SessionItem) => {
      handleForkSession(item.sessionId);
    },
    [handleForkSession]
  );

  const handleOpenProviders = useCallback(() => {
    useStudioStore.getState().setProvidersOpen(true);
  }, []);

  const handleManageCustom = useCallback(() => {
    setCustomOpen(true);
  }, []);

  const sidebarOpen = useWorkbenchStore((w) => w.sidebarOpen);
  const fileTreeOpen = useWorkbenchStore((w) => w.fileTreeOpen);
  const hasTabs = useWorkbenchStore((w) => w.tabs.length > 0);
  const openNewSessionDialog = useCallback(() => handleNewSession(), [handleNewSession]);
  useWorkbenchCommands({ onNewSession: openNewSessionDialog });

  // 可拖拽面板：尺寸按面板组合存 localStorage；侧栏 / 文件树拖到最小即收起，与 Ctrl+B / Ctrl+Shift+E 同步
  const sidebarPanel = usePanelRef();
  const treePanel = usePanelRef();
  const panelIds = hasTabs ? ["sidebar", "filetree", "editor", "chat"] : ["sidebar", "filetree", "chat"];
  const savedLayout = useDefaultLayout({ id: "acp-workbench-v1", panelIds, storage: localStorage });
  useSyncPanel(sidebarPanel, sidebarOpen);
  useSyncPanel(treePanel, fileTreeOpen);
  const onSidebarResize = useCallback((size: PanelSize) => {
    const open = size.inPixels > 1;
    if (open !== useWorkbenchStore.getState().sidebarOpen) useWorkbenchStore.getState().setSidebarOpen(open);
  }, []);
  const onTreeResize = useCallback((size: PanelSize) => {
    const open = size.inPixels > 1;
    if (open !== useWorkbenchStore.getState().fileTreeOpen) useWorkbenchStore.getState().setFileTreeOpen(open);
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen bg-background text-foreground overflow-hidden select-text">
      {/* Layer 1: Clean Window TitleBar */}
      <TitleBar />

      <ResizablePanelGroup
        id="acp-workbench"
        orientation="horizontal"
        className="flex-1 min-h-0 overflow-hidden"
        defaultLayout={savedLayout.defaultLayout}
        onLayoutChanged={savedLayout.onLayoutChanged}
      >
        <ResizablePanel id="sidebar" panelRef={sidebarPanel} collapsible collapsedSize={0} minSize="200px" defaultSize="240px" maxSize="420px" onResize={onSidebarResize} className="overflow-hidden [&>aside]:w-full [&>aside]:h-full">
        <Sidebar
          onImportHistory={supportsList ? () => setImportHistoryOpen(true) : undefined}
          agents={agents}
          activeAgentId={s.activeAgentId}
          onSelectAgent={handleSelectAgent}
          onConnectAgent={handleConnect}
          connectingId={s.connectingId}
          cleaningEmpty={cleaningEmpty}
          onCleanupEmpty={handleCleanupEmpty}
          authOk={s.authOk}
          sessions={sessions}
          sessionsError={sessionsQuery.error?.message}
          sessionsLoading={(sessionsQuery.isLoading && sessions.length === 0) || manualRefreshing}
          activeSessionId={s.sessionId}
          onRefreshSessions={handleRefreshSessions}
          onNewSession={handleNewSession}
          onOpenSession={handleOpenSession}
          onForkSession={handleForkSessionItem}
          onDeleteSession={handleDeleteSession}
          supportsFork={supportsFork}
          supportsList={supportsList}
          onOpenProviders={handleOpenProviders}
          supportsProviders={supportsProviders}
          onManageCustom={handleManageCustom}
          currentWorkspace={s.currentWorkspace}
          recentWorkspaces={s.recentWorkspaces}
          onSelectWorkspace={(p, name) => s.setWorkspace(p, name)}
          onOpenSettings={() => s.setSettingsOpen(true)}
        />
        </ResizablePanel>
        <ResizableHandle className={sidebarOpen ? "" : "w-0"} />

        <ResizablePanel id="filetree" panelRef={treePanel} collapsible collapsedSize={0} minSize="160px" defaultSize="256px" maxSize="480px" onResize={onTreeResize} className="overflow-hidden">
          <aside className="h-full bg-sidebar" aria-label="文件树">
            {fileTreeOpen && (
              <Suspense fallback={<div className="p-3"><Skeleton className="h-4 w-32" /></div>}>
                <FileTreePanel cwd={effectiveCwd} />
              </Suspense>
            )}
          </aside>
        </ResizablePanel>
        <ResizableHandle className={fileTreeOpen ? "" : "w-0"} />

        {hasTabs && (
          <>
            <ResizablePanel id="editor" minSize="280px" defaultSize="50%" className="overflow-hidden">
              <section className="h-full min-w-0" aria-label="编辑器">
                <Suspense fallback={<div className="p-3"><Skeleton className="h-4 w-48" /></div>}>
                  <EditorPane cwd={effectiveCwd} />
                </Suspense>
              </section>
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}

        <ResizablePanel id="chat" minSize="360px" defaultSize={hasTabs ? "440px" : undefined} className="overflow-hidden">
        <div className="h-full flex flex-col min-w-0">
          {/* Layer 2: Retained Lower Workbench Header */}
          <StudioHeader
            agents={agents}
            activeAgentId={s.activeAgentId}
            onSelectAgent={handleSelectAgent}
            onConnect={() => handleConnect()}
            connecting={s.connectingId === s.activeAgentId}
            onOpenAuth={() => s.setAuthOpen(true)}
            onLogout={async () => {
              try {
                await logoutAgent(s.activeAgentId);
                invalidateAgents(qc);
              } catch (e: any) {
                alert(`logout 失败: ${e.message}`);
              }
            }}
            authOk={s.authOk[s.activeAgentId] ?? null}
            sessionId={s.sessionId}
            sessionTitle={headerSessionTitle}
            usage={s.usage}
            currentWorkspace={s.currentWorkspace}
            recentWorkspaces={s.recentWorkspaces}
            onSelectWorkspace={(p, name) => s.setWorkspace(p, name)}
            terminalOpen={s.terminalOpen}
            onToggleTerminal={() => s.setTerminalOpen(!s.terminalOpen)}
            hasChangesCwd={!!effectiveCwd}
            supportsFork={supportsFork}
            supportsProviders={supportsProviders}
            busy={s.busy || s.isStreaming}
            isStreaming={s.isStreaming}
            onNewSession={handleNewSession}
            onForkSession={() => handleForkSession()}
            onOpenProviders={() => s.setProvidersOpen(true)}
            onOpenChanges={() => s.setGitChangesOpen(true)}
            onCloseSession={async () => {
              const cur = useStudioStore.getState();
              if (!cur.sessionId) return;
              await sessionRpc(cur.activeAgentId, "close", { sessionId: cur.sessionId }).catch((e: any) => alert(e.message));
              cur.setSessionId(null);
              invalidateSessions(qc, cur.activeAgentId);
            }}
            onDeleteSession={async () => {
              const cur = useStudioStore.getState();
              if (!cur.sessionId) return;
              if (!confirm(`删除会话 ${cur.sessionId}？`)) return;
              await sessionRpc(cur.activeAgentId, "delete", { sessionId: cur.sessionId }).catch((e: any) => alert(e.message));
              cur.setSessionId(null);
              cur.resetThread();
              invalidateSessions(qc, cur.activeAgentId);
            }}
            onClearMessages={() => !s.isStreaming && s.setMessages([])}
            compact={hasTabs}
          />
          {importHistoryOpen && <ExternalHistoryDialog key={s.activeAgentId} agentId={s.activeAgentId}
            onClose={() => setImportHistoryOpen(false)} onOpen={item => void handleOpenSession(item)} />}

          <AcpAssistantProvider
            onSend={(t) => { if (!runLocal(t ?? "")) void handleSend(t); }}
            onStop={handleStop}
            onNewSession={handleNewSession}
            onOpenSession={(sid) => {
              const item = sessions.find((item) => item.sessionId === sid);
              if (item) void handleOpenSession(item);
              else {
                useStudioStore.getState().optimisticOpenSession(s.activeAgentId, sid, "");
              }
            }}
            onDeleteSession={(sid) => {
              const item = sessions.find((item) => item.sessionId === sid);
              if (item) void handleDeleteSession(item);
            }}
          >
            <AssistantChatView
              onSelectSuggestion={(p) => { if (!runLocal(p)) void handleSend(p); }}
              agentName={activeAgent?.title || activeAgent?.name || "Agent"}
              onOpenDiff={(file) => s.setGitChangesOpen(true, file)}
              connected={connected}
              sessionId={s.sessionId}
              sessionError={s.sessionError}
              sessionLoading={s.sessionLoading}
              onEnsureSession={() => ensureSession()}
              onNewSession={handleNewSession}
              cwd={effectiveCwd}
              onGenerativeAction={handleGenerativeAction}
            />

            {/* 权限与提问独立弹窗：它们会阻塞当前这一轮，必须从工具列表里
                独立出来、明确地弹到台面上。输入框仍然可用。 */}
            <InteractionPanel
              permissions={s.pendingPerms.filter(p => permissionInScope(p, s.activeAgentId, s.sessionId))}
              elicitations={s.pendingElic.filter(e => !s.authOpen && elicitationInScope(e, s.activeAgentId, s.sessionId))}
              onRespondPermission={handlePermRespond}
              onRespondElicitation={handleElicRespond}
              respondingId={s.respondingId}
            />

            <AcpComposer
              onSendAttachmentOnly={() => handleSend("")}
              onStop={handleStop}
              queuedPrompts={s.activeThreadId ? s.threads[s.activeThreadId]?.queuedPrompts ?? [] : []}
              onWithdraw={handleWithdraw}
              onQueue={(text) => void handleSend(text)}
              onSubmitPrompt={(text) => void handleSend(text)}
              onSteer={handleSteer}
              restoredText={s.input}
              onClear={() => !sessionBusy && s.setMessages([])}
              isStreaming={sessionBusy}
              commands={s.availableCommands}
              supportImage={supportImage}
              attachments={s.attachments}
              setAttachments={(a) => s.setAttachments(a)}
              agentTitle={activeAgent?.title || s.activeAgentId}
              configOptions={s.configOptions}
              onSetConfig={(configId, value) => setSessionConfig(configId, value)}
              onBrowseModels={() => s.setModelsOpen(true)}
              hasModelCatalog={!!s.models}
              connected={connected}
              fallbackModels={s.models?.availableModels || null}
              fallbackCurrentModel={s.models?.currentModelId || ""}
              onFallbackModel={handleFallbackModel}
              onEnsureSession={() => ensureSession(s.activeAgentId, true)}
              sessionLoading={s.sessionLoading}
              currentWorkspace={effectiveCwd}
              recentWorkspaces={s.recentWorkspaces}
              onSelectWorkspace={(p, name) => s.setWorkspace(p, name)}
              onOpenChanges={() => s.setGitChangesOpen(true)}
              onToggleTerminal={() => s.setTerminalOpen(!s.terminalOpen)}
            />
          </AcpAssistantProvider>
        </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Layer 3: Bottom StatusBar（VSCode 式：左远程角标 + 右网关/工作区速览） */}
      <StatusBar />

      <MountOnFirstOpen isOpen={s.authOpen}>
        <Suspense fallback={s.authOpen ? <LazyModalFallback /> : null}>
          <UniversalAuthModal
            onElicitationRespond={handleElicRespond}
            isOpen={s.authOpen}
            onClose={() => s.setAuthOpen(false)}
            agent={activeAgent}
            onAuthenticated={async () => {
              invalidateAgents(qc);
              const activeId = useStudioStore.getState().activeAgentId;
              // Report what the probe actually says: a failed refresh must not
              // leave the dialog claiming the local login was reused.
              try {
                await sessionRpc(activeId, "list", {});
                useStudioStore.getState().setAuthOk(activeId, true);
              } catch {
                useStudioStore.getState().setAuthOk(activeId, false);
              }
            }}
            onLogout={async () => {
              try {
                await logoutAgent(s.activeAgentId);
                invalidateAgents(qc);
              } catch (e: any) {
                alert(`logout 失败: ${e.message}`);
              }
            }}
            authOk={s.authOk[s.activeAgentId] ?? null}
          />
        </Suspense>
      </MountOnFirstOpen>

      <MountOnFirstOpen isOpen={s.settingsOpen}>
        <Suspense fallback={s.settingsOpen ? <LazyModalFallback /> : null}>
          <SessionSettingsModal
            isOpen={s.settingsOpen}
            onClose={() => s.setSettingsOpen(false)}
            onCreate={handleCreateSession}
            busy={s.busy}
            defaultCwdHint={effectiveCwd || undefined}
            supportsAdditionalDirs={supportsAdditionalDirs}
            supportsMcpHttp={!!mcpCaps.http}
          />
        </Suspense>
      </MountOnFirstOpen>

      <MountOnFirstOpen isOpen={s.providersOpen}>
        <Suspense fallback={s.providersOpen ? <LazyModalFallback /> : null}>
          <ProvidersModal isOpen={s.providersOpen} onClose={() => s.setProvidersOpen(false)} agentId={s.activeAgentId} />
        </Suspense>
      </MountOnFirstOpen>

      <MountOnFirstOpen isOpen={customOpen}>
        <Suspense fallback={customOpen ? <LazyModalFallback /> : null}>
          <CustomAgentModal
            isOpen={customOpen}
            onClose={() => setCustomOpen(false)}
            agents={agents}
            onChanged={() => invalidateAgents(qc)}
          />
        </Suspense>
      </MountOnFirstOpen>

      <MountOnFirstOpen isOpen={s.gitChangesOpen}>
        <Suspense fallback={s.gitChangesOpen ? <LazyModalFallback /> : null}>
          <GitChangesModal
            isOpen={s.gitChangesOpen}
            onClose={() => s.setGitChangesOpen(false)}
            cwd={effectiveCwd}
            initialFilePath={s.gitDiffFile}
          />
        </Suspense>
      </MountOnFirstOpen>

      <MountOnFirstOpen isOpen={s.terminalOpen}>
        <Suspense fallback={s.terminalOpen ? <LazyModalFallback /> : null}>
          <TerminalWorkspace
            isOpen={s.terminalOpen}
            onClose={() => s.setTerminalOpen(false)}
            cwd={effectiveCwd}
          />
        </Suspense>
      </MountOnFirstOpen>

      <MountOnFirstOpen isOpen={s.modelsOpen}>
        <Suspense fallback={s.modelsOpen ? <LazyModalFallback /> : null}>
          <ModelBrowserModal
            isOpen={s.modelsOpen}
            onClose={() => s.setModelsOpen(false)}
            catalog={s.models}
            modelOption={findConfigOption(s.configOptions, "model")}
            currentModelId={s.models?.currentModelId}
            discovering={s.discovering}
            onRefresh={handleDiscoverModels}
            onApply={handleApplyModel}
          />
        </Suspense>
      </MountOnFirstOpen>
    </div>
  );
}
