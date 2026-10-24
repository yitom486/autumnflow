import { useCallback, useEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { activeKey, sessionOf, useStudioStore } from "@/stores/useStudioStore";
import { invalidateAgents, invalidateSessions } from "@/lib/acp-queries";
import {
  connectAgent,
  sessionNew,
  sessionRpc,
  loadSession,
  buildTranscriptFromReplay,
  isAuthRequiredError,
  isSessionGoneError,
  type AgentSummary,
} from "@/lib/universal-api";
import { isSameCwd } from "@/lib/threads";
import { discardEmptyDraft, historyMessages, sessionGoneNotice } from "./session-helpers";

const { newThread, bindThreadSession, markThreadStale } = useStudioStore.getState();

export interface UseSessionResolutionOptions {
  qc: QueryClient;
  agents: AgentSummary[];
  agentsRef: React.RefObject<AgentSummary[]>;
  applyDefaultConfigOptions: (agentId: string, sessionId: string) => Promise<void>;
  now: () => string;
}

/**
 * Which ACP session the view is on, and getting one when it has none.
 *
 * Single session-resolution policy (stability invariant): UI history ⟺
 * session binding. A bound session is resumed first so model-side context
 * continues; a new one is created only when nothing is bound or the resume
 * says the session is gone. Boot probes run once per agent (StrictMode-safe
 * via ensuredRef).
 */
export function useSessionResolution({
  qc,
  agents,
  agentsRef,
  applyDefaultConfigOptions,
  now,
}: UseSessionResolutionOptions) {
  const ensuredRef = useRef<string | null>(null);
  /** In-flight session creations, keyed by agent id; see ensureSession. */
  const ensureInFlight = useRef(new Map<string, Promise<string | null>>());
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
      // The session asking for it; a fresh thread opened below is the view's.
      const askingKey = activeKey(st);
      st.setSessionLoading(true, askingKey);
      try {
        const known = agentsRef.current.find((a) => a.id === agentId)?.status?.connected;
        if (!known) await connectAgent(agentId);
        const reqCwd = st.currentWorkspace || undefined;
        // Auto-created sessions inherit the agent thread's MCP servers and its
        // session-level code mode.
        const autoServers = st.threadMcpServers(agentId);
        const codeMode = st.activeThreadId ? st.threads[st.activeThreadId]?.codeMode === true : false;

        const prevHasUserMsg = sessionOf(st).messages.some((m) => m.role === "user");
        // Whether the view had content has to be judged when the session is
        // REQUESTED. Judging it when the response arrives would let a message
        // that the user sent while session/new was in flight switch the thread
        // and disappear from the chat.
        const prevHadMessages = sessionOf(st).messages.length > 0;
        discardEmptyDraft(agentId, st);

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
        useStudioStore.getState().setSessionLoading(false, askingKey);
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
      if (!force && (sessionOf(st).running || st.busy)) return null;
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
        // 本地已经有这个会话的消息：那是它自己的全量状态（含工具调用、卡片、
        // 流式输出）。回放是重建出来的静态记录，覆盖会把实时视图换成死快照。
        if (sessionOf(cur).messages.length > 0) return;
        cur.setMessages(historyMessages(transcript.messages, now));
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
      if (!sid || sessionOf(st).running) return { resumed: false };
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
          sessionOf(st).messages.some(
            (m) => m.role === "system" && m.content.includes(sidPrefix)
          );
        if (thread.messages.some((m) => m.role === "user") && !alreadyNotified) {
          st.appendMessage(sessionGoneNotice(sidPrefix, now));
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
      if (sessionOf(cur0).running) return cur0.sessionId;
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

  return { probeAuth, ensureSession, restoreAgentSession, resolveSession };
}
