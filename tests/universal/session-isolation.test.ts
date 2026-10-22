import { describe, it, expect, afterEach } from "vitest";
import { useStudioStore } from "@/stores/useStudioStore";

// 会话之间必须互不影响：一个会话在跑，另一个会话照发不误，排队也不会串。
describe("session isolation", () => {
  afterEach(() => {
    useStudioStore.getState().resetStudio();
  });

  it("queues a prompt on the session that typed it, not on another one", () => {
    const store = useStudioStore.getState();
    store.newThread("codex");
    const first = useStudioStore.getState().activeThreadId!;
    useStudioStore.getState().setSessionInfo({ sessionId: "s-1" });

    useStudioStore.getState().enqueuePrompt("A 会话排队的");
    expect(useStudioStore.getState().threads[first]?.queuedPrompts?.map((q) => q.text)).toEqual(["A 会话排队的"]);

    // 切到另一个会话
    useStudioStore.getState().newThread("codex");
    const second = useStudioStore.getState().activeThreadId!;
    expect(second).not.toBe(first);
    expect(useStudioStore.getState().threads[second]?.queuedPrompts || []).toEqual([]);

    // 在新会话排队 → 落在新会话上，A 会话的队列原封不动
    useStudioStore.getState().enqueuePrompt("B 会话排队的");
    expect(useStudioStore.getState().threads[second]?.queuedPrompts?.map((q) => q.text)).toEqual(["B 会话排队的"]);
    expect(useStudioStore.getState().threads[first]?.queuedPrompts?.map((q) => q.text)).toEqual(["A 会话排队的"]);
  });

  it("keeps the session thread as the full live state, not a snapshot", () => {
    useStudioStore.getState().newThread("codex");
    const tid = useStudioStore.getState().activeThreadId!;
    useStudioStore.getState().bindThreadSession("s-1", null, []);
    useStudioStore.getState().appendMessage({ id: "u1", role: "user", content: "问题", timestamp: "t" } as any);
    useStudioStore.getState().appendMessage({ id: "a1", role: "assistant", content: "回答", timestamp: "t", isStreaming: true } as any);
    // 流式追加：视图和线程一起更新
    useStudioStore.getState().patchMessage("a1", (m) => ({ ...m, content: "回答（续）" }));

    const thread = useStudioStore.getState().threads[tid];
    expect(thread.messages.map((m) => m.content)).toEqual(["问题", "回答（续）"]);
    expect(thread.messages[1].isStreaming).toBe(true);

    // 切走再切回来：看到的是同一份全量状态
    useStudioStore.getState().newThread("codex");
    useStudioStore.getState().optimisticOpenSession("codex", "s-1", null, null);
    expect(useStudioStore.getState().messages.map((m) => m.content)).toEqual(["问题", "回答（续）"]);
  });

  it("keeps each session's running state, and lets two run at once", () => {
    // 会话一在跑
    useStudioStore.getState().newThread("codex");
    useStudioStore.getState().bindThreadSession("s-1", null, []);
    useStudioStore.getState().setStreaming(true);
    expect(useStudioStore.getState().runningSessions["s-1"]).toBe(true);
    expect(useStudioStore.getState().isStreaming).toBe(true);

    // 切到会话二：会话一仍然在跑，只是视图不忙
    useStudioStore.getState().newThread("codex");
    useStudioStore.getState().bindThreadSession("s-2", null, []);
    expect(useStudioStore.getState().runningSessions["s-1"]).toBe(true);
    expect(useStudioStore.getState().isStreaming).toBe(false);

    // 会话二也开始跑：两个会话同时在跑
    useStudioStore.getState().setStreaming(true);
    expect(useStudioStore.getState().runningSessions).toMatchObject({ "s-1": true, "s-2": true });

    // 切回会话一：视图是忙的（它还在跑）
    useStudioStore.getState().optimisticOpenSession("codex", "s-1", null, null);
    expect(useStudioStore.getState().isStreaming).toBe(true);

    // 会话一跑完：只动它自己，会话二不受影响
    useStudioStore.getState().setStreaming(false);
    expect(useStudioStore.getState().runningSessions["s-1"]).toBeUndefined();
    expect(useStudioStore.getState().runningSessions["s-2"]).toBe(true);
  });
});
