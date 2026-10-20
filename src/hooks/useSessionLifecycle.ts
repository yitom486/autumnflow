import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useStudioStore } from "@/stores/useStudioStore";
import { invalidateAgents, invalidateSessions } from "@/lib/acp-queries";
import {
  connectAgent,
  sessionNew,
  sessionRpc,
  loadSession,
  forkSession,
  buildTranscriptFromReplay,
  isAuthRequiredError,
  isSessionGoneError,
  cleanupEmptySessions,
  type ActivityEvent,
  type AgentSummary,
} from "@/lib/universal-api";
import { isSameCwd } from "@/lib/threads";
import type { SessionItem } from "@/components/universal/Sidebar";
import type { SessionSettings } from "@/components/universal/SessionSettingsModal";

export interface UseSessionLifecycleOptions {
  qc: QueryClient;
  agents: AgentSummary[];
  agentsRef: React.RefObject<AgentSummary[]>;
  applyDefaultConfigOptions: (agentId: string, sessionId: string) => Promise<void>;
  abortRef?: React.RefObject<AbortController | null>;
  appendActivity?: (a: ActivityEvent) => void;
  now?: () => string;
}

const defaultNow = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const {
  setActiveAgentId,
  restoreThread,
  newThread,
  snapshotThread,
  bindThreadSession,
  markThreadStale,
} = useStudioStore.getState();

/**
 * Session Lifecycle & Agent Management Controller Hook.
 *
 * Implements the crucial stability invariants:
 * 1. Single session-resolution policy: UI history ⟺ session binding.
 *    Resume-first single strategy: restore remembered ACP session so model context continues.
 *    Only creates a new session when none is bound or resume fails.
 * 2. Race-condition guard in handleOpenSession: checks cur.sessionId === item.sessionId.
 * 3. StrictMode-safe boot probe via ensuredRef.
 * 4. Bound session protection in handleCleanupEmpty.
 */
export function useSessionLifecycle({
  qc,
  agents,
  agentsRef,
  applyDefaultConfigOptions,
  abortRef,
  appendActivity,
  now = defaultNow,
}: UseSessionLifecycleOptions) {
  const ensuredRef = useRef<string | null>(null);
  /** In-flight session creations, keyed by agent id; see ensureSession. */
  const ensureInFlight = useRef(new Map<string, Promise<string | null>>());
  const [cleaningEmpty, setCleaningEmpty] = useState(false);

  /**
   * Non-mutating local-auth probe: session/list succeeds without any
   * authenticate call iff the agent reuses local login state.
   */
  const probeAuth = useCallback(async (agentId: string) => {
    try {
      await sessionRpc(agentId, "list", {});
      useStudioStore.getState().setAuthOk(agentId, true);
    } catch (e: any) {
      const isAuthErr = isAuthRequiredError(e);
      // agy / antigravity-stdio 是官方桥接，无认证协议拦截，复用本地凭据
      const isAgy = agentId === "antigravity-stdio" || agentId === "agy";
      useStudioStore.getState().setAuthOk(agentId, isAuthErr ? false : (isAgy ? true : null));
    }
  }, []);

  /**
   * The actual session/new round trip; see ensureSession for the dedup policy.
   */
  const createSession = useCallback(
    async (agentId: string, force: boolean): Promise<string | null> => {
      const st = useStudioStore.getState();
      st.setSessionLoading(true);
      try {
        const known = agentsRef.current.find((a) => a.id === agentId)?.status?.connected;
        if (!known) await connectAgent(agentId);
        const reqCwd = st.currentWorkspace || undefined;
        // Auto-created sessions inherit the agent thread's MCP servers and its
        // session-level code mode.
        const autoServers = st.threadMcpServers(agentId);
        const codeMode = st.activeThreadId ? st.threads[st.activeThreadId]?.codeMode === true : false;

        // Auto-prune uncommitted empty draft: if leaving behind an empty session with 0 user messages,
        // delete it from the agent so abandoned zero-message sessions don't clutter the sidebar.
        const prevSid = st.sessionId;
        const prevHasUserMsg = st.messages.some((m) => m.role === "user");
        // Whether the view had content has to be judged when the session is
        // REQUESTED. Judging it when the response arrives would let a message
        // that the user sent while session/new was in flight switch the thread
        // and disappear from the chat.
        const prevHadMessages = st.messages.length > 0;
        if (prevSid && !prevHasUserMsg) {
          void sessionRpc(agentId, "delete", { sessionId: prevSid }).catch(() => {});
        }

        const res: any = await sessionNew(agentId, {
          ...(reqCwd ? { cwd: reqCwd } : {}),
          ...(autoServers?.length ? { mcpServers: autoServers } : {}),
          ...(codeMode ? { codeMode: "on" } : {}),
        });

        // Isolation guard: the user may have switched agents while session/new
        // was in flight. Applying this result would bind agent A's session to
        // agent B's live thread (the exact cross-agent mismatch that then
        // fails session/resume with "Invalid params").
        const after = useStudioStore.getState();
        if (after.activeAgentId !== agentId) {
          const orphan = res?.sessionId;
          if (typeof orphan === "string" && orphan) {
            void sessionRpc(agentId, "delete", { sessionId: orphan }).catch(() => {});
          }
          console.warn(`[App] 丢弃 ${agentId} 的迟到 session/new 结果（当前已切到 ${after.activeAgentId}）`);
          return null;
        }

        // Strict isolation: if starting a new session and previous view had messages or was forced,
        // create a brand-new thread so previous session's history NEVER leaks into the new session!
        if (prevHasUserMsg || force || prevHadMessages) {
          newThread(agentId, reqCwd);
        }

        after.applySessionResult(res, agentId);
        bindThreadSession(useStudioStore.getState().sessionId, reqCwd, autoServers);
        st.setAuthOk(agentId, true);
        st.setSessionError(null);
        invalidateSessions(qc, agentId);
        invalidateAgents(qc);
        if (res?.sessionId) {
          void applyDefaultConfigOptions(agentId, res.sessionId);
        }
        return res?.sessionId || null;
      } catch (e: any) {
        if (isAuthRequiredError(e)) {
          st.setAuthOk(agentId, false);
          st.setAuthOpen(true);
          st.setSessionError(null);
        } else {
          const msg =
            e?.message && e.message !== "null"
              ? e.message
              : "无法创建会话（Agent进程未连接或异常）";
          st.setSessionError(msg);
        }
        return null;
      } finally {
        useStudioStore.getState().setSessionLoading(false);
      }
    },
    [qc, agentsRef, applyDefaultConfigOptions]
  );

  /**
   * Create a session on demand (e.g. user tweaks model/thinking before chatting).
   */
  const ensureSession = useCallback(
    async (
      agentId: string = useStudioStore.getState().activeAgentId,
      force = false
    ): Promise<string | null> => {
      const st = useStudioStore.getState();
      // A stale thread is a read-only historical transcript. Its recorded id
      // must never satisfy ensureSession, otherwise the composer's "加载模型"
      // action returns the dead id and no session/new is ever issued.
      const activeThread = st.activeThreadId ? st.threads[st.activeThreadId] : undefined;
      const staleBinding = activeThread?.stale === true;
      if (!force && !staleBinding && st.sessionId && agentId === st.activeAgentId) return st.sessionId;
      if (!force && (st.isStreaming || st.busy)) return null;
      // Share one in-flight creation per agent. Boot pre-warm and the first
      // send can both reach this point before either resolves (the agent is
      // still spawning), and two parallel session/new calls would leave the
      // loser orphaned on the agent side. `force` deliberately means "make a
      // brand-new session", so it never joins the shared promise.
      if (!force) {
        const pending = ensureInFlight.current.get(agentId);
        if (pending) return pending;
      }
      const creation = createSession(agentId, force);
      if (!force) {
        ensureInFlight.current.set(agentId, creation);
        const release = () => {
          if (ensureInFlight.current.get(agentId) === creation) ensureInFlight.current.delete(agentId);
        };
        creation.then(release, release);
      }
      return creation;
    },
    [createSession]
  );

  /**
   * Replace the live view with the agent's own transcript.
   *
   * The agent stores the conversation; the app's local thread cache is only
   * there to paint the first frame. After a re-attach, the agent's replay is
   * the truth — the cache may be missing turns the agent has since recorded.
   */
  const replayAgentTranscript = useCallback(
    async (agentId: string, sessionId: string, cwd?: string | null) => {
      try {
        const { replayed } = await loadSession(agentId, {
          sessionId,
          ...(cwd ? { cwd } : {}),
          mcpServers: useStudioStore.getState().threadMcpServers(agentId) ?? [],
        });
        const transcript = buildTranscriptFromReplay(replayed || []);
        const cur = useStudioStore.getState();
        if (cur.activeAgentId !== agentId || cur.sessionId !== sessionId) return;
        if (transcript.messages.length === 0) return;
        cur.setMessages(
          transcript.messages.map((m, index) => ({
            id: `hist-${Date.now()}-${index}`,
            role: m.role,
            content: m.content,
            thought: m.thought,
            toolCalls: m.toolCalls,
            images: m.images,
            contentBlocks: m.contentBlocks,
            artifacts: m.artifacts,
            timestamp: now(),
          }))
        );
      } catch (err) {
        // The replay is a refresh, not a requirement: the cached view stays.
        console.debug("[App] 回放 agent 历史失败（沿用本地缓存）:", err);
      }
    },
    [now]
  );

  /**
   * True resume (Inkdown-style layer 2): reattach the remembered ACP session
   * so model-side context continues.
   *
   * The agent owns the conversation. The local thread cache only makes the
   * first paint instant; once the session is re-attached, the agent's own
   * transcript is replayed and becomes the live view.
   */
  const restoreAgentSession = useCallback(
    async (agentId: string): Promise<{ resumed: boolean; result?: any }> => {
      const st = useStudioStore.getState();
      const sid = st.sessionId;
      if (!sid || st.isStreaming) return { resumed: false };
      // Isolation: resume only ids bound to THIS agent's live thread.
      const thread = st.activeThreadId ? st.threads[st.activeThreadId] : undefined;
      if (!thread || thread.agentId !== agentId || thread.sessionId !== sid) {
        return { resumed: false };
      }
      // 工作区校验：若该会话记录了所属工作区，且与当前激活工作区不匹配，拒绝跨工作区唤醒
      if (thread.cwd && st.currentWorkspace && !isSameCwd(thread.cwd, st.currentWorkspace)) {
        return { resumed: false };
      }
      try {
        const result: any = await sessionRpc(agentId, "resume", {
          sessionId: sid,
          ...(thread.cwd || st.currentWorkspace
            ? { cwd: thread.cwd || st.currentWorkspace }
            : {}),
          // Carry the thread's MCP servers so auto-resume keeps working tools.
          mcpServers: thread.mcpServers ?? [],
          // Re-request code mode: the agent applies it per session, and a resume
          // is a new session activation on its side.
          ...(thread.codeMode ? { codeMode: "on" } : {}),
        });
        // A late resume must not touch the new agent's view.
        if (useStudioStore.getState().activeAgentId !== agentId) return { resumed: false };
        await replayAgentTranscript(agentId, sid, thread.cwd || st.currentWorkspace);
        return { resumed: true, result };
      } catch (err) {
        console.warn(`[App] resume 会话失败 (${agentId}/${sid.slice(0, 8)}…):`, err);
        if (useStudioStore.getState().activeAgentId !== agentId) return { resumed: false };
        // Only a session the agent no longer knows is really gone. A transient
        // failure (the agent is still starting, the connection dropped) must not
        // retire the thread: a stale thread resolves to no session at all, so
        // the next message would be dropped without a trace.
        if (!isSessionGoneError(err)) return { resumed: false };
        // Visible degrade: mark stale, but PRESERVE the thread's binding and messages
        // as a read-only historical record. Never hijack it with a fake new session!
        markThreadStale();
        const sidPrefix = sid.slice(0, 8);
        const alreadyNotified =
          thread.messages.some(
            (m) => m.role === "system" && m.content.includes(sidPrefix)
          ) ||
          st.messages.some(
            (m) => m.role === "system" && m.content.includes(sidPrefix)
          );
        if (thread.messages.some((m) => m.role === "user") && !alreadyNotified) {
          st.appendMessage({
            id: `sys-${Date.now()}-stale`,
            role: "system",
            content: `会话 (${sidPrefix}…) 在 Agent 端已失效或已过期（当前为历史记录视图）。点击上方「+ 新会话」可开启独立新会话。`,
            timestamp: now(),
          });
        }
        return { resumed: false };
      }
    },
    [now]
  );

  /**
   * Single session-resolution policy (stability invariant):
   * UI history ⟺ session binding. Whenever a live thread binds a sessionId,
   * resume it first so model-side context continues; only create a new
   * session when nothing is bound or resume fails.
   */
  const resolveSession = useCallback(
    async (agentId: string): Promise<string | null> => {
      const cur0 = useStudioStore.getState();
      if (cur0.activeAgentId !== agentId) return null;
      if (cur0.isStreaming) return cur0.sessionId;
      // 1. resume the bound session (restores modes/models/config for selectors)
      const { resumed, result } = await restoreAgentSession(agentId);
      const cur = useStudioStore.getState();
      if (cur.activeAgentId !== agentId) return null;
      if (resumed) {
        if (result?.modes) cur.setModes(result.modes);
        if (result?.models) cur.setModels(result.models);
        if (result?.configOptions) cur.setConfigOptions(result.configOptions);
        const sid = cur.sessionId;
        if (Array.isArray(result?.availableCommands)) cur.setAvailableCommands(result.availableCommands, sid);
        if (sid) void applyDefaultConfigOptions(agentId, sid);
        ensuredRef.current = agentId;
        return sid;
      }
      // 2. Strict Session Isolation:
      // If the current active thread failed to resume (marked stale),
      // leave it as an isolated read-only historical transcript.
      const thread = cur.activeThreadId ? cur.threads[cur.activeThreadId] : undefined;
      if (thread?.stale) {
        ensuredRef.current = agentId;
        return null;
      }
      // 3. no binding and no history (clean draft) -> create fresh session
      const sid = await ensureSession(agentId, false);
      if (sid) ensuredRef.current = agentId;
      return sid;
    },
    [restoreAgentSession, ensureSession, applyDefaultConfigOptions]
  );

  // One-time: probe local-auth reuse for connected agents + ensure a session
  // for the active one (StrictMode-safe via ensuredRef).
  useEffect(() => {
    if (agents.length === 0) return;
    void (async () => {
      const probes = Promise.all(
        agents
          .filter(
            (a) => a.status?.connected && useStudioStore.getState().authOk[a.id] === undefined
          )
          .map((a) => probeAuth(a.id))
      );
      const active = agents.find(
        (a) => a.id === useStudioStore.getState().activeAgentId
      );
      if (active && ensuredRef.current !== active.id) {
        ensuredRef.current = active.id;
        try {
          if (!active.status?.connected) {
            await connectAgent(active.id);
            invalidateAgents(qc);
          }
          // Resume-first: never abandon the restored thread's session on boot.
          await resolveSession(active.id);
        } catch (err) {
          console.warn("[App] Eager pre-warm active agent failed:", err);
        }
      }
      await probes;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  // Switching agent resets session-scoped state (sessions live per-agent on gateway)
  const handleSelectAgent = useCallback(
    (id: string) => {
      const st = useStudioStore.getState();
      if (id === st.activeAgentId) return;
      abortRef?.current?.abort();
      snapshotThread();
      setActiveAgentId(id);
      // Per-agent isolation: only this agent's own thread (and its sessionId)
      // ever enters the live view.
      if (!restoreThread(id)) newThread(id);
      const target = agentsRef.current.find((a) => a.id === id);
      invalidateSessions(qc, id);
      // Pre-warm selected agent in background
      void (async () => {
        try {
          if (!target?.status?.connected) {
            await connectAgent(id);
            invalidateAgents(qc);
          }
          await resolveSession(id);
        } catch (err) {
          console.warn(`[App] Eager connect on agent select (${id}) failed:`, err);
        }
      })();
    },
    [qc, agentsRef, abortRef, resolveSession]
  );

  const handleConnect = useCallback(
    async (id: string = useStudioStore.getState().activeAgentId) => {
      const st = useStudioStore.getState();
      st.setConnectingId(id);
      try {
        await connectAgent(id);
        invalidateAgents(qc);
        // Pipelined: run probeAuth and resolveSession concurrently
        await Promise.all([probeAuth(id), resolveSession(id)]);
        invalidateSessions(qc, id);
      } catch (e: any) {
        const msg =
          e?.message && e.message !== "null" ? e.message : "连接超时或进程异常退出";
        alert(`连接 ${id} 失败: ${msg}`);
      } finally {
        useStudioStore.getState().setConnectingId(null);
      }
    },
    [qc, probeAuth, resolveSession]
  );

  const handleCreateSession = useCallback(
    async (settings: SessionSettings) => {
      const st = useStudioStore.getState();
      const agentId = st.activeAgentId;
      st.setBusy(true);
      try {
        const known = agentsRef.current.find((a) => a.id === agentId)?.status?.connected;
        if (!known) await connectAgent(agentId);
        const reqCwd = settings.cwd || st.currentWorkspace || undefined;

        // Auto-cleanup discarded empty draft if leaving one behind
        const prevSid = st.sessionId;
        const prevHasUserMsg = st.messages.some((m) => m.role === "user");
        if (prevSid && !prevHasUserMsg) {
          void sessionRpc(agentId, "delete", { sessionId: prevSid }).catch(() => {});
        }

        const res: any = await sessionNew(agentId, {
          ...(reqCwd ? { cwd: reqCwd } : {}),
          ...(settings.additionalDirectories.length > 0
            ? { additionalDirectories: settings.additionalDirectories }
            : {}),
          mcpServers: settings.mcpServers,
        });
        // Same late-result isolation as ensureSession.
        const after = useStudioStore.getState();
        if (after.activeAgentId !== agentId) {
          if (typeof res?.sessionId === "string" && res.sessionId) {
            void sessionRpc(agentId, "delete", { sessionId: res.sessionId }).catch(() => {});
          }
          return;
        }
        // 先开新线程，再应用新会话的 modes/models/config
        newThread(agentId, reqCwd);
        after.applySessionResult(res, agentId);
        bindThreadSession(
          useStudioStore.getState().sessionId,
          reqCwd,
          settings.mcpServers
        );
        st.setAuthOk(agentId, true);
        st.setSettingsOpen(false);
        invalidateAgents(qc);
        invalidateSessions(qc, agentId);
        if (res?.sessionId) {
          void applyDefaultConfigOptions(agentId, res.sessionId);
        }
      } catch (e: any) {
        if (isAuthRequiredError(e)) {
          st.setAuthOk(agentId, false);
          st.setSettingsOpen(false);
          st.setAuthOpen(true);
        } else {
          alert(`session/new 失败: ${e.message}`);
        }
      } finally {
        useStudioStore.getState().setBusy(false);
      }
    },
    [qc, agentsRef, applyDefaultConfigOptions]
  );

  /** 1-click instant new session (0ms optimistic switch without modal block) */
  const handleDirectNewSession = useCallback(
    (targetCwd?: string) => {
      const st = useStudioStore.getState();
      const agentId = st.activeAgentId;
      // UI event handlers may be wired as `onClick={onNewSession}`; React then
      // passes the click event here. Only a real path may reach the store.
      const cwd = typeof targetCwd === "string" && targetCwd.trim() ? targetCwd : undefined;

      // Auto-cleanup abandoned empty draft if current session has no user messages
      const prevSid = st.sessionId;
      const prevHasUserMsg = st.messages.some((m) => m.role === "user");
      if (prevSid && !prevHasUserMsg) {
        void sessionRpc(agentId, "delete", { sessionId: prevSid }).catch(() => {});
      }

      if (cwd) {
        st.setWorkspace(cwd);
      }
      st.snapshotThread();
      st.newThread(agentId, cwd || st.currentWorkspace);
      st.setStreaming(false);
      st.setBusy(false);
      st.setSessionError(null);
      st.setSessionLoading(false);

      // Prewarm new session in background so first user message doesn't block on session/new
      void (async () => {
        try {
          const known = agentsRef.current.find((a) => a.id === agentId)?.status?.connected;
          if (!known) {
            await connectAgent(agentId);
            invalidateAgents(qc);
          }
          await ensureSession(agentId, true);
        } catch (err) {
          console.warn(`[App] Prewarm new session for ${agentId} failed:`, err);
        }
      })();
    },
    [qc, agentsRef, ensureSession]
  );

  /** Open a session from the sidebar: optimistic 0ms switch + background server sync. */
  const handleOpenSession = useCallback(
    async (item: SessionItem) => {
      const st = useStudioStore.getState();
      // If currently marked streaming or busy, clear it so user isn't stuck
      if (st.isStreaming) {
        st.setStreaming(false);
        st.setBusy(false);
      }
      const agentId = st.activeAgentId;

      // Auto-cleanup abandoned empty draft when switching to another session
      const prevSid = st.sessionId;
      const prevHasUserMsg = st.messages.some((m) => m.role === "user");
      if (prevSid && prevSid !== item.sessionId && !prevHasUserMsg) {
        void sessionRpc(agentId, "delete", { sessionId: prevSid }).catch(() => {});
      }

      // 1. 乐观渲染：0ms 瞬间把会话切换到主视口（本地缓存历史立即可见，无全屏菊花阻塞）
      st.optimisticOpenSession(agentId, item.sessionId, item.title, item.cwd);

      // 2. 后台静默向 Agent 加载最新历史记录与模型配置
      try {
        const known = agentsRef.current.find((a) => a.id === agentId)?.status?.connected;
        if (!known) await connectAgent(agentId);
        try {
          const workspaceCwd = useStudioStore.getState().currentWorkspace || "";
          const effectiveCwd = item.cwd || workspaceCwd;
          const { result, replayed } = await loadSession(agentId, {
            sessionId: item.sessionId,
            cwd: effectiveCwd,
            mcpServers: useStudioStore.getState().threadMcpServers(agentId) ?? [],
          });
          const t = buildTranscriptFromReplay(replayed || []);
          const cur = useStudioStore.getState();

          // 仅当用户仍停留在该会话时才合并（避免快速连续点击会话时的竞态冲突）
          if (cur.sessionId === item.sessionId && cur.activeAgentId === agentId) {
            cur.bindThreadSession(
              item.sessionId,
              effectiveCwd || null,
              cur.threadMcpServers(agentId)
            );
            if (t.sessionTitle || t.sessionGoal !== undefined) {
              cur.setSessionInfo({
                ...(cur.sessionInfo || {}),
                title: t.sessionTitle || item.title || cur.sessionInfo?.title,
                goal: t.sessionGoal !== undefined ? t.sessionGoal : cur.sessionInfo?.goal,
              });
            }
            if (t.messages.length > 0) {
              cur.setMessages(
                t.messages.map((m, i) => ({
                  id: `hist-${Date.now()}-${i}`,
                  role: m.role,
                  content: m.content,
                  thought: m.thought,
                  toolCalls: m.toolCalls,
                  images: m.images,
                  contentBlocks: m.contentBlocks,
                  artifacts: m.artifacts,
                  timestamp: now(),
                }))
              );
            } else if (cur.messages.length === 0) {
              cur.appendMessage({
                id: `sys-${Date.now()}-empty`,
                role: "system",
                content: `会话 ${item.sessionId.slice(0, 8)}… 无可回放的历史（空会话或记录已被清理），已绑定，可直接继续对话。`,
                timestamp: now(),
              });
            }
            if (t.plan.length > 0) {
              const msgs = useStudioStore.getState().messages;
              const lastAsst = [...msgs].reverse().find((m) => m.role === "assistant");
              if (lastAsst) {
                useStudioStore.getState().patchMessage(lastAsst.id, { plan: t.plan });
              }
            }
            if (t.configOptions) useStudioStore.getState().setConfigOptions(t.configOptions);
            if (t.usage) useStudioStore.getState().setUsage(t.usage);
            {
              const fromRes = (result as any)?.availableCommands;
              const cmds = t.availableCommands.length > 0 ? t.availableCommands : Array.isArray(fromRes) ? fromRes : null;
              if (cmds) useStudioStore.getState().setAvailableCommands(cmds, item.sessionId);
            }
            if (t.currentModeId) {
              const modes = useStudioStore.getState().modes;
              if (modes) {
                useStudioStore.getState().setModes({ ...modes, currentModeId: t.currentModeId! });
              }
            }
            if (appendActivity) {
              for (const a of t.activities) appendActivity(a);
            }
            const r: any = result || {};
            if (r.modes) cur.setModes(r.modes);
            if (r.models) cur.setModels(r.models);
            if (r.configOptions) cur.setConfigOptions(r.configOptions);
            cur.setAuthOk(agentId, true);

            // 打开历史会话：把该会话的当前配置记为该 agent 的上次配置
            try {
              const sSnap = useStudioStore.getState();
              const cfg: Record<string, unknown> = {};
              for (const o of sSnap.configOptions || []) {
                if (o?.id == null) continue;
                cfg[o.id] = (o.currentValue as any)?.value ?? o.currentValue;
              }
              sSnap.saveAgentPref(agentId, {
                ...(Object.keys(cfg).length > 0 ? { configValues: cfg } : {}),
                ...(sSnap.models?.currentModelId
                  ? { fallbackModelId: sSnap.models.currentModelId }
                  : {}),
                ...(sSnap.modes?.currentModeId ? { modeId: sSnap.modes.currentModeId } : {}),
              });
            } catch {
              // ignore
            }
          }
        } catch (loadErr) {
          // Fall back to resume (no replay) when load is unsupported/fails.
          const workspaceCwd = useStudioStore.getState().currentWorkspace || "";
          const effectiveCwd = item.cwd || workspaceCwd;
          try {
            const resumeRes: any = await sessionRpc(agentId, "resume", {
              sessionId: item.sessionId,
              cwd: effectiveCwd,
              mcpServers: useStudioStore.getState().threadMcpServers(agentId) ?? [],
            });
            const cur = useStudioStore.getState();
            if (cur.sessionId === item.sessionId && cur.activeAgentId === agentId) {
              cur.bindThreadSession(
                item.sessionId,
                effectiveCwd || null,
                cur.threadMcpServers(agentId)
              );
              if (resumeRes?.modes) cur.setModes(resumeRes.modes);
              if (resumeRes?.models) cur.setModels(resumeRes.models);
              if (resumeRes?.configOptions) cur.setConfigOptions(resumeRes.configOptions);
              if (Array.isArray(resumeRes?.availableCommands)) cur.setAvailableCommands(resumeRes.availableCommands, item.sessionId);
              if (cur.messages.length === 0) {
                cur.setMessages([
                  {
                    id: `sys-${Date.now()}`,
                    role: "system",
                    content: `已 resume 会话（无历史回放）。`,
                    timestamp: now(),
                  },
                ]);
              }
            }
          } catch (resumeErr) {
            const cur = useStudioStore.getState();
            if (cur.sessionId !== item.sessionId || cur.activeAgentId !== agentId) return;
            // The id itself is invalid/expired on the agent side. Binding it
            // bare would resurrect a dead id and every later prompt would fail.
            if (isSessionGoneError(loadErr) || isSessionGoneError(resumeErr)) {
              cur.markThreadStale();
              const sidPrefix = item.sessionId.slice(0, 8);
              const alreadyNotified = cur.messages.some(
                (m) => m.role === "system" && m.content.includes(sidPrefix)
              );
              if (!alreadyNotified) {
                cur.appendMessage({
                  id: `sys-${Date.now()}-gone`,
                  role: "system",
                  content: `会话 (${sidPrefix}…) 在 Agent 端已失效或已过期（当前为历史记录视图）。点击上方「+ 新会话」可开启独立新会话。`,
                  timestamp: now(),
                });
              }
              invalidateSessions(qc, agentId);
              return;
            }
            // Some agents reject load/resume while session/prompt on the same
            // id still works — attach bare instead of hitting a dead end.
            cur.bindThreadSession(
              item.sessionId,
              effectiveCwd || null,
              cur.threadMcpServers(agentId)
            );
            if (cur.messages.length === 0) {
              cur.setMessages([
                {
                  id: `sys-${Date.now()}`,
                  role: "system",
                  content: `已切换到会话（该 Agent 未提供历史回放，直接继续对话即可）。`,
                  timestamp: now(),
                },
              ]);
            }
          }
        }
        invalidateSessions(qc, agentId);
      } catch (e: any) {
        alert(`打开会话失败: ${e.message}`);
      } finally {
        useStudioStore.getState().setSessionLoading(false);
      }
    },
    [qc, agentsRef, appendActivity, now]
  );

  const handleForkSession = useCallback(
    async (sid?: string) => {
      const st = useStudioStore.getState();
      const source = sid || st.sessionId;
      if (!source || st.isStreaming) return;
      const agentId = st.activeAgentId;
      st.setBusy(true);
      try {
        const res: any = await forkSession(agentId, {
          sessionId: source,
          ...(st.currentWorkspace ? { cwd: st.currentWorkspace } : {}),
        });
        const cur = useStudioStore.getState();
        if (cur.activeAgentId !== agentId) {
          if (typeof res?.sessionId === "string" && res.sessionId) {
            void sessionRpc(agentId, "delete", { sessionId: res.sessionId }).catch(() => {});
          }
          return;
        }
        cur.newThread(agentId);
        cur.applySessionResult(res, agentId);
        cur.bindThreadSession(
          useStudioStore.getState().sessionId,
          st.currentWorkspace || null,
          cur.threadMcpServers(agentId)
        );
        cur.setMessages([
          {
            id: `sys-${Date.now()}`,
            role: "system",
            content: `已从 ${source.slice(0, 8)}… fork 出新会话。`,
            timestamp: now(),
          },
        ]);
        invalidateSessions(qc, agentId);
      } catch (e: any) {
        alert(`fork 失败: ${e.message}`);
      } finally {
        useStudioStore.getState().setBusy(false);
      }
    },
    [qc, now]
  );

  const handleDeleteSession = useCallback(
    async (item: SessionItem) => {
      if (!confirm(`删除会话 ${item.title || item.sessionId}？`)) return;
      const st = useStudioStore.getState();
      const agentId = st.activeAgentId;
      try {
        await sessionRpc(agentId, "delete", { sessionId: item.sessionId });
        const cur = useStudioStore.getState();
        if (item.sessionId === cur.sessionId) {
          cur.setSessionId(null);
          cur.bindThreadSession(null);
          cur.resetThread();
        }
        invalidateSessions(qc, agentId);
      } catch (e: any) {
        // Some agents reject delete — fall back to close (frees active resources).
        try {
          await sessionRpc(agentId, "close", { sessionId: item.sessionId });
          const cur = useStudioStore.getState();
          if (item.sessionId === cur.sessionId) {
            cur.setSessionId(null);
            cur.bindThreadSession(null);
            cur.resetThread();
          }
          cur.appendMessage({
            id: `sys-${Date.now()}`,
            role: "system",
            content: `该 Agent 不支持 delete，已改用 close。`,
            timestamp: now(),
          });
          invalidateSessions(qc, agentId);
        } catch {
          alert(`删除失败: ${(e as Error).message}`);
        }
      }
    },
    [qc, now]
  );

  /** One-click cleanup of abandoned empty sessions (visible counts, never silent). */
  const handleCleanupEmpty = useCallback(async () => {
    const agentId = useStudioStore.getState().activeAgentId;
    const st = useStudioStore.getState();
    // Live-bound session ids must never be touched.
    const bound = new Set<string>();
    if (st.sessionId) bound.add(st.sessionId);
    for (const t of Object.values(st.threads)) {
      if (t.agentId === agentId && t.sessionId) bound.add(t.sessionId);
    }
    if (
      !confirm(
        `清理「${agentId}」下无对话记录的零会话？\n（将跳过 ${bound.size} 个正在使用或本地有记录的会话，逐个删除，失败逐条报告）`
      )
    )
      return;
    setCleaningEmpty(true);
    try {
      const res = await cleanupEmptySessions(agentId, [...bound]);
      alert(
        `清理完成：已删 ${res.deleted.length} 个。${
          res.errors.length
            ? `失败 ${res.errors.length} 个，首错：${res.errors[0].error}`
            : "无失败。"
        }`
      );
      invalidateSessions(qc, agentId);
    } catch (e: any) {
      alert(`清理失败: ${e?.message || e}`);
    } finally {
      setCleaningEmpty(false);
    }
  }, [qc]);

  return {
    probeAuth,
    ensureSession,
    restoreAgentSession,
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
  };
}
