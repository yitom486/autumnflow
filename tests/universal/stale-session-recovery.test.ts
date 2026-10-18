// @vitest-environment node
/**
 * A restored thread can carry a session id the agent no longer knows. The chat
 * route must recover instead of failing the user's message with
 * "Invalid params: unknown session": first reattach with session/resume (keeps
 * context), then create a session as the last resort.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { chatRouter, isUnknownSessionError } from "../../server/universal/http/chat";
import { universalRegistry } from "../../server/universal/registry";

function staleSessionError(sessionId: string) {
  const err = new Error(`Invalid params: unknown session: ${sessionId}`) as Error & { code?: number };
  err.code = -32602;
  return err;
}

interface FakeOptions {
  resume?: (sessionId: string) => Promise<unknown>;
  failFirstPrompt?: boolean;
}

function fakeConnection(options: FakeOptions = {}) {
  const seen: string[] = [];
  let promptCalls = 0;
  return {
    connect: vi.fn(async () => ({})),
    newSession: vi.fn(async () => ({ sessionId: "fresh-session" })),
    resumeSession: vi.fn(
      options.resume ??
        (async (sessionId: string) => {
          throw staleSessionError(sessionId);
        }),
    ),
    prompt: vi.fn(async (sessionId: string, _blocks: unknown, onEvent: (evt: unknown) => void) => {
      seen.push(sessionId);
      promptCalls += 1;
      if (sessionId === "stale-session" && (!options.resume || options.failFirstPrompt)) {
        if (promptCalls === 1) throw staleSessionError(sessionId);
      }
      onEvent({
        type: "update",
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      });
      return { stopReason: "end_turn" };
    }),
    status: () => ({ quota: null }),
    seen,
  };
}

function postChat(body: Record<string, unknown>) {
  return chatRouter.request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("isUnknownSessionError", () => {
  it("识别 ACP 的 unknown session（-32602）", () => {
    expect(isUnknownSessionError(staleSessionError("abc"))).toBe(true);
    expect(isUnknownSessionError(new Error("session not found"))).toBe(true);
  });

  it("不把其它错误当会话失效", () => {
    expect(isUnknownSessionError(new Error("no API key for provider route"))).toBe(false);
    expect(isUnknownSessionError(new Error("Internal error: turn failed"))).toBe(false);
    expect(isUnknownSessionError(new Error("session busy: previous prompt still running (409)"))).toBe(false);
  });
});

describe("chat stale-session recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("先用 session/resume 接回，成功则保留原会话", async () => {
    const conn = fakeConnection({ resume: async () => ({}), failFirstPrompt: true });
    vi.spyOn(universalRegistry, "connFor").mockReturnValue(conn as never);

    const res = await postChat({
      agentId: "deepseek",
      sessionId: "stale-session",
      prompt: "hi",
      turnId: "turn-stale-resume",
    });
    const body = await res.text();

    expect(conn.resumeSession).toHaveBeenCalledTimes(1);
    expect(conn.newSession).not.toHaveBeenCalled();
    expect(conn.seen).toEqual(["stale-session", "stale-session"]);
    expect(body).toContain('"type":"done"');
    expect(body).not.toContain("unknown session");
  });

  it("resume 也拒绝时新建会话并重试同一轮", async () => {
    const conn = fakeConnection();
    vi.spyOn(universalRegistry, "connFor").mockReturnValue(conn as never);

    const res = await postChat({
      agentId: "deepseek",
      sessionId: "stale-session",
      prompt: "hi",
      turnId: "turn-stale-new",
    });
    const body = await res.text();

    expect(conn.resumeSession).toHaveBeenCalledTimes(1);
    expect(conn.newSession).toHaveBeenCalledTimes(1);
    expect(conn.seen).toEqual(["stale-session", "fresh-session"]);
    // The client learns the replacement id from the second start frame.
    expect(body).toContain("fresh-session");
    expect(body).toContain('"type":"done"');
  });

  it("非会话失效的错误不重试", async () => {
    const conn = fakeConnection();
    conn.prompt = vi.fn(async () => {
      throw new Error("Internal error: turn failed");
    }) as never;
    vi.spyOn(universalRegistry, "connFor").mockReturnValue(conn as never);

    const res = await postChat({
      agentId: "deepseek",
      sessionId: "stale-session",
      prompt: "hi",
      turnId: "turn-stale-no-retry",
    });
    const body = await res.text();

    expect(conn.resumeSession).not.toHaveBeenCalled();
    expect(conn.newSession).not.toHaveBeenCalled();
    expect(body).toContain("Internal error");
  });
});
