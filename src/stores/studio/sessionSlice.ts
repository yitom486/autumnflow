import type { StateCreator } from "zustand";
import type { Message } from "@/lib/message-types";
import type { Attachment } from "@/lib/universal-api";
import {
  findThreadBySessionId,
  loadThreads,
  mergeAssistantTurns,
  newThreadId,
  saveThreads,
  threadForAgent,
  titleForThread,
  type ActiveTurn,
  type ChatThread,
  type QueuedPrompt,
} from "@/lib/threads";
import {
  activeKey,
  cmdsFor,
  DRAFT_KEY,
  emptySession,
  ensureSessionIn,
  patchSessionIn,
  pruneLive,
  sessionOf,
} from "./session-state";
import { readCachedCatalog } from "./persistence";
import type { ModeState, SessionInfo, SessionKey, SessionState, SessionUi, StudioState, UsageState } from "./types";

/** Every session's live state (`sessions`), the view pointer (`activeThreadId`) and the persisted thread records. */
export interface SessionSlice {
  // persisted chat threads, keyed by thread id (per-agent isolation enforced
  // by threads.ts lookups; live view stays in messages/sessionId)
  threads: Record<string, ChatThread>;
  activeThreadId: string | null;
  /** 每个会话一格，键是线程 id；没有线程的草稿视图用 ""。 */
  sessions: Record<SessionKey, SessionState>;
  /**
   * 一个会话换了 ACP sessionId（服务端把失效的会话接到新会话上）：记到它自己的
   * 线程里；是当前会话才同步到视图。
   */
  setThreadSessionId: (key: SessionKey, sessionId: string) => void;
  setSessionError: (e: string | null, key?: SessionKey | null) => void;
  setSessionLoading: (v: boolean, key?: SessionKey | null) => void;
  setModes: (m: ModeState | null, key?: SessionKey | null) => void;
  setUsage: (u: UsageState | null, key?: SessionKey | null) => void;
  setSessionInfo: (info: SessionInfo | null, key?: SessionKey | null) => void;
  setMessages: (m: Message[], key?: SessionKey | null) => void;
  appendMessage: (m: Message, key?: SessionKey | null) => void;
  patchMessage: (id: string, patch: Partial<Message> | ((m: Message) => Message), key?: SessionKey | null) => void;
  /** Queue a prompt typed while the agent is still working. */
  enqueuePrompt: (text: string, key?: SessionKey | null) => string;
  /** Withdraw a queued prompt before it is sent. */
  removeQueuedPrompt: (id: string, key?: SessionKey | null) => void;
  /** Drop every queued prompt (the user stopped the run). */
  clearQueuedPrompts: (key?: SessionKey | null) => void;
  setActiveTurn: (turn: ActiveTurn | null, key?: SessionKey | null) => void;
  patchActiveTurn: (patch: Partial<ActiveTurn>, key?: SessionKey | null) => void;
  setDraft: (text: string, key?: SessionKey | null) => void;
  setAttachments: (a: Attachment[], key?: SessionKey | null) => void;
  /** 标记某个会话在跑/跑完：会话之间互不影响。 */
  setSessionRunning: (key: SessionKey, running: boolean) => void;
  /** 记下一张卡片/折叠区的展开状态。 */
  setUiOpen: (key: SessionKey, id: string, open: boolean) => void;
  /** 记下一段文本已经揭示到的长度（打字机重挂时从这里接着打）。 */
  setRevealed: (key: SessionKey, id: string, length: number) => void;
  /** 记下切走时的滚动位置。 */
  setScroll: (key: SessionKey, scroll: SessionUi["scroll"]) => void;
  /** Clear the current session's state (its thread record is untouched). */
  resetThread: () => void;
  /**
   * Persist a session into its thread record (defaults to the current one).
   * The current view without a thread gets one allocated here.
   */
  snapshotThread: (key?: SessionKey | null) => void;
  /** Restore an agent's latest thread into the live view (instant, no network), optionally scoped to a workspace cwd. */
  restoreThread: (agentId: string, targetCwd?: string | null) => ChatThread | null;
  /** Start a fresh empty thread for an agent, optionally scoped to a workspace cwd. */
  newThread: (agentId: string, targetCwd?: string | null) => ChatThread;
  /** MCP servers carried by an agent's live/latest thread (auto new/resume). */
  threadMcpServers: (agentId: string) => unknown[] | undefined;
  /** Bind an ACP sessionId to the live thread (same agent only). */
  bindThreadSession: (sessionId: string | null, cwd?: string | null, mcpServers?: unknown[]) => void;
  /** Mark the live thread stale after a failed resume (visible degrade). */
  markThreadStale: () => void;
  /** Session-level code mode (PTC): applies when this thread's session is created or resumed. */
  setThreadCodeMode: (enabled: boolean) => void;
  /** Optimistic switch to a session: instant UI mount from local thread cache without blocking spinners. */
  optimisticOpenSession: (
    agentId: string,
    sessionId: string,
    title?: string | null,
    cwd?: string | null
  ) => ChatThread;
}

export const createSessionSlice: StateCreator<StudioState, [], [], SessionSlice> = (set, get) => ({
  threads: loadThreads(),
  activeThreadId: null,
  sessions: {} as Record<SessionKey, SessionState>,
  setThreadSessionId: (key, sessionId) => {
    if (key === activeKey(get())) {
      get().setSessionId(sessionId);
      return;
    }
    set((s) => {
      const t = s.threads[key];
      if (!t || t.sessionId === sessionId) return {};
      return { threads: { ...s.threads, [key]: { ...t, sessionId, stale: false } } };
    });
  },
  setSessionError: (e, key) => set((s) => patchSessionIn(s, key, { sessionError: e })),
  setSessionLoading: (v, key) => set((s) => patchSessionIn(s, key, { sessionLoading: v })),
  setModes: (m, key) => set((s) => patchSessionIn(s, key, { modes: m })),
  setUsage: (u, key) => set((s) => patchSessionIn(s, key, { usage: u })),
  setSessionInfo: (info, key) => set((s) => patchSessionIn(s, key, { sessionInfo: info })),
  setMessages: (m, key) => set((s) => patchSessionIn(s, key, { messages: mergeAssistantTurns(m) })),
  appendMessage: (m, key) =>
    set((s) => patchSessionIn(s, key, (b) => ({ messages: mergeAssistantTurns([...b.messages, m]) }))),
  patchMessage: (id, patch, key) =>
    set((s) =>
      patchSessionIn(s, key, (b) => ({
        messages: b.messages.map((m) =>
          m.id === id ? (typeof patch === "function" ? patch(m) : { ...m, ...patch }) : m
        ),
      }))
    ),
  enqueuePrompt: (text, key) => {
    const item: QueuedPrompt = { id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, text, createdAt: Date.now() };
    // 排队是会话内的事：挂在所属会话上，别让 A 会话的队列跑到 B 会话去。
    set((s) => patchSessionIn(s, key, (b) => ({ queuedPrompts: [...b.queuedPrompts, item] })));
    return item.id;
  },
  removeQueuedPrompt: (id, key) =>
    set((s) => patchSessionIn(s, key, (b) => ({ queuedPrompts: b.queuedPrompts.filter((item) => item.id !== id) }))),
  clearQueuedPrompts: (key) => set((s) => patchSessionIn(s, key, { queuedPrompts: [] })),
  setActiveTurn: (turn, key) => set((s) => patchSessionIn(s, key, { activeTurn: turn })),
  patchActiveTurn: (patch, key) =>
    set((s) => patchSessionIn(s, key, (b) => ({ activeTurn: b.activeTurn ? { ...b.activeTurn, ...patch } : null }))),
  setDraft: (text, key) => set((s) => (sessionOf(s, key).draft === text ? s : patchSessionIn(s, key, { draft: text }))),
  setAttachments: (a, key) => set((s) => patchSessionIn(s, key, { attachments: a })),
  setSessionRunning: (key, running) =>
    set((s) => (sessionOf(s, key).running === running ? s : patchSessionIn(s, key, { running }))),
  setUiOpen: (key, id, open) =>
    set((s) => patchSessionIn(s, key, (b) => ({ ui: { ...b.ui, open: { ...b.ui.open, [id]: open } } }))),
  setRevealed: (key, id, length) =>
    set((s) =>
      sessionOf(s, key).ui.revealed[id] === length
        ? s
        : patchSessionIn(s, key, (b) => ({ ui: { ...b.ui, revealed: { ...b.ui.revealed, [id]: length } } }))
    ),
  setScroll: (key, scroll) => set((s) => patchSessionIn(s, key, (b) => ({ ui: { ...b.ui, scroll } }))),
  resetThread: () =>
    set((s) => ({
      models: null,
      configOptions: null,
      availableCommands: [],
      quota: null,
      sessions: { ...s.sessions, [activeKey(s)]: emptySession() },
    })),
  snapshotThread: (key) =>
    set((s) => {
      const isView = key == null || key === activeKey(s);
      // 后台的会话：只有已经有线程记录的才落盘（它的元数据都在记录上）。
      if (!isView && !s.threads[key!]) return {};
      const id = isView ? s.activeThreadId ?? newThreadId() : key!;
      const live = sessionOf(s, isView ? activeKey(s) : key);
      const prev = s.threads[id];
      const thread: ChatThread = {
        ...prev,
        id,
        // The view's thread belongs to the active agent; a background one
        // keeps the agent/session/cwd it was recorded with.
        agentId: isView ? s.activeAgentId : prev!.agentId,
        // Keep the user-facing name on the persisted record so the sidebar can
        // show content instead of an opaque session id.
        title: titleForThread({ title: prev?.title, messages: live.messages }),
        // Keep the historical id, and keep the stale marker so the next boot
        // does not try to resume the same dead id all over again.
        sessionId: isView ? s.sessionId ?? (prev?.stale ? prev.sessionId : null) : prev!.sessionId,
        stale: prev?.stale ? true : undefined,
        cwd: isView ? s.currentWorkspace ?? prev?.cwd ?? null : prev!.cwd,
        messages: live.messages,
        activeTurn: live.activeTurn ? { ...live.activeTurn, persistedSeq: live.activeTurn.lastSeq } : undefined,
        queuedPrompts: live.queuedPrompts,
        // Preserve the thread's MCP servers across snapshots (auto new/resume).
        mcpServers: prev?.mcpServers,
        updatedAt: Date.now(),
      };
      const next = pruneLive(s, { ...s.threads, [id]: thread }, [id]);
      saveThreads(next);
      // 草稿视图第一次落盘：它的格子搬到新线程名下，指针跟过去。
      if (isView && !s.activeThreadId) {
        const { [DRAFT_KEY]: draft, ...rest } = s.sessions;
        return { threads: next, activeThreadId: id, sessions: { ...rest, [id]: draft ?? emptySession() } };
      }
      return { threads: next };
    }),
  restoreThread: (agentId, targetCwd) => {
    const s = get();
    const cwd = targetCwd !== undefined ? targetCwd : s.currentWorkspace;
    const t = threadForAgent(s.threads, agentId, cwd);
    if (!t) return null;
    const cached = readCachedCatalog(agentId);
    // A stale thread is a read-only historical transcript: showing its dead
    // id as the live session is what made resume/ensureSession loop forever.
    const sid = t.stale ? null : t.sessionId;
    set({
      models: cached?.models ?? null,
      configOptions: cached?.configOptions ?? null,
      sessionId: sid,
      availableCommands: cmdsFor(s, agentId, sid),
      activeThreadId: t.id,
      sessions: ensureSessionIn(s, t.id),
    });
    return t;
  },
  newThread: (agentId, targetCwd) => {
    const s0 = get();
    const cwd = targetCwd !== undefined ? targetCwd : s0.currentWorkspace;
    // Continuity: a fresh thread inherits the agent's latest MCP servers so
    // auto-created sessions keep working tools until the user changes them.
    const inherited = threadForAgent(s0.threads, agentId, cwd)?.mcpServers;
    const liveThread = s0.activeThreadId ? s0.threads[s0.activeThreadId] : undefined;
    const inheritedCodeMode =
      liveThread && liveThread.agentId === agentId
        ? liveThread.codeMode
        : threadForAgent(s0.threads, agentId, cwd)?.codeMode;
    const t: ChatThread = {
      id: newThreadId(),
      agentId,
      sessionId: null,
      cwd,
      messages: [],
      mcpServers: inherited,
      ...(inheritedCodeMode !== undefined ? { codeMode: inheritedCodeMode } : {}),
      updatedAt: Date.now(),
    };
    const next = pruneLive(s0, { ...s0.threads, [t.id]: t }, [t.id]);
    saveThreads(next);
    const cached = readCachedCatalog(agentId);
    set((s) => ({
      models: cached?.models ?? null,
      configOptions: cached?.configOptions ?? null,
      availableCommands: [],
      sessionId: null,
      threads: next,
      activeThreadId: t.id,
      sessions: { ...s.sessions, [t.id]: emptySession() },
    }));
    return t;
  },
  threadMcpServers: (agentId) => {
    // NOTE: use the creator `get()` here, never useStudioStore.getState() —
    // self-referencing the store under construction degrades downstream type
    // inference (st.threads collapses to unknown in consumers).
    const s = get();
    const live = s.activeThreadId ? s.threads[s.activeThreadId] : undefined;
    const mine = live && live.agentId === agentId ? live : threadForAgent(s.threads, agentId);
    return mine?.mcpServers;
  },
  bindThreadSession: (sessionId, cwd, mcpServers) =>
    set((s) => {
      if (!s.activeThreadId) return { sessionId };
      const cur = s.threads[s.activeThreadId];
      // Isolation: only bind when the live thread belongs to the active agent.
      if (!cur || cur.agentId !== s.activeAgentId) return { sessionId };
      const next = {
        ...cur,
        sessionId,
        title: titleForThread({ title: cur.title, messages: sessionOf(s).messages.length ? sessionOf(s).messages : cur.messages }),
        cwd: cwd !== undefined ? cwd : cur.cwd,
        mcpServers: mcpServers !== undefined ? mcpServers : cur.mcpServers,
        stale: false,
        updatedAt: Date.now(),
      };
      const threads = pruneLive(s, { ...s.threads, [next.id]: next }, [next.id]);
      saveThreads(threads);
      return { sessionId, threads };
    }),
  markThreadStale: () =>
    set((s) => {
      if (!s.activeThreadId) return {};
      const cur = s.threads[s.activeThreadId];
      if (!cur) return {};
      const next = { ...cur, stale: true, updatedAt: Date.now() };
      const threads = pruneLive(s, { ...s.threads, [next.id]: next }, [next.id]);
      saveThreads(threads);
      // The id remains on the historical thread record for display, but it is
      // no longer a live session: leaving it in `sessionId` made ensureSession
      // return the dead id forever (the "点击加载模型" button did nothing).
      return { threads, sessionId: null };
    }),
  setThreadCodeMode: (enabled) =>
    set((s) => {
      if (!s.activeThreadId) return {};
      const cur = s.threads[s.activeThreadId];
      if (!cur) return {};
      const next = { ...cur, codeMode: enabled, updatedAt: Date.now() };
      const threads = pruneLive(s, { ...s.threads, [next.id]: next }, [next.id]);
      saveThreads(threads);
      return { threads };
    }),
  optimisticOpenSession: (agentId, sessionId, title, cwd) => {
    // 1. Persist the session we are leaving (its live state stays in memory).
    get().snapshotThread();
    const st = get();

    // 2. Known session: point the view at it. Its own state — a turn still
    //    running in the background included — is exactly what shows up.
    const existing = findThreadBySessionId(st.threads, agentId, sessionId);
    if (existing) {
      set((s) => {
        const sessions = ensureSessionIn(s, existing.id);
        const b = sessions[existing.id];
        return {
          sessionId,
          availableCommands: cmdsFor(s, agentId, sessionId),
          activeThreadId: existing.id,
          sessions: {
            ...sessions,
            [existing.id]: {
              ...b,
              sessionInfo: { ...(b.sessionInfo || {}), title: titleForThread(existing) || title || b.sessionInfo?.title },
              sessionError: null,
              sessionLoading: true, // indicates background sync
            },
          },
        };
      });
      return existing;
    }

    // 3. Not yet in local cache: create optimistic thread instantly (0ms)
    const newId = newThreadId();
    const inheritedMcp = threadForAgent(st.threads, agentId)?.mcpServers;
    const optimisticThread: ChatThread = {
      id: newId,
      agentId,
      sessionId,
      cwd: cwd || st.currentWorkspace,
      mcpServers: inheritedMcp,
      title: title || null,
      messages: [],
      updatedAt: Date.now(),
    };
    const nextThreads = pruneLive(st, { ...st.threads, [newId]: optimisticThread }, [newId]);
    saveThreads(nextThreads);
    set((s) => ({
      sessionId,
      availableCommands: cmdsFor(s, agentId, sessionId),
      activeThreadId: newId,
      threads: nextThreads,
      sessions: {
        ...s.sessions,
        [newId]: { ...emptySession(), sessionInfo: title ? { title } : null, sessionLoading: true },
      },
    }));
    return optimisticThread;
  },
});
