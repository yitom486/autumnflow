import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverActiveTurn } from "../../src/hooks/useTurnRecovery";
import { useStudioStore } from "../../src/stores/useStudioStore";
import { contextUsage, promptUsage, displayedPromptUsage } from "../fixtures/usage-sample";

const realFetch = globalThis.fetch;

function sse(frames: Array<{ id: number; data: unknown }>): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const frame of frames) {
          c.enqueue(enc.encode(`id: ${frame.id}\ndata: ${JSON.stringify(frame.data)}\n\n`));
        }
        c.close();
      },
    }),
    { status: 200 }
  );
}

beforeEach(() => {
  useStudioStore.getState().resetStudio();
  useStudioStore.getState().setActiveAgentId("opencode");
  useStudioStore.getState().newThread("opencode", "D:/recovery-test");
  useStudioStore.getState().setMessages([
    { id: "u1", role: "user", content: "hello", timestamp: "t" },
    { id: "a1", role: "assistant", content: "hello", timestamp: "t", turnId: "turn-r" },
  ]);
  useStudioStore.getState().setActiveTurn({
    turnId: "turn-r",
    lastSeq: 2,
    status: "running",
    assistantId: "a1",
    startedAt: Date.now(),
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("turn recovery", () => {
  it("keeps context and prompt totals separate when following a finished journal turn", async () => {
    globalThis.fetch = vi.fn(async () => sse([
      { id: 3, data: { type: "update", update: { sessionUpdate: "usage_update", ...contextUsage } } },
      { id: 4, data: { type: "done", stopReason: "end_turn", response: { usage: promptUsage } } },
    ])) as unknown as typeof fetch;
    await recoverActiveTurn(useStudioStore.getState().activeTurn!, "a1");
    expect(useStudioStore.getState().messages.find(message => message.id === "a1")?.usage).toMatchObject({
      ...contextUsage, costScope: "session", ...displayedPromptUsage,
    });
  });
  it("follows from lastSeq and settles without resending the prompt", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      return sse([
        {
          id: 3,
          data: {
            type: "update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } },
          },
        },
        { id: 4, data: { type: "done", stopReason: "end_turn" } },
      ]);
    }) as unknown as typeof fetch;

    await recoverActiveTurn(useStudioStore.getState().activeTurn!, "a1");
    const st = useStudioStore.getState();
    expect(calls[0]).toContain("/api/universal/chat/turn-r/follow?after=2");
    expect(st.messages.find((m) => m.id === "a1")?.content).toBe("hello world");
    expect(st.activeTurn).toMatchObject({ turnId: "turn-r", status: "done", lastSeq: 4 });
  });

  it("clears the partial bubble when the server reports a replay gap", async () => {
    globalThis.fetch = vi.fn(async () =>
      sse([
        { id: 0, data: { type: "reset", reason: "gap", firstSeq: 10, lastSeq: 11 } },
        {
          id: 10,
          data: {
            type: "update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "rebuilt" } },
          },
        },
        { id: 11, data: { type: "done", stopReason: "end_turn" } },
      ])
    ) as unknown as typeof fetch;
    await recoverActiveTurn(useStudioStore.getState().activeTurn!, "a1");
    const st = useStudioStore.getState();
    expect(st.messages.find((m) => m.id === "a1")?.content).toContain("rebuilt");
    expect(st.messages.find((m) => m.id === "a1")?.content).toContain("早期事件已被清理");
    expect(st.activeTurn?.status).toBe("done");
  });

  it("marks expired turns as interrupted instead of silently succeeding", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ ok: false, error: "unknown or expired turn" }, { status: 404 })) as unknown as typeof fetch;
    await recoverActiveTurn(useStudioStore.getState().activeTurn!, "a1");
    const st = useStudioStore.getState();
    expect(st.activeTurn?.status).toBe("interrupted");
    expect(st.messages.find((m) => m.id === "a1")?.content).toContain("已过期");
  });
});
