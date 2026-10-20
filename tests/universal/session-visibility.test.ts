import { describe, expect, it } from "vitest";
import { visibleSessions } from "../../src/lib/session-visibility";
import type { SessionItem } from "../../src/components/universal/Sidebar";
import type { ChatThread } from "../../src/lib/threads";

function thread(sessionId: string, messages: ChatThread["messages"]): ChatThread {
  return { agentId: "e2e-agent", sessionId, messages, updatedAt: Date.now() } as ChatThread;
}

const base: SessionItem[] = [
  { sessionId: "s1", title: "草稿", origin: "created", kind: "main" },
  { sessionId: "s2", title: "外部已有会话", origin: "imported", kind: "main" },
];

describe("session list visibility", () => {
  it("hides an app-owned empty draft", () => {
    const visible = visibleSessions(base, { t1: thread("s1", []) }, "e2e-agent");
    expect(visible.map(s => s.sessionId)).toEqual(["s2"]);
  });

  it("keeps an imported reference even when its local thread is empty", () => {
    // The app has not loaded the agent-side transcript yet.
    const visible = visibleSessions(base, { t2: thread("s2", []) }, "e2e-agent");
    expect(visible.map(s => s.sessionId)).toContain("s2");
    expect(visible.find(s => s.sessionId === "s2")?.title).toBe("外部已有会话");
  });

  it("keeps an app-owned session that has a conversation", () => {
    const visible = visibleSessions(
      base,
      { t1: thread("s1", [{ id: "m1", role: "user", content: "hi", timestamp: "t" }]) },
      "e2e-agent"
    );
    expect(visible.map(s => s.sessionId)).toEqual(["s1", "s2"]);
  });

  it("hides an app-owned row with a default title and no local thread", () => {
    const visible = visibleSessions(
      [{ sessionId: "s3", title: "New session", origin: "created", kind: "main" }],
      {},
      "e2e-agent"
    );
    expect(visible).toEqual([]);
  });

  it("ignores threads of another agent", () => {
    const other = { agentId: "other", sessionId: "s1", messages: [], updatedAt: Date.now() } as ChatThread;
    const visible = visibleSessions(base, { t1: other }, "e2e-agent");
    // s1 has no local thread for this agent and a non-default title: it stays.
    expect(visible.map(s => s.sessionId)).toEqual(["s1", "s2"]);
  });
});
