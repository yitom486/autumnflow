import { describe, it, expect } from "vitest";
import { appSessionList } from "@/lib/app-sessions";
import type { ChatThread } from "@/lib/threads";

// 会话与运行时一对一绑定：列表要能同时看到不同运行时的会话，并标出每个
// 会话绑的是谁、哪个正在跑。
describe("app session list", () => {
  const thread = (id: string, agentId: string, sessionId: string | null, updatedAt: number): ChatThread =>
    ({
      id,
      agentId,
      sessionId,
      messages: [{ id: `${id}-m`, role: "user", content: "hi", timestamp: updatedAt } as any],
      updatedAt,
    }) as ChatThread;

  const threads = {
    t1: thread("t1", "codex", "s-codex", 1000),
    t2: thread("t2", "opencode", "s-opencode", 2000),
    t3: thread("t3", "opencode", null, 3000), // 草稿：还没绑定会话
  };

  const agentTitle = (id: string) => (id === "codex" ? "Codex" : "OpenCode");

  it("lists the sessions of every runtime the app used", () => {
    const list = appSessionList({
      threads,
      agentSessions: [],
      activeAgentId: "codex",
      agentTitle,
    });
    expect(list.map((s) => s.sessionId).sort()).toEqual(["s-codex", "s-opencode"]);
    expect(list.find((s) => s.sessionId === "s-codex")?.agentLabel).toBe("Codex");
    expect(list.find((s) => s.sessionId === "s-opencode")?.agentLabel).toBe("OpenCode");
  });

  it("merges the agent side history of the current runtime", () => {
    const list = appSessionList({
      threads,
      agentSessions: [{ sessionId: "s-remote", title: "远端会话", updatedAt: "2026-01-01T00:00:00.000Z" }],
      activeAgentId: "codex",
      agentTitle,
    });
    expect(list.map((s) => s.sessionId)).toContain("s-remote");
    expect(list.find((s) => s.sessionId === "s-remote")?.agentId).toBe("codex");
  });

  it("marks the session whose turn is still running", () => {
    const list = appSessionList({
      threads,
      agentSessions: [],
      activeAgentId: "codex",
      agentTitle,
      streamingSessionId: "s-opencode",
    });
    expect(list.find((s) => s.sessionId === "s-opencode")?.running).toBe(true);
    expect(list.find((s) => s.sessionId === "s-codex")?.running).toBe(false);
  });
});
