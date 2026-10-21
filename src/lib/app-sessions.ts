import { isDefaultSessionTitle, titleForThread, type ChatThread } from "@/lib/threads";
import type { SessionItem } from "@/components/universal/Sidebar";

/**
 * 本应用用过/打开过的会话清单（跨运行时）。
 *
 * 会话与运行时是一对一绑定的：一个会话只对应一个运行时，一个运行时可以有多个
 * 会话。清单的主干是本地线程缓存（每个线程知道自己绑的哪个运行时），再补上
 * 当前运行时的 agent 侧历史（应用之外建的会话）。
 */
export function appSessionList(args: {
  threads: Record<string, ChatThread>;
  agentSessions: SessionItem[];
  activeAgentId: string;
  agentTitle: (agentId: string) => string;
  /** 正在跑的那一轮属于哪个会话。 */
  streamingSessionId?: string | null;
}): SessionItem[] {
  const { threads, agentSessions, activeAgentId, agentTitle, streamingSessionId } = args;
  const byKey = new Map<string, SessionItem>();
  const put = (item: SessionItem) => byKey.set(`${item.agentId || ""}:${item.sessionId}`, item);

  // 本地线程：所有运行时的会话都在这里
  for (const t of Object.values(threads)) {
    if (!t.sessionId) continue;
    put({
      sessionId: t.sessionId,
      title: titleForThread(t) || null,
      cwd: t.cwd || undefined,
      updatedAt: new Date(t.updatedAt).toISOString(),
      origin: "created",
      agentId: t.agentId,
      agentLabel: agentTitle(t.agentId),
    });
  }
  // 当前运行时的 agent 侧历史（标题/时间更权威，覆盖同名项）
  for (const item of agentSessions) {
    put({ ...item, agentId: activeAgentId, agentLabel: agentTitle(activeAgentId) });
  }

  return [...byKey.values()]
    .map((item) => ({
      ...item,
      running: !!streamingSessionId && streamingSessionId === item.sessionId,
    }))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

/** 会话标题：agent 给的标题优先，其次本地缓存里算出来的。 */
export function sessionTitleFor(item: SessionItem, thread?: ChatThread): string {
  if (item.title && !isDefaultSessionTitle(item.title)) return item.title;
  return titleForThread(thread) || item.title || "未命名会话";
}
