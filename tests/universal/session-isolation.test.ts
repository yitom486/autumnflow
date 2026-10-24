import { describe, it, expect, afterEach } from "vitest";
import { activeKey, runningSessionIds, sessionOf, useStudioStore } from "@/stores/useStudioStore";
import { view } from "../helpers/studio";

const running = () => runningSessionIds(useStudioStore.getState());

// 会话之间必须互不影响：一个会话在跑，另一个会话照发不误，排队也不会串。
describe("session isolation", () => {
  afterEach(() => {
    useStudioStore.getState().resetStudio();
  });

  it("queues a prompt on the session that typed it, not on another one", () => {
    useStudioStore.getState().newThread("codex");
    const first = useStudioStore.getState().activeThreadId!;

    useStudioStore.getState().enqueuePrompt("A 会话排队的");
    expect(view().queuedPrompts.map((q) => q.text)).toEqual(["A 会话排队的"]);

    // 切到另一个会话
    useStudioStore.getState().newThread("codex");
    const second = useStudioStore.getState().activeThreadId!;
    expect(second).not.toBe(first);
    expect(view().queuedPrompts).toEqual([]);

    // 在新会话排队 → 落在新会话上，A 会话的队列原封不动
    useStudioStore.getState().enqueuePrompt("B 会话排队的");
    const st = useStudioStore.getState();
    expect(sessionOf(st, second).queuedPrompts.map((q) => q.text)).toEqual(["B 会话排队的"]);
    expect(sessionOf(st, first).queuedPrompts.map((q) => q.text)).toEqual(["A 会话排队的"]);
  });

  it("switching away and back shows the session's live state, tool calls included", () => {
    useStudioStore.getState().newThread("codex");
    useStudioStore.getState().bindThreadSession("s-1", null, []);
    useStudioStore.getState().appendMessage({ id: "u1", role: "user", content: "问题", timestamp: "t" } as any);
    useStudioStore.getState().appendMessage({
      id: "a1", role: "assistant", content: "回答", timestamp: "t", isStreaming: true,
      toolCalls: [{ id: "tc-1", title: "run", status: "in_progress", rawOutput: "partial output" }],
    } as any);
    useStudioStore.getState().patchMessage("a1", (m) => ({ ...m, content: "回答（续）" }));

    // 切走（落盘的快照会冻结消息）再切回来：看到的是活的那份，不是快照
    useStudioStore.getState().newThread("codex");
    useStudioStore.getState().optimisticOpenSession("codex", "s-1", null, null);
    const a1 = view().messages.find((m) => m.id === "a1")!;
    expect(view().messages.map((m) => m.content)).toEqual(["问题", "回答（续）"]);
    expect(a1.isStreaming).toBe(true);
    expect(a1.toolCalls?.[0]).toMatchObject({ id: "tc-1", rawOutput: "partial output" });
  });

  it("keeps each session's running state, and lets two run at once", () => {
    // 会话一在跑
    useStudioStore.getState().newThread("codex");
    useStudioStore.getState().bindThreadSession("s-1", null, []);
    const first = activeKey(useStudioStore.getState());
    useStudioStore.getState().setSessionRunning(first, true);
    expect(running()["s-1"]).toBe(true);
    expect(view().running).toBe(true);

    // 切到会话二：会话一仍然在跑，只是视图不忙
    useStudioStore.getState().newThread("codex");
    useStudioStore.getState().bindThreadSession("s-2", null, []);
    expect(running()["s-1"]).toBe(true);
    expect(view().running).toBe(false);

    // 会话二也开始跑：两个会话同时在跑
    useStudioStore.getState().setSessionRunning(activeKey(useStudioStore.getState()), true);
    expect(running()).toMatchObject({ "s-1": true, "s-2": true });

    // 切回会话一：视图是忙的（它还在跑）
    useStudioStore.getState().optimisticOpenSession("codex", "s-1", null, null);
    expect(view().running).toBe(true);

    // 会话一跑完：只动它自己，会话二不受影响
    useStudioStore.getState().setSessionRunning(first, false);
    expect(running()["s-1"]).toBeUndefined();
    expect(running()["s-2"]).toBe(true);
  });

  it("an agent switch leaves the other agent's running session alone", () => {
    useStudioStore.getState().setActiveAgentId("codex");
    useStudioStore.getState().newThread("codex");
    useStudioStore.getState().bindThreadSession("s-1", null, []);
    useStudioStore.getState().setSessionRunning(activeKey(useStudioStore.getState()), true);

    useStudioStore.getState().setActiveAgentId("opencode");
    expect(view().running).toBe(false);
    expect(running()["s-1"]).toBe(true);
  });
});
