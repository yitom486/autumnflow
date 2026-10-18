import type { Message } from "@/lib/message-types";
import { mergeArtifacts } from "../../shared/acp-session-state";

/**
 * Chat threads: persisted per-agent conversation records (Inkdown-style
 * layer 1: instant local render, zero network).
 *
 * A thread binds one UI conversation to one agent (+ its ACP sessionId).
 * Session ids NEVER cross agents: every lookup filters by agentId, and the
 * store only ever binds ids obtained while that agent is active.
 */

export interface ActiveTurn {
  turnId: string;
  lastSeq: number;
  /** Highest seq whose resulting messages were frozen into the thread. */
  persistedSeq?: number;
  status: "running" | "done" | "error" | "interrupted";
  /** Assistant message this turn writes into (stable across reload). */
  assistantId?: string;
  startedAt: number;
}

export interface ChatThread {
  id: string;
  agentId: string;
  sessionId: string | null;
  /** cwd the session was created/opened with (needed for session/resume). */
  cwd?: string | null;
  /** MCP servers bound to this thread (carried into auto new/resume). */
  mcpServers?: unknown[];
  /** Run this session in the agent's code mode (PTC), when it supports one. */
  codeMode?: boolean;
  title?: string | null;
  messages: Message[];
  updatedAt: number;
  /** True when the remembered sessionId failed to resume (visible degrade). */
  stale?: boolean;
  /** Durable pointer to a turn that may still be running after reload. */
  activeTurn?: ActiveTurn;
}

export const THREADS_KEY = "acp_threads_v1";
export const MAX_THREADS = 40;
export const MAX_MSGS_PER_THREAD = 200;
export const MAX_CHARS_PER_MESSAGE = 20000;

export function newThreadId(): string {
  return `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function trunc(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.length > MAX_CHARS_PER_MESSAGE
    ? text.slice(0, MAX_CHARS_PER_MESSAGE) + "\n…[truncated for local cache]"
    : text;
}

function freezeToolCall(tc: any) {
  if (!tc) return tc;
  return {
    id: tc.id,
    title: tc.title,
    kind: tc.kind,
    status: tc.status,
    name: tc.name,
    rawInput: tc.rawInput,
    locations: tc.locations,
    rawOutput: typeof tc.rawOutput === "string" ? trunc(tc.rawOutput) : tc.rawOutput,
    startedAt: tc.startedAt,
    completedAt: tc.completedAt,
  };
}

/**
 * Freeze a live message for storage: drop streaming flags, cap sizes.
 * Persists user Q&A text (+thought) and compact toolCalls (enabling generative cards
 * to survive thread switches/reloads). Massive raw outputs are truncated.
 */
export function freezeMessage(m: Message): Message {
  return {
    ...m,
    content: trunc(m.content),
    progressContent: typeof m.progressContent === "string" ? trunc(m.progressContent) : m.progressContent,
    thought: typeof m.thought === "string" ? trunc(m.thought) : m.thought,
    isStreaming: false,
    toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls.map(freezeToolCall) : undefined,
    images: undefined,
    contentBlocks: freezeBlocks(m.contentBlocks),
    artifacts: m.artifacts?.map(entry => entry.kind === "compaction" ? { ...entry, value: { ...entry.value, summary: entry.value.summary == null ? entry.value.summary : freezeBlocks(entry.value.summary) } }
      : entry.kind === "message" ? { ...entry, value: { ...entry.value, content: entry.value.content == null ? entry.value.content : freezeBlocks(entry.value.content) } } : entry),
  };
}

function freezeBlocks(blocks?: import("@agentclientprotocol/sdk").ContentBlock[]) {
  return blocks?.filter(block => block.type !== "audio" && block.type !== "image" && !(block.type === "resource" && "blob" in block.resource))
    .map(block => block.type === "text" ? { ...block, text: trunc(block.text) } : block.type === "resource" && "text" in block.resource ? { ...block, resource: { ...block.resource, text: trunc(block.resource.text) } } : block);
}

function hasUserMessage(t: ChatThread): boolean {
  return hasUserContent(t.messages);
}

/** True when the thread contains at least one non-blank user turn (the only reliable "has content" signal). */
export function hasUserContent(messages: ReadonlyArray<Pick<Message, "role" | "content">> | undefined): boolean {
  return (messages ?? []).some(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
  );
}

/**
 * Human-readable session title derived from the first user turn.
 * The agent often supplies a title via session/list or session_info_update;
 * this is the local fallback so lists/headers never have to show raw ids.
 */
export function deriveSessionTitle(
  messages: ReadonlyArray<Pick<Message, "role" | "content">> | undefined,
  fallback?: string | null
): string | null {
  const first = (messages ?? []).find(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
  );
  if (!first || typeof first.content !== "string") {
    const f = typeof fallback === "string" ? fallback.trim() : "";
    return f || null;
  }
  const text = first.content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,3}/g, "")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, " ")
    .replace(/^[ \t]*>[ \t]?/gm, " ")
    .replace(/^[ \t]*[-*+][ \t]+/gm, " ")
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return (typeof fallback === "string" && fallback.trim()) || null;
  const chars = Array.from(text);
  return chars.slice(0, 42).join("") + (chars.length > 42 ? "…" : "");
}

/** True when the thread has neither a user turn nor assistant text. */
export function isThreadEmpty(thread: Pick<ChatThread, "messages"> | null | undefined): boolean {
  if (!thread) return true;
  if (hasUserContent(thread.messages)) return false;
  return !thread.messages.some(
    (m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0
  );
}

/** Agent-generated default names that carry no information for the user. */
export function isDefaultSessionTitle(title?: string | null): boolean {
  if (typeof title !== "string") return true;
  const t = title.trim();
  if (!t) return true;
  return /^(New session|新会话)(\s*-\s*|\s*$)/i.test(t);
}

/** Title stored on a thread, or derived from its first user message. */
export function titleForThread(t: Pick<ChatThread, "title" | "messages"> | null | undefined): string | null {
  if (!t) return null;
  const stored = typeof t.title === "string" ? t.title.trim() : "";
  return stored || deriveSessionTitle(t.messages);
}

/** 参与「是否真的变了」判定的字段：只有这些值变了才需要产出新对象。 */
const MERGED_TURN_KEYS = [
  "content",
  "progressContent",
  "thought",
  "toolCalls",
  "images",
  "contentBlocks",
  "artifacts",
  "plan",
  "usage",
  "model",
  "mode",
  "isStreaming",
  "timestamp",
  "thoughtTiming",
] as const;

/** "" / undefined / null 视为同一语义（空内容），其余按引用比较。 */
function sameTurnValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const aEmpty = a === undefined || a === null || a === "";
  const bEmpty = b === undefined || b === null || b === "";
  return aEmpty && bEmpty;
}

function isSameTurn(a: any, b: any): boolean {
  for (const key of MERGED_TURN_KEYS) {
    if (!sameTurnValue(a[key], b[key])) return false;
  }
  return true;
}

function sameToolCall(a: any, b: any): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Auto-heal and normalize assistant turns:
 * Merges consecutive assistant messages (e.g. from fragmented replays,
 * standalone thought chunks, or step-by-step tool/status outputs) into a
 * single cohesive assistant turn.
 *
 * 引用稳定性是硬要求：assistant-ui 的 external store 以「源消息对象引用」作为
 * 转换缓存键，任何无关的浅拷贝都会让整条线程的缓存击穿、所有气泡重渲染。
 * 因此：无需合并时原样返回入参对象；合并后若内容与前者完全一致，也返回前者本身。
 */
export function mergeAssistantTurns<T extends Partial<Message> & { role: string; content?: string }>(
  messages: T[]
): T[] {
  if (!Array.isArray(messages) || messages.length <= 1) return messages;

  const result: T[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    // If consecutive assistant messages occur in the same turn without user interruption, merge them
    if (prev && prev.role === "assistant" && msg.role === "assistant") {
      // 1. Merge thought
      let mergedThought = prev.thought;
      if (msg.thought) {
        if (!mergedThought) {
          mergedThought = msg.thought;
        } else if (!mergedThought.endsWith("\n") && !msg.thought.startsWith("\n")) {
          mergedThought = mergedThought + "\n\n" + msg.thought;
        } else {
          mergedThought = mergedThought + "\n" + msg.thought;
        }
      }

      // 2. Merge content
      let mergedContent = prev.content || "";
      const incomingContent = msg.content || "";
      if (incomingContent) {
        if (!mergedContent) {
          mergedContent = incomingContent;
        } else if (!mergedContent.endsWith("\n") && !incomingContent.startsWith("\n")) {
          mergedContent = mergedContent + "\n\n" + incomingContent;
        } else {
          mergedContent = mergedContent + "\n" + incomingContent;
        }
      }

      // 2.5 Merge progressContent
      let mergedProgress = (prev as any).progressContent || "";
      const incomingProgress = (msg as any).progressContent || "";
      if (incomingProgress) {
        if (!mergedProgress) mergedProgress = incomingProgress;
        else if (!mergedProgress.endsWith("\n") && !incomingProgress.startsWith("\n")) {
          mergedProgress = mergedProgress + "\n\n" + incomingProgress;
        } else {
          mergedProgress = mergedProgress + "\n" + incomingProgress;
        }
      }

      // 3. Merge toolCalls (deduplicate by id) — 仅在确有变化时才分配新数组
      let mergedTools = prev.toolCalls;
      if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
        const next = prev.toolCalls ? [...prev.toolCalls] : [];
        let toolsChanged = false;
        for (const tc of msg.toolCalls) {
          const idx = next.findIndex((x) => x.id === tc.id);
          if (idx >= 0) {
            const mergedCall = { ...next[idx], ...tc };
            if (!sameToolCall(next[idx], mergedCall)) {
              next[idx] = mergedCall;
              toolsChanged = true;
            }
          } else {
            next.push(tc);
            toolsChanged = true;
          }
        }
        if (toolsChanged) mergedTools = next;
      }

      // 4. Merge images — 同上，没有新图就不动原数组
      let mergedImages = prev.images;
      if (Array.isArray(msg.images) && msg.images.length > 0) {
        mergedImages = [...(prev.images || []), ...msg.images].slice(-8);
      }

      const nextTurn: T = {
        ...prev,
        content: mergedContent,
        progressContent: mergedProgress || undefined,
        thought: mergedThought,
        toolCalls: mergedTools && mergedTools.length > 0 ? mergedTools : undefined,
        images: mergedImages && mergedImages.length > 0 ? mergedImages : undefined,
        contentBlocks: msg.contentBlocks?.length ? [...(prev.contentBlocks ?? []), ...msg.contentBlocks] : prev.contentBlocks,
        artifacts: msg.artifacts?.length ? mergeArtifacts(prev.artifacts ?? [], msg.artifacts) : prev.artifacts,
        plan: msg.plan || prev.plan,
        usage: msg.usage || prev.usage,
        model: msg.model || prev.model,
        mode: msg.mode || prev.mode,
        isStreaming: Boolean(prev.isStreaming || msg.isStreaming),
        timestamp: msg.timestamp || prev.timestamp,
        thoughtTiming: prev.thoughtTiming || msg.thoughtTiming,
      };

      // 空合并（例如重复的快照 / 无正文的续传消息）保留原引用，避免无谓的重渲染。
      result[result.length - 1] = isSameTurn(prev, nextTurn) ? prev : nextTurn;
    } else {
      // 不要浅拷贝：入参对象就是下游缓存的身份键。
      result.push(msg);
    }
  }
  return result;
}

export interface PartitionedTurnContent {
  progress?: string;
  conclusion: string;
}

/**
 * 分区助手轮次内容：
 * 1. 若显式携带 progressContent，则 progressContent 为阶段过程记录，content 为结论。
 * 2. 若未显式携带，但包含工具调用或多阶段标记（如“接线”、“总结”、“结论”、“验证”、“改动说明”等）：
 *    将前面的过渡文本收拢为阶段记录，将最终定稿与结论保留在底部。
 */
export function partitionTurnContent(
  content: string,
  progressContent?: string,
  hasTools?: boolean
): PartitionedTurnContent {
  const trimmedProgress = progressContent?.trim();
  const trimmedContent = content?.trim() || "";

  if (trimmedProgress) {
    if (!trimmedContent) {
      return {
        progress: undefined,
        conclusion: trimmedProgress,
      };
    }
    return {
      progress: trimmedProgress,
      conclusion: trimmedContent,
    };
  }

  // 仅在明确包含工具调用（hasTools 为 true）且未显式拆分 progress 时，
  // 才对历史消息做后验段落切分。纯文本问答/代码讲解/长文分析绝不折叠正文。
  if (hasTools && trimmedContent.length > 50) {
    const conclusionRegex =
      /(?:\n\n|\r?\n)(?=(?:#{1,4}\s+|(?:\*\*|__))(?:总结|结论|完成|验证|接线|结果|最终|改动说明|变更说明|实施方案|Summary|Conclusion|Resolution|Verified|Implementation|Deliverables)[\s\S]*?(?:\*\*|__|\n))/i;
    const match = conclusionRegex.exec(trimmedContent);
    if (match && match.index > 15) {
      const progressPart = trimmedContent.slice(0, match.index).trim();
      const conclusionPart = trimmedContent.slice(match.index).trim();
      const hasInlinePlaceholder = /<!--acp-tool:[^>]+-->|::acp-tool\[[^\]]+\]::/.test(progressPart);
      if (progressPart && conclusionPart && !hasInlinePlaceholder) {
        return {
          progress: progressPart,
          conclusion: conclusionPart,
        };
      }
    }
  }

  return {
    progress: undefined,
    conclusion: trimmedContent,
  };
}

/**
 * Prune for storage: drop blank threads (except preserved ids, e.g. the
 * live draft), freeze messages, cap counts. Pure — safe to unit test.
 */
export function pruneThreads(
  threads: Record<string, ChatThread>,
  preserveIds: string[] = [],
): Record<string, ChatThread> {
  const kept = Object.values(threads).filter(
    (t) => preserveIds.includes(t.id) || hasUserMessage(t),
  );
  kept.sort((a, b) => b.updatedAt - a.updatedAt);
  const out: Record<string, ChatThread> = {};
  for (const t of kept.slice(0, MAX_THREADS)) {
    const normalized = mergeAssistantTurns(t.messages);
    out[t.id] = {
      ...t,
      messages: normalized.slice(-MAX_MSGS_PER_THREAD).map(freezeMessage),
    };
  }
  return out;
}

/**
 * 将任意路径提纯为符合目标运行环境规范的原生 CWD 路径（零硬编码、通用适配 WSL、SSH、Remote、Local）。
 *
 * 1. 当目标环境是 POSIX 平台（Linux / WSL / SSH 远程 Linux / macOS 等）：
 *    - 若携带 Windows UNC 包装（如 \\wsl.localhost\Ubuntu\home\... 或 //wsl$\Ubuntu/...），剥离 UNC 前缀，还原为纯正的 Linux 原生路径；
 *    - 若宿主机错误在 POSIX 绝对路径前拼接了 Windows 盘符（如 D:\home\... 或 C:\var\...），自动剔除盘符；
 *    - 统一将反斜杠替换为正斜杠；
 *    - 保证输出永远是以 / 开头的纯净 POSIX 路径，绝不包含任何盘符或 UNC 前缀。
 *
 * 2. 当目标环境是 Windows 平台：
 *    - 保留 Windows 风格路径（带盘符或 Windows 路径格式）。
 */
export function toEnvironmentNativeCwd(rawPath?: string | null, isPosix = false): string {
  // Runtime boundary: callers include UI event handlers and persisted records.
  // A non-string here used to crash the whole handler with `e.trim is not a
  // function`, so treat it as "no path" instead of trusting the TS signature.
  if (typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  let p = trimmed.replace(/\\/g, "/");

  // 若带 Windows WSL UNC 前缀，剥离 UNC 包装，提取真实路径
  const uncMatch = /^\/\/(?:wsl\$|wsl\.localhost)\/[^\/]+(\/.*)?$/i.exec(p);
  if (uncMatch) {
    p = uncMatch[1] || "/";
  }

  if (isPosix) {
    // POSIX 模式（WSL / SSH / Linux）：
    // 若错误拼接了 Windows 盘符（如 D:/home/... 或 C:/opt/...），剥离盘符还原为 POSIX 原生路径
    const drivePosixMatch = /^[a-zA-Z]:(\/.*)$/.exec(p);
    if (drivePosixMatch) {
      p = drivePosixMatch[1];
    }
    // 若没有以 / 开头，补齐 /
    if (!p.startsWith("/")) {
      p = "/" + p;
    }
  }

  // 去除尾随多余斜杠（除非根目录 /）
  if (p.length > 1 && p.endsWith("/")) {
    p = p.replace(/\/+$/, "");
  }

  return p;
}

/**
 * 标准化路径比较（统一反斜杠、去除尾随斜杠、Windows 盘符首字母统一小写、WSL UNC 统一折叠）
 */
export function normalizeCwd(cwd?: string | null): string {
  if (!cwd) return "";
  let cleaned = toEnvironmentNativeCwd(cwd, false);
  if (/^[a-zA-Z]:/.test(cleaned)) {
    return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  }
  return cleaned;
}

export function isSameCwd(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return normalizeCwd(a) === normalizeCwd(b);
}

/** Latest thread of an agent, optionally scoped to a workspace cwd */
export function threadForAgent(
  threads: Record<string, ChatThread>,
  agentId: string,
  cwd?: string | null,
): ChatThread | null {
  let best: ChatThread | null = null;
  const target = cwd ? normalizeCwd(cwd) : null;
  for (const t of Object.values(threads)) {
    if (t.agentId !== agentId) continue;
    if (target) {
      if (!t.cwd || normalizeCwd(t.cwd) !== target) continue;
    }
    if (!best || t.updatedAt > best.updatedAt) best = t;
  }
  return best;
}

/** Get all threads for a specific workspace cwd */
export function threadsForCwd(
  threads: Record<string, ChatThread>,
  cwd: string,
  agentId?: string,
): ChatThread[] {
  const target = normalizeCwd(cwd);
  if (!target) return [];
  const list = Object.values(threads).filter((t) => {
    if (agentId && t.agentId !== agentId) return false;
    return Boolean(t.cwd && normalizeCwd(t.cwd) === target);
  });
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}

/** Find a recorded thread by exact sessionId for an agent (optimistic instant switch). */
export function findThreadBySessionId(
  threads: Record<string, ChatThread>,
  agentId: string,
  sessionId: string,
): ChatThread | null {
  if (!sessionId) return null;
  for (const t of Object.values(threads)) {
    if (t.agentId === agentId && t.sessionId === sessionId) return t;
  }
  return null;
}

export function loadThreads(): Record<string, ChatThread> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(THREADS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ChatThread> = {};
    for (const [id, t] of Object.entries(parsed as Record<string, any>)) {
      if (!t || typeof t !== "object" || typeof (t as any).agentId !== "string") continue;
      const th = t as ChatThread;
      if (!Array.isArray(th.messages)) continue;
      out[id] = {
        ...th,
        id,
        sessionId: th.sessionId ?? null,
        updatedAt: th.updatedAt ?? 0,
        messages: mergeAssistantTurns(th.messages),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveThreads(threads: Record<string, ChatThread>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
  } catch {
    // ignore storage errors (private mode / quota)
  }
}
