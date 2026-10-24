import { describe, expect, test, beforeEach, vi, afterEach } from "vitest";
import { activeKey, useStudioStore } from "../../src/stores/useStudioStore";
import {
  consumeUniversalChat,
  buildTranscriptFromReplay,
} from "../../src/lib/universal-api";
import { THREADS_KEY, pruneThreads, mergeAssistantTurns } from "../../src/lib/threads";
import { view } from "../helpers/studio";

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Mock model turn: text chunk + tool call (with result) + final answer.
 * Mirrors what the gateway forwards from a real agent.
 */
function mockTurnStream(): string {
  return [
    sseFrame({ type: "start", agentId: "codex", sessionId: "sess-mock" }),
    sseFrame({
      type: "update",
      agentId: "codex",
      sessionId: "sess-mock",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "最终" },
        messageId: "m1",
      },
    }),
    sseFrame({
      type: "update",
      agentId: "codex",
      sessionId: "sess-mock",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "read foo.ts",
        kind: "read",
        status: "in_progress",
      },
    }),
    sseFrame({
      type: "update",
      agentId: "codex",
      sessionId: "sess-mock",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        title: "read foo.ts",
        kind: "read",
        status: "completed",
        content: [{ type: "text", text: "file-bytes-result" }],
      },
    }),
    sseFrame({
      type: "update",
      agentId: "codex",
      sessionId: "sess-mock",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "答案。" },
        messageId: "m1",
      },
    }),
    sseFrame({ type: "done", agentId: "codex", sessionId: "sess-mock", stopReason: "end_turn" }),
  ].join("");
}

function stubChatFetch(body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200 }))
  );
}

beforeEach(() => {
  localStorage.clear();
  useStudioStore.getState().resetStudio();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("turn persist (mock model events -> disk)", () => {
  test("full turn lands on disk: user prompt + final answer, no tool calls", async () => {
    stubChatFetch(mockTurnStream());
    const st = useStudioStore.getState();
    st.setActiveAgentId("codex");
    st.newThread("codex");
    st.setSessionId("sess-mock");

    // Same reducer shape as App.handleSend.
    const assistantId = "asst-test-1";
    st.appendMessage({ id: "user-test-1", role: "user", content: "帮我看看 foo", timestamp: "t" });
    st.appendMessage({
      id: assistantId, role: "assistant", content: "", thought: "",
      plan: [], toolCalls: [], timestamp: "t", isStreaming: true,
    });

    const cur = useStudioStore.getState();
    await consumeUniversalChat(
      { agentId: "codex", sessionId: "sess-mock", prompt: [{ type: "text", text: "帮我看看 foo" }] },
      {
        onTextChunk: (chunk) =>
          cur.patchMessage(assistantId, (m) => ({ ...m, content: m.content + chunk })),
        onToolCall: (c) =>
          cur.patchMessage(assistantId, (m) => ({ ...m, toolCalls: [...(m.toolCalls || []), c] })),
        onToolCallUpdate: (c) =>
          cur.patchMessage(assistantId, (m) => {
            const calls = [...(m.toolCalls || [])];
            const i = calls.findIndex((x) => x.id === c.id);
            if (i >= 0) calls[i] = { ...calls[i], ...c };
            else calls.push(c);
            return { ...m, toolCalls: calls };
          }),
        onDone: () => useStudioStore.getState().patchMessage(assistantId, { isStreaming: false }),
      }
    );

    // Live view still shows the tool call...
    const live = view().messages.find((m) => m.id === assistantId)!;
    expect(live.content).toBe("最终答案。");
    expect(live.toolCalls).toHaveLength(1);

    // ...but what hits the disk (same call App.handleSend makes on finish)
    // keeps the Q&A only.
    useStudioStore.getState().snapshotThread();
    const raw = localStorage.getItem(THREADS_KEY)!;
    expect(raw).toBeTruthy();
    const threads = JSON.parse(raw);
    const ids = Object.keys(threads);
    expect(ids).toHaveLength(1);
    const saved = threads[ids[0]];
    expect(saved.sessionId).toBe("sess-mock");
    const user = saved.messages.find((m: any) => m.role === "user");
    expect(user.content).toBe("帮我看看 foo");
    const asst = saved.messages.find((m: any) => m.role === "assistant");
    expect(asst.content).toBe("最终答案。");
    expect(asst.isStreaming).toBe(false);
    expect(asst.toolCalls).toBeDefined();
    expect(asst.toolCalls?.[0].id).toBe("t1");
    expect(JSON.stringify(saved)).not.toContain("file-bytes-result");
  });

  test("turn-end marker splices final text and persists async (text only)", async () => {
    stubChatFetch(mockTurnStream());
    const st = useStudioStore.getState();
    st.setActiveAgentId("codex");
    st.newThread("codex");
    st.setSessionId("sess-mock");

    // Same shape as App.handleSend: accumulate chunks, then the finally
    // block on the turn-end marker persists async (fire-and-forget).
    const assistantId = "asst-async-1";
    st.appendMessage({ id: "user-async-1", role: "user", content: "帮我看看 foo", timestamp: "t" });
    st.appendMessage({
      id: assistantId, role: "assistant", content: "", thought: "",
      plan: [], toolCalls: [], timestamp: "t", isStreaming: true,
    });
    const cur = useStudioStore.getState();
    await consumeUniversalChat(
      { agentId: "codex", sessionId: "sess-mock", prompt: [{ type: "text", text: "帮我看看 foo" }] },
      {
        onTextChunk: (chunk) =>
          cur.patchMessage(assistantId, (m) => ({ ...m, content: m.content + chunk })),
        onToolCall: (c) =>
          cur.patchMessage(assistantId, (m) => ({ ...m, toolCalls: [...(m.toolCalls || []), c] })),
        onToolCallUpdate: (c) =>
          cur.patchMessage(assistantId, (m) => {
            const calls = [...(m.toolCalls || [])];
            const i = calls.findIndex((x) => x.id === c.id);
            if (i >= 0) calls[i] = { ...calls[i], ...c };
            else calls.push(c);
            return { ...m, toolCalls: calls };
          }),
        onDone: () => useStudioStore.getState().patchMessage(assistantId, { isStreaming: false }),
      }
    );
    // App.handleSend finally block, verbatim semantics.
    {
      const c2 = useStudioStore.getState();
      c2.setSessionRunning(activeKey(c2), false);
      c2.patchMessage(assistantId, { isStreaming: false });
      void Promise.resolve().then(() => {
        try {
          useStudioStore.getState().snapshotThread();
        } catch (err) {
          console.error("[App] turn persist failed:", err);
        }
      });
    }

    // Disk has no final answer yet — newThread() only persisted the
    // empty placeholder; the turn write is async...
    const before = JSON.parse(localStorage.getItem(THREADS_KEY)!);
    const threadBefore = before[Object.keys(before)[0]];
    const asstBefore = threadBefore.messages.find((m: any) => m.role === "assistant");
    expect(!asstBefore || asstBefore.content === "").toBe(true);
    // ...and lands after microtasks flush, text-only.
    await new Promise((r) => setTimeout(r, 0));
    const raw = localStorage.getItem(THREADS_KEY)!;
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw);
    const thread = saved[Object.keys(saved)[0]];
    const asst = thread.messages.find((m: any) => m.role === "assistant");
    expect(asst.content).toBe("最终答案。");
    expect(asst.toolCalls).toBeDefined();
    expect(asst.toolCalls?.[0].id).toBe("t1");
    expect(JSON.stringify(thread)).not.toContain("file-bytes-result");
  });

  test("replayed history persists the same way: answers kept, tool calls preserved", () => {
    const t = buildTranscriptFromReplay([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "q" }, messageId: "u1" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" }, messageId: "m1" },
      { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run", kind: "exec", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "tc-1", title: "run", status: "completed" },
    ]);
    expect(t.messages).toHaveLength(2);
    // Display keeps the tool call...
    expect(t.messages[1].toolCalls).toHaveLength(1);

    // ...persist preserves compact toolCalls for generative card rehydration.
    const pruned = pruneThreads(
      { th1: { id: "th1", agentId: "codex", sessionId: "s", messages: t.messages as any[], updatedAt: 1 } },
      []
    );
    const saved = pruned.th1.messages;
    expect(saved[0]).toMatchObject({ role: "user", content: "q" });
    expect(saved[1]).toMatchObject({ role: "assistant", content: "a" });
    expect((saved[1] as any).toolCalls).toBeDefined();
  });

  test("restore brings back Q&A after a reload", async () => {
    stubChatFetch(mockTurnStream());
    const st = useStudioStore.getState();
    st.setActiveAgentId("codex");
    st.newThread("codex");
    st.setSessionId("sess-mock");
    st.appendMessage({ id: "u", role: "user", content: "q", timestamp: "t" });
    st.appendMessage({ id: "a", role: "assistant", content: "最终答案。", timestamp: "t" });
    useStudioStore.getState().snapshotThread();

    // Simulate a reload: no live session state survives, only the disk.
    useStudioStore.setState({ sessions: {}, activeThreadId: null });
    expect(view().messages).toEqual([]);
    const t = useStudioStore.getState().restoreThread("codex");
    expect(t).not.toBeNull();
    const msgs = view().messages;
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ["user", "q"],
      ["assistant", "最终答案。"],
    ]);
  });

  test("mergeAssistantTurns auto-heals existing fragmented history (e.g. standalone thought bubble + answer bubble)", () => {
    // Simulates the exact user historical session bug:
    // Message 1: User prompt
    // Message 2: Assistant with thought ONLY, empty text body (99 chars)
    // Message 3: Assistant with answer text
    const fragmented = [
      {
        id: "msg-1",
        role: "user" as const,
        content: "在 server / desktop / scripts 下硬编码扫描完成",
        timestamp: "11:15",
      },
      {
        id: "msg-2",
        role: "assistant" as const,
        content: "",
        thought: "思考过程 (99 字)...",
        timestamp: "11:16",
      },
      {
        id: "msg-3",
        role: "assistant" as const,
        content: "是的，在这个项目里硬编码不是代码洁癖问题，是直接变成用户体感问题的：\n1. 端口写死\n2. 路径写死",
        timestamp: "11:16",
      },
    ];

    const healed = mergeAssistantTurns(fragmented);

    // Exactly 2 messages: 1 user, 1 unified assistant
    expect(healed.length).toBe(2);
    expect(healed[0].role).toBe("user");
    expect(healed[0].content).toBe("在 server / desktop / scripts 下硬编码扫描完成");

    const asst = healed[1];
    expect(asst.role).toBe("assistant");
    expect(asst.thought).toBe("思考过程 (99 字)...");
    expect(asst.content).toBe("是的，在这个项目里硬编码不是代码洁癖问题，是直接变成用户体感问题的：\n1. 端口写死\n2. 路径写死");
  });
});

