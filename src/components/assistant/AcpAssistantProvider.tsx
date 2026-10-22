import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  createMessageQueue,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";
import { useStudioStore } from "@/stores/useStudioStore";
import { convertAcpMessages, extractAppendText } from "@/lib/acp-assistant";
import { mergeAssistantTurns } from "@/lib/threads";

export interface AcpAssistantProviderProps {
  children: React.ReactNode;
  onSend: (text?: string) => void | Promise<void>;
  onStop: () => void;
  onNewSession?: (targetCwd?: string) => void | Promise<void>;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
}

/** Thread-view page size: only the latest N messages enter the runtime. */
export const ACP_THREAD_PAGE_SIZE = 30;

/**
 * Binds the existing zustand ACP store to assistant-ui via
 * ExternalStoreRuntime (docs: /docs/runtimes/custom/external-store).
 *
 * State ownership stays in zustand + ACP gateway (consumeUniversalChat in
 * App.tsx). assistant-ui only renders + drives interactions:
 * - messages: converted live from useStudioStore (streaming-safe, immutable)
 * - onNew: user sent via assistant-ui composer -> existing handleSend
 * - onCancel: existing handleStop (abort + session/cancel RPC)
 * - onReload: re-send last user text through the same ACP path
 * - onEdit: truncate the ACP transcript at the edited message, then resend
 * - queue: sends during a run buffer and drain in order (排队); cancel
 *   pauses draining instead of dropping; edit/reload clear stale items
 * - threadList: binds multi-session tracking, switching, and new session creation
 */
export const AcpAssistantProvider: React.FC<AcpAssistantProviderProps> = ({
  children,
  onSend,
  onStop,
  onNewSession,
  onOpenSession,
  onDeleteSession,
}) => {
  const rawMessages = useStudioStore((s) => s.messages);
  // 视图自己的运行状态：别的会话在跑不该让这里的队列/发送按钮"忙"。
  const isStreaming = useStudioStore((s) => !!s.runningSessions[s.sessionId ?? ""]);
  const activeSessionId = useStudioStore((s) => s.sessionId);
  const activeThreadId = useStudioStore((s) => s.activeThreadId);
  const studioThreads = useStudioStore((s) => s.threads);
  const activeAgentId = useStudioStore((s) => s.activeAgentId);

  // Auto-heal: Ensure all consecutive assistant bubbles within the same turn are unified
  const messages = useMemo(() => mergeAssistantTurns(rawMessages), [rawMessages]);

  const currentThreadId = activeSessionId || activeThreadId || "default";

  // Build the community component's thread list representation
  const threadListData = useMemo(() => {
    const list = Object.values(studioThreads)
      .filter((t) => !t.agentId || t.agentId === activeAgentId)
      .map((t) => ({
        status: "regular" as const,
        id: t.sessionId || t.id,
        title: t.title || (t.sessionId ? `会话 (${t.sessionId.slice(0, 8)})` : "新会话"),
      }));
    if (currentThreadId && !list.some((item) => item.id === currentThreadId)) {
      list.unshift({
        status: "regular" as const,
        id: currentThreadId,
        title: activeSessionId ? `当前会话 (${activeSessionId.slice(0, 8)})` : "当前会话",
      });
    }
    return list;
  }, [studioThreads, activeAgentId, currentThreadId, activeSessionId]);

  // Pagination: long ACP histories (session replay can be hundreds of
  // messages) only expose the latest page to the runtime. Older pages load
  // on demand via hasEarlier/onLoadEarlier ("加载更早的消息").
  const [visibleCount, setVisibleCount] = useState(ACP_THREAD_PAGE_SIZE);
  const headId = messages.length > 0 ? messages[0].id : null;
  useEffect(() => {
    setVisibleCount(ACP_THREAD_PAGE_SIZE);
  }, [headId]);
  const visibleMessages =
    messages.length > visibleCount
      ? messages.slice(messages.length - visibleCount)
      : messages;

  const converted = useMemo(() => convertAcpMessages(visibleMessages), [visibleMessages]);

  // Message queue (排队): sends during a run buffer instead of dropping.
  // All runs funnel through onSend/handleSend, so run settle is observed
  // via the isStreaming edges below; the driver only dispatches.
  const onSendRef = useRef(onSend);
  const busyEdges = useRef(0);
  const wasRunning = useRef(isStreaming);
  useLayoutEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  const [queue] = useState(() => {
    const controller = createMessageQueue({
      run: async (message) => {
        const edgesAtDispatch = busyEdges.current;
        controller.notifyBusy();
        try {
          await onSendRef.current(extractAppendText(message));
        } finally {
          if (busyEdges.current === edgesAtDispatch && !wasRunning.current) {
            controller.notifyIdle();
          }
        }
      },
    });
    if (isStreaming) controller.notifyBusy();
    return controller;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  useEffect(() => {
    if (!wasRunning.current && isStreaming) {
      busyEdges.current++;
      queue.notifyBusy();
    }
    if (wasRunning.current && !isStreaming) queue.notifyIdle();
    wasRunning.current = isStreaming;
  }, [isStreaming, queue]);

  const runtime = useExternalStoreRuntime({
    messages: converted,
    convertMessage: (m) => m,
    isRunning: isStreaming,
    hasEarlier: messages.length > visibleMessages.length,
    onLoadEarlier: async () => {
      setVisibleCount((c) => c + ACP_THREAD_PAGE_SIZE);
    },
    queue: queue.adapter,
    onNew: async (message: AppendMessage) => {
      onSend(extractAppendText(message));
    },
    onCancel: async () => {
      onStop();
    },
    // Regenerate last turn: re-send last user text through the same ACP path.
    onReload: async () => {
      queue.clear();
      const st = useStudioStore.getState();
      const lastUser = [...st.messages].reverse().find((m) => m.role === "user");
      if (lastUser) onSend(lastUser.content);
    },
    onEdit: async (message: AppendMessage) => {
      queue.clear();
      const text = extractAppendText(message);
      const st = useStudioStore.getState();
      // Docs pattern: parentId points at the message before the edited one,
      // so slice(0, index) drops the edited turn and everything after it.
      const parentIdx = st.messages.findIndex((m) => m.id === message.parentId);
      const truncated =
        parentIdx >= 0 ? st.messages.slice(0, parentIdx + 1) : st.messages;
      // Drop a trailing streaming assistant placeholder if present.
      const clean =
        truncated.length > 0 && truncated[truncated.length - 1].isStreaming
          ? truncated.slice(0, -1)
          : truncated;
      st.setMessages(clean);
      onSend(text);
    },
    adapters: {
      threadList: {
        threadId: currentThreadId,
        threads: threadListData,
        onSwitchToNewThread: async () => {
          if (onNewSession) {
            await onNewSession();
          } else {
            useStudioStore.getState().newThread(useStudioStore.getState().activeAgentId);
          }
        },
        onSwitchToThread: async (targetId) => {
          if (onOpenSession) {
            await onOpenSession(targetId);
          } else {
            const st = useStudioStore.getState();
            st.optimisticOpenSession(st.activeAgentId, targetId, "");
          }
        },
        onDelete: onDeleteSession
          ? async (id) => {
              await onDeleteSession(id);
            }
          : undefined,
      },
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
};
