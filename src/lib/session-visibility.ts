import { isDefaultSessionTitle, titleForThread, type ChatThread } from "@/lib/threads";
import type { SessionItem } from "@/components/universal/Sidebar";

/**
 * Which sessions the sidebar may show.
 *
 * The local thread cache is authoritative for "this session has a
 * conversation" and for a human title until the Agent supplies one through
 * session/list.
 *
 * Two kinds of session are hidden:
 * - an app-owned draft whose thread is known to be empty, and
 * - an app-owned row with a default Agent title and no local thread (an
 *   abandoned draft that must not reappear as a raw id).
 *
 * An imported reference is never hidden: it points at agent-side history the
 * app may not have loaded yet, so an empty local thread says nothing about it.
 */
export function visibleSessions(
  sessionsRaw: SessionItem[],
  threads: Record<string, ChatThread>,
  activeAgentId: string
): SessionItem[] {
  const threadBySession = new Map<string, ChatThread>();
  for (const thread of Object.values(threads)) {
    if (thread.agentId === activeAgentId && thread.sessionId) {
      threadBySession.set(thread.sessionId, thread);
    }
  }
  return sessionsRaw.flatMap((item) => {
    const thread = item.sessionId ? threadBySession.get(item.sessionId) : undefined;
    if (thread && isThreadEmptyThread(thread) && item.origin !== "imported") return [];
    if (!thread && item.origin === "created" && isDefaultSessionTitle(item.title)) return [];
    const agentTitle = isDefaultSessionTitle(item.title) ? null : item.title;
    const title = agentTitle || titleForThread(thread) || "未命名会话";
    return [{ ...item, title }];
  });
}

/** Local copy of isThreadEmpty so this module stays free of extra imports. */
function isThreadEmptyThread(thread: Pick<ChatThread, "messages">): boolean {
  const messages = thread.messages ?? [];
  if (messages.some((m) => m.role === "user" && String(m.content ?? "").trim())) return false;
  return !messages.some(
    (m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0
  );
}
