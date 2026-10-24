import { useCallback, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { activeKey, sessionOf, useStudioStore } from "@/stores/useStudioStore";
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
import { resumeTurnIfNeeded } from "./useTurnRecovery";
import { discardEmptyDraft, historyMessages, sessionGoneNotice } from "./session-helpers";
import type { SessionItem } from "@/components/universal/Sidebar";
import type { SessionSettings } from "@/components/universal/SessionSettingsModal";

const { setActiveAgentId, restoreThread, newThread, snapshotThread, bindThreadSession } = useStudioStore.getState();

export interface UseSessionActionsOptions {
  qc: QueryClient;
  agentsRef: React.RefObject<AgentSummary[]>;
  applyDefaultConfigOptions: (agentId: string, sessionId: string) => Promise<void>;
  appendActivity?: (a: ActivityEvent) => void;
  now: () => string;
  probeAuth: (agentId: string) => Promise<void>;
  ensureSession: (agentId?: string, force?: boolean) => Promise<string | null>;
  resolveSession: (agentId: string) => Promise<string | null>;
}

/**
 * What the user does with sessions and agents: switch agent, connect, create,
 * open (optimistic 0ms switch + background sync, guarded against stale
 * results), fork, delete, and clean up empty sessions (bound ones are never
 * touched).
 */
export function useSessionActions({
  qc,
  agentsRef,
  applyDefaultConfigOptions,
  appendActivity,
  now,
  probeAuth,
  ensureSession,
  resolveSession,
}: UseSessionActionsOptions) {
  const [cleaningEmpty, setCleaningEmpty] = useState(false);

  // 切换运行时：会话与运行时是一对一绑定的，所以换运行时 = 打开那个运行时 +
  // 新建一个会话；已经在跑的会话不受影响（那边继续跑，回来还能挂上）。
  const handleSelectAgent = useCallback(
    (id: string) => {
      const st = useStudioStore.getState();
      if (id === st.activeAgentId) return;
      // 不断开事件流：那只是"本页不再看"，切断它会让前端误判空闲（再发消息
      // 就会被 agent 回 409 session busy），切回来也接不上。流的生命周期只跟
      // 这一轮本身走，跟切换无关。
      snapshotThread();
      setActiveAgentId(id);
      // 新运行时自己的会话：能接上它的旧会话就接上，否则开一个新的。
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
    [qc, agentsRef, resolveSession]
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
        discardEmptyDraft(agentId, st);

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
      discardEmptyDraft(agentId, st);

      if (cwd) {
        st.setWorkspace(cwd);
      }
      st.snapshotThread();
      st.newThread(agentId, cwd || st.currentWorkspace);
      // 不清运行状态：新建会话不等于那一轮结束。智能体那边继续跑，切回来
      // 还能挂上（/follow 按 seq 续读）。"本会话在不在忙"按会话判断。
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
      const prevAgentId = st.activeAgentId;
      // 会话绑定运行时：点别的运行时的会话，先切到那个运行时再打开。
      if (item.agentId && item.agentId !== prevAgentId) {
        // 不 abort 前台这条流：它还在往原会话里写，切断就会变成"假空闲"。
        snapshotThread();
        setActiveAgentId(item.agentId);
        if (!restoreThread(item.agentId)) newThread(item.agentId);
      }
      // 不清运行状态：切走不等于那一轮结束。智能体那边继续跑，前端只是
      // 不再盯着它；回到这个会话时会重新挂上（/follow 按 seq 续读）。
      const agentId = item.agentId || prevAgentId;

      // Auto-cleanup abandoned empty draft when switching to another session
      discardEmptyDraft(prevAgentId, st, item.sessionId);

      // 1. 乐观渲染：0ms 瞬间把会话切换到主视口（本地缓存历史立即可见，无全屏菊花阻塞）
      st.optimisticOpenSession(agentId, item.sessionId, item.title, item.cwd);
      const openedKey = activeKey(useStudioStore.getState());

      // 1b. 这个会话在后台还在跑？把那一轮重新挂上（按 lastSeq 续读）。
      // 切 agent 时前端会断开事件流，但 agent 那边继续跑——没有这一步，
      // 切回来看到的就停在断开那一刻。
      resumeTurnIfNeeded();

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
                ...(sessionOf(cur).sessionInfo || {}),
                title: t.sessionTitle || item.title || sessionOf(cur).sessionInfo?.title,
                goal: t.sessionGoal !== undefined ? t.sessionGoal : sessionOf(cur).sessionInfo?.goal,
              });
            }
            if (t.messages.length > 0) {
              // 本地已经有这个会话的消息：保留它们（对象/ id 都是原来的，卡片、
              // 展开状态、交互都不会重挂）。回放是重建出来的静态记录——用户消息
              // 带的是注入后的完整提示词、id 也全不一样，覆盖会把实时视图换掉。
              if (sessionOf(cur).messages.length === 0) {
                cur.setMessages(historyMessages(t.messages, now));
              }
            } else if (sessionOf(cur).messages.length === 0) {
              cur.appendMessage({
                id: `sys-${Date.now()}-empty`,
                role: "system",
                content: `会话 ${item.sessionId.slice(0, 8)}… 无可回放的历史（空会话或记录已被清理），已绑定，可直接继续对话。`,
                timestamp: now(),
              });
            }
            if (t.plan.length > 0) {
              const msgs = sessionOf(useStudioStore.getState()).messages;
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
              const modes = sessionOf(useStudioStore.getState()).modes;
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
                ...(sessionOf(sSnap).modes?.currentModeId ? { modeId: sessionOf(sSnap).modes!.currentModeId } : {}),
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
              if (sessionOf(cur).messages.length === 0) {
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
              const alreadyNotified = sessionOf(cur).messages.some(
                (m) => m.role === "system" && m.content.includes(sidPrefix)
              );
              if (!alreadyNotified) {
                cur.appendMessage(sessionGoneNotice(sidPrefix, now));
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
            if (sessionOf(cur).messages.length === 0) {
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
        useStudioStore.getState().setSessionLoading(false, openedKey);
      }
    },
    [qc, agentsRef, appendActivity, now]
  );

  const handleForkSession = useCallback(
    async (sid?: string) => {
      const st = useStudioStore.getState();
      const source = sid || st.sessionId;
      if (!source || sessionOf(st).running) return;
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
