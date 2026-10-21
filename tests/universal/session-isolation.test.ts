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

  it("remembers which session the running turn belongs to", () => {
    useStudioStore.getState().newThread("codex");
    useStudioStore.getState().bindThreadSession("s-1", null, []);
    useStudioStore.getState().setStreaming(true);
    expect(useStudioStore.getState().streamingSessionId).toBe("s-1");

    // 切到别的会话：那边不该以为自己忙
    useStudioStore.getState().newThread("codex");
    useStudioStore.getState().bindThreadSession("s-2", null, []);
    const st = useStudioStore.getState();
    const busy = st.isStreaming && (!st.streamingSessionId || st.streamingSessionId === st.sessionId);
    expect(busy).toBe(false);
  });
});
