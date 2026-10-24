import type { SlashCommand } from "@/lib/slash-commands";
import { mergeAssistantTurns, pruneThreads, titleForThread, type ChatThread } from "@/lib/threads";
import type { SessionKey, SessionState, StudioState } from "./types";

/* Pure helpers over the per-session slots; every slice uses them. */

export const cmdKey = (agentId: string | null | undefined, sid: string) => `${agentId || ""}:${sid}`;
export function cmdsFor(s: { commandsBySession: Record<string, SlashCommand[]> }, agentId: string | null | undefined, sid: string | null | undefined): SlashCommand[] {
  return sid ? s.commandsBySession[cmdKey(agentId, sid)] ?? [] : [];
}

/** 没有线程的草稿视图（刚切到一个还没开会话的运行时/工作区）。 */
export const DRAFT_KEY: SessionKey = "";

export function emptySession(): SessionState {
  return {
    messages: [],
    activeTurn: null,
    queuedPrompts: [],
    draft: "",
    attachments: [],
    running: false,
    usage: null,
    sessionInfo: null,
    modes: null,
    sessionError: null,
    sessionLoading: false,
    ui: { open: {}, revealed: {}, scroll: null },
  };
}

/** 读不到的会话一律读这一份（固定引用，selector 不会因此每次都变）。 */
export const EMPTY_SESSION: SessionState = emptySession();

/** 当前在看的会话的键。 */
export const activeKey = (s: { activeThreadId: string | null }): SessionKey => s.activeThreadId ?? DRAFT_KEY;

/** 某个会话的状态（默认当前在看的那个）。 */
export function sessionOf(
  s: { sessions: Record<SessionKey, SessionState>; activeThreadId: string | null },
  key?: SessionKey | null
): SessionState {
  return s.sessions[key ?? activeKey(s)] ?? EMPTY_SESSION;
}

/** 从持久化的线程记录铺出一个会话（第一次打开它时）。 */
export function sessionFromThread(t: ChatThread | undefined): SessionState {
  const b = emptySession();
  if (!t) return b;
  const title = titleForThread(t);
  return {
    ...b,
    messages: mergeAssistantTurns(t.messages),
    activeTurn: t.activeTurn ?? null,
    queuedPrompts: t.queuedPrompts ?? [],
    sessionInfo: title ? { title } : null,
  };
}

export type SessionsSlice = Pick<StudioState, "sessions" | "threads" | "activeThreadId">;

/** 改一个会话的格子（不管它是不是当前在看的）。 */
export function patchSessionIn(
  s: SessionsSlice,
  key: SessionKey | null | undefined,
  patch: Partial<SessionState> | ((b: SessionState) => Partial<SessionState>)
): { sessions: Record<SessionKey, SessionState> } {
  const k = key ?? activeKey(s);
  const cur = s.sessions[k] ?? sessionFromThread(s.threads[k]);
  const next = typeof patch === "function" ? patch(cur) : patch;
  return { sessions: { ...s.sessions, [k]: { ...cur, ...next } } };
}

/** 切到一个会话时保证它有格子：已经有就原样用（后台跑着的那一轮就在里面）。 */
export function ensureSessionIn(s: SessionsSlice, key: SessionKey): Record<SessionKey, SessionState> {
  const live = s.sessions[key];
  if (!live) return { ...s.sessions, [key]: sessionFromThread(s.threads[key]) };
  // The header title lives on the record once the thread has one.
  const title = live.sessionInfo?.title ? null : titleForThread(s.threads[key]);
  if (!title) return s.sessions;
  return { ...s.sessions, [key]: { ...live, sessionInfo: { ...(live.sessionInfo || {}), title } } };
}

/**
 * Prune + persist with every session's live state folded into its record: a
 * session that has not been snapshotted yet (opened from a replay, running in
 * the background) must never be dropped as an empty thread.
 */
export function pruneLive(
  s: Pick<StudioState, "sessions">,
  threads: Record<string, ChatThread>,
  preserveIds: string[]
): Record<string, ChatThread> {
  const merged = { ...threads };
  const keep = [...preserveIds];
  for (const [key, b] of Object.entries(s.sessions)) {
    const t = merged[key];
    if (!t) continue;
    if (b.messages.length) merged[key] = { ...t, messages: b.messages, queuedPrompts: b.queuedPrompts };
    if (b.running) keep.push(key);
  }
  return pruneThreads(merged, keep);
}

/** 有一轮在跑的会话，按 ACP sessionId 列出（侧栏的"运行中"标记用）。 */
export function runningSessionIds(s: Pick<StudioState, "sessions" | "threads">): Record<string, true> {
  const out: Record<string, true> = {};
  for (const [key, b] of Object.entries(s.sessions)) {
    const sid = b.running ? s.threads[key]?.sessionId : null;
    if (sid) out[sid] = true;
  }
  return out;
}
