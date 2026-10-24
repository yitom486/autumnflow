import { describe, it, expect, beforeEach } from "vitest";
import { useStudioStore } from "../../src/stores/useStudioStore";
import { setStudio, view } from "../helpers/studio";

beforeEach(() => {
  useStudioStore.getState().resetStudio();
});

describe("useStudioStore", () => {
  it("holds connection and session view state", () => {
    const s = useStudioStore.getState();
    s.setActiveAgentId("claude");
    s.setSessionId("sess-1");
    s.setAuthOk("claude", true);
    const cur = useStudioStore.getState();
    expect(cur.activeAgentId).toBe("claude");
    expect(cur.sessionId).toBe("sess-1");
    expect(cur.authOk).toEqual({ claude: true });
  });

  it("appends and patches messages by id without rebuilding the tree", () => {
    const s = useStudioStore.getState();
    s.appendMessage({ id: "a", role: "assistant", content: "", timestamp: "t" });
    s.appendMessage({ id: "b", role: "user", content: "hi", timestamp: "t" });
    s.patchMessage("a", (m) => ({ ...m, content: m.content + "hello" }));
    s.patchMessage("b", { content: "hi!" });
    const msgs = view().messages;
    expect(msgs.map((m) => m.id)).toEqual(["a", "b"]);
    expect(msgs[0].content).toBe("hello");
    expect(msgs[1].content).toBe("hi!");
  });

  it("applies session results and resets thread state", () => {
    const s = useStudioStore.getState();
    s.applySessionResult({
      sessionId: "s1",
      modes: { currentModeId: "agent", availableModes: [] },
      configOptions: [{ id: "model" }],
      availableCommands: [{ name: "/status" }],
    });
    expect(useStudioStore.getState().sessionId).toBe("s1");
    expect(useStudioStore.getState().configOptions).toHaveLength(1);
    s.patchConfigOption({ id: "model", currentValue: "x" });
    expect(useStudioStore.getState().configOptions?.[0]).toMatchObject({ id: "model", currentValue: "x" });
    s.resetThread();
    const cur = useStudioStore.getState();
    expect(view().messages).toEqual([]);
    expect(cur.sessionId).toBe("s1"); // thread reset keeps the session
    expect(cur.configOptions).toBeNull();
  });

  it("tracks pending approvals", () => {
    const s = useStudioStore.getState();
    s.addPermission({ permissionId: "p1", agentId: "codex", sessionId: "s", toolCall: {}, options: [] });
    expect(useStudioStore.getState().pendingPerms).toHaveLength(1);
    s.removePermission("p1");
    expect(useStudioStore.getState().pendingPerms).toHaveLength(0);
  });

  it("clears the previous agent's live session/messages on an agent switch", () => {
    const s = useStudioStore.getState();
    s.setActiveAgentId("deepseek");
    s.newThread("deepseek", "D:/pythonProject/pyqt");
    s.bindThreadSession("deep-session", "D:/pythonProject/pyqt");
    s.setMessages([{ id: "u1", role: "user", content: "hello", timestamp: "t" }]);
    const deepThreadId = useStudioStore.getState().activeThreadId!;

    s.setActiveAgentId("opencode");
    const cur = useStudioStore.getState();
    expect(cur.activeAgentId).toBe("opencode");
    expect(cur.sessionId).toBeNull();
    expect(view().messages).toEqual([]);
    expect(cur.activeThreadId).toBeNull();
    // The old thread record is preserved for later restore.
    expect(cur.threads[deepThreadId]?.agentId).toBe("deepseek");
    expect(cur.threads[deepThreadId]?.sessionId).toBe("deep-session");
  });

  it("makes a stale thread historical without keeping its dead id live", () => {
    const s = useStudioStore.getState();
    s.setActiveAgentId("opencode");
    s.newThread("opencode", "D:/pythonProject/pyqt");
    s.bindThreadSession("a4c692a5-64d7-4bab-87e6-7cba3856bfd6", "D:/pythonProject/pyqt");
    s.setMessages([{ id: "u1", role: "user", content: "hello", timestamp: "t" }]);
    const threadId = useStudioStore.getState().activeThreadId!;

    s.markThreadStale();
    const cur = useStudioStore.getState();
    expect(cur.sessionId).toBeNull();
    expect(cur.threads[threadId]?.stale).toBe(true);
    expect(cur.threads[threadId]?.sessionId).toBe("a4c692a5-64d7-4bab-87e6-7cba3856bfd6");

    // A later snapshot must not erase the historical id or the stale marker.
    cur.snapshotThread();
    expect(useStudioStore.getState().threads[threadId]?.sessionId).toBe(
      "a4c692a5-64d7-4bab-87e6-7cba3856bfd6"
    );
    expect(useStudioStore.getState().threads[threadId]?.stale).toBe(true);
  });

  it("ignores a session result that belongs to the agent the user already left", () => {
    const s = useStudioStore.getState();
    s.setActiveAgentId("opencode");
    s.applySessionResult({ sessionId: "deepseek-uuid" }, "deepseek");
    expect(useStudioStore.getState().sessionId).toBeNull();
    expect(useStudioStore.getState().models).toBeNull();
  });

  it("persists a human session title derived from the first user turn", () => {
    const s = useStudioStore.getState();
    s.setActiveAgentId("opencode");
    s.newThread("opencode", "D:/title-only-test");
    s.setMessages([
      { id: "u1", role: "user", content: "这个项目算是一个pyqt的一个demo项目是吗请问", timestamp: "t" },
      { id: "a1", role: "assistant", content: "是的。", timestamp: "t" },
    ]);
    s.snapshotThread();
    const thread = useStudioStore.getState().threads[useStudioStore.getState().activeThreadId!];
    expect(thread.title).toBe("这个项目算是一个pyqt的一个demo项目是吗请问");
    // Restoring the thread restores the header title as well.
    s.restoreThread("opencode", "D:/title-only-test");
    expect(view().sessionInfo?.title).toBe(
      "这个项目算是一个pyqt的一个demo项目是吗请问"
    );
  });

  it("persists and restores an active turn pointer", () => {
    const s = useStudioStore.getState();
    s.setActiveAgentId("opencode");
    s.newThread("opencode", "D:/active-turn-test");
    s.setMessages([
      { id: "u1", role: "user", content: "run it", timestamp: "t" },
      { id: "a1", role: "assistant", content: "partial", timestamp: "t", turnId: "turn-1" },
    ]);
    s.setActiveTurn({
      turnId: "turn-1",
      lastSeq: 17,
      status: "running",
      assistantId: "a1",
      startedAt: 123,
    });
    s.snapshotThread();
    s.restoreThread("opencode", "D:/active-turn-test");
    expect(view().activeTurn).toMatchObject({
      turnId: "turn-1",
      lastSeq: 17,
      status: "running",
      assistantId: "a1",
    });
  });

  it("hydrates the last-known model catalog on agent switch (cold-start picker)", () => {
    localStorage.removeItem("acp_model_catalog_v1");
    const s = useStudioStore.getState();
    s.setActiveAgentId("opencode");
    s.setModels({ currentModelId: "opencode/DeepSeek V4 Flash", availableModels: [] });
    s.setConfigOptions([
      { id: "model", name: "模型", options: [{ value: "opencode/DeepSeek V4 Flash", name: "DeepSeek V4 Flash" }] },
    ]);
    s.setActiveAgentId("codex");
    expect(useStudioStore.getState().models).toBeNull();
    s.setActiveAgentId("opencode");
    expect(useStudioStore.getState().models?.currentModelId).toBe("opencode/DeepSeek V4 Flash");
    expect(useStudioStore.getState().configOptions?.[0]?.options).toHaveLength(1);
    localStorage.removeItem("acp_model_catalog_v1");
  });
});
