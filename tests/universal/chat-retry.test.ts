import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement as h, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { activeKey, sessionOf, useStudioStore } from "@/stores/useStudioStore";
import { useChatSend, isTransientSendError, stripRetryNotes } from "@/hooks/useChatSend";
import type { AgentSummary } from "@/lib/universal-api";
import { contextUsage, promptUsage, displayedPromptUsage } from "../fixtures/usage-sample";
import { setStudio, view } from "../helpers/studio";

const realFetch = globalThis.fetch;

function sseResponse(frames: unknown[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

interface HarnessOpts {
  onHandle: (fn: (text?: string) => Promise<void>) => void;
  resolveSession?: () => Promise<string | null>;
  retry?: { max?: number; delayMs?: (n: number) => number };
  chatBehavior: Array<"fail" | "ok" | "auth">;
  calls: string[];
  frames?: unknown[];
}

function Harness({ onHandle, resolveSession, retry, chatBehavior, calls }: HarnessOpts) {
  const qc = useQueryClient();
  const agentsRef = useRef<AgentSummary[]>([]);
  const { handleSend } = useChatSend({
    qc,
    agentsRef,
    resolveSession: resolveSession || (async () => "sess-1"),
    retry,
  });
  useEffect(() => {
    onHandle(handleSend);
  }, []);
  return null;
}

async function renderHarness(opts: Partial<HarnessOpts> & { calls: string[] }) {
  (globalThis as any).__chatAttempts = 0;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes("/agents/") && u.endsWith("/connect")) {
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }
    if (u.includes("/api/universal/chat")) {
      (globalThis as any).__chatAttempts += 1;
      const mode = opts.chatBehavior?.[(globalThis as any).__chatAttempts - 1] ?? "ok";
      if (mode === "fail") throw new TypeError("fetch failed");
      if (mode === "auth") {
        return { ok: false, status: 401, json: async () => ({ ok: false, error: "need auth", authRequired: true }) };
      }
      const tag = `ROUND${(globalThis as any).__chatAttempts}`;
      return sseResponse(opts.frames ?? [
        { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } } },
        { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: tag } } },
        { type: "done", stopReason: "end_turn" },
      ]);
    }
    throw new Error("unexpected fetch: " + u);
  }) as any;

  useStudioStore.getState().resetStudio();
  let send!: (text?: string) => Promise<void>;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      h(QueryClientProvider, { client: qc },
        h(Harness, {
          onHandle: (fn) => (send = fn),
          resolveSession: opts.resolveSession,
          retry: opts.retry,
          chatBehavior: opts.chatBehavior,
          calls: opts.calls,
        } as any))
    );
  });
  return { el, root, send };
}

describe("send retry policy", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("keeps OpenCode context separate from the completed turn total and preserves cost", async () => {
    const { root, el, send } = await renderHarness({ calls: [], frames: [
      { type: "update", update: { sessionUpdate: "usage_update", ...contextUsage } },
      { type: "done", stopReason: "end_turn", response: { usage: promptUsage } },
    ] });
    try {
      await act(async () => { await send("usage"); });
      const usage = view().messages.find(message => message.role === "assistant")?.usage;
      expect(usage).toMatchObject({ ...contextUsage, costScope: "session", ...displayedPromptUsage });
    } finally { root.unmount(); el.remove(); }
  });

  it("does not borrow the preceding turn's context or bill when done contains totals only", async () => {
    const { root, el, send } = await renderHarness({ calls: [], frames: [
      { type: "done", stopReason: "end_turn", response: { usage: promptUsage } },
    ] });
    try {
      useStudioStore.getState().setUsage(contextUsage);
      await act(async () => { await send("usage only"); });
      const usage = view().messages.find(message => message.role === "assistant")?.usage;
      expect(usage).toMatchObject({ used: 0, size: 0, totalTokens: promptUsage.totalTokens });
      expect(usage?.cost).toBeUndefined();
    } finally { root.unmount(); el.remove(); }
  });

  it("control: direct consume parses SSE in this file", async () => {
    globalThis.fetch = (async () => {
      return sseResponse([
        { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "直连" } } },
        { type: "done", stopReason: "end_turn" },
      ]);
    }) as any;
    const { consumeUniversalChat } = await import("@/lib/universal-api");
    const texts: string[] = [];
    await consumeUniversalChat({ agentId: "codex", prompt: "hi" }, { onTextChunk: (t) => texts.push(t) });
    expect(texts).toEqual(["直连"]);
  });

  it("keeps the prompt in the chat when the session cannot be resolved", async () => {
    // The composer is cleared as soon as the send begins. A failure must
    // leave the typed text visible in the conversation, not drop it.
    const { root, el, send } = await renderHarness({
      calls: [],
      resolveSession: async () => null,
    });
    try {
      await act(async () => { await send("别把我弄丢了"); });
      const user = view().messages.find((m) => m.role === "user");
      expect(user?.content).toBe("别把我弄丢了");
      const asst = view().messages.find((m) => m.role === "assistant");
      expect(asst?.content).toContain("连接异常");
    } finally { root.unmount(); el.remove(); }
  });

  it("gives the prompt back when the turn was aborted before it started", async () => {
    // An aborted send never appends the message, so the composer has to get
    // the text back — otherwise the user loses what they typed with no trace.
    const { root, el, send } = await renderHarness({
      calls: [],
      resolveSession: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    try {
      await act(async () => { await send("别把我弄丢了"); });
      // 草稿按会话存：还给"发起这一轮的那个会话"
      expect(view().draft).toBe("别把我弄丢了");
      expect(view().messages.some((m) => m.role === "user")).toBe(false);
    } finally { root.unmount(); el.remove(); }
  });

  it("queues a prompt typed while the agent is still working", async () => {
    const { root, el, send } = await renderHarness({ calls: [], chatBehavior: ["ok"] });
    try {
      useStudioStore.getState().setSessionRunning(activeKey(useStudioStore.getState()), true);
      await act(async () => { await send("排队的这条"); });
      const queued = view().queuedPrompts;
      expect(queued.map((q) => q.text)).toEqual(["排队的这条"]);
      // The prompt was not lost: it is neither in the chat nor in the composer.
      expect(view().messages.some((m) => m.role === "user")).toBe(false);
    } finally { root.unmount(); el.remove(); }
  });

  it("withdraws a queued prompt", async () => {
    const { root, el } = await renderHarness({ calls: [], chatBehavior: ["ok"] });
    try {
      const store = useStudioStore.getState();
      const id = store.enqueuePrompt("算了");
      expect(view().queuedPrompts).toHaveLength(1);
      useStudioStore.getState().removeQueuedPrompt(id);
      expect(view().queuedPrompts).toEqual([]);
    } finally { root.unmount(); el.remove(); }
  });

  it("sends the next queued prompt once the turn ends", async () => {
    const { root, el, send } = await renderHarness({ calls: [], chatBehavior: ["ok", "ok"] });
    try {
      useStudioStore.getState().enqueuePrompt("接着做这个");
      await act(async () => { await send("第一条"); });
      await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
      expect((globalThis as any).__chatAttempts).toBe(2);
      expect(view().queuedPrompts).toEqual([]);
      const prompts = view().messages.filter((m) => m.role === "user").map((m) => m.content);
      expect(prompts).toContain("接着做这个");
    } finally { root.unmount(); el.remove(); }
  });

  it("refuses a pending approval when a new message is typed", async () => {
    // The approval blocks the turn. A new message is the third way out: the
    // request is refused so the agent can continue, and the message is queued.
    const { root, el, send } = await renderHarness({ calls: [], chatBehavior: ["ok"] });
    try {
      // The request belongs to the session being typed in.
      setStudio({ sessionId: "s1" });
      useStudioStore.getState().setSessionRunning(activeKey(useStudioStore.getState()), true);
      useStudioStore.getState().addPermission({
        agentId: "codex", sessionId: "s1", permissionId: "perm-1", toolCall: { title: "写文件" }, options: [],
      } as any);
      await act(async () => { await send("换个方向"); });
      expect(useStudioStore.getState().pendingPerms).toEqual([]);
      expect(view().queuedPrompts.map((q) => q.text)).toEqual(["换个方向"]);
    } finally { root.unmount(); el.remove(); }
  });

  it("a turn keeps writing into its own session after the user switches away", async () => {
    const { root, el, send } = await renderHarness({ calls: [] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const enc = new TextEncoder();
    const frame = (f: unknown) => enc.encode(`data: ${JSON.stringify(f)}\n\n`);
    const chunk = (text: string) => frame({ type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
    const harnessFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => !String(url).includes("/api/universal/chat") ? harnessFetch(url, init) : new Response(new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(chunk("前半"));
        await gate;
        c.enqueue(chunk("后半"));
        c.enqueue(frame({ type: "done", stopReason: "end_turn" }));
        c.close();
      },
    }), { status: 200 })) as any;
    try {
      let sending!: Promise<void>;
      await act(async () => { sending = send("A 的问题"); });
      const keyA = activeKey(useStudioStore.getState());
      await act(async () => {
        await vi.waitFor(() => expect(view().messages.find((m) => m.role === "assistant")?.content).toBe("前半"));
      });

      // 用户切到另一个会话，A 那一轮还在后台跑
      await act(async () => { useStudioStore.getState().newThread("codex"); });
      await act(async () => { release(); await sending; });

      const a = sessionOf(useStudioStore.getState(), keyA);
      expect(a.messages.find((m) => m.role === "assistant")?.content).toBe("前半后半");
      expect(a.running).toBe(false);
      expect(a.activeTurn?.status).toBe("done");
      // 正在看的会话一点没被碰到
      expect(view().messages).toEqual([]);
      expect(view().activeTurn).toBeNull();
    } finally { release(); root.unmount(); el.remove(); }
  });

  it("control: happy path through handleSend lands text with no retry", async () => {
    const { root, el, send } = await renderHarness({
      calls: [],
      chatBehavior: ["ok"],
      retry: { max: 2, delayMs: () => 0 },
    });
    await send("hi");
    await new Promise((r) => setTimeout(r, 100));
    expect((globalThis as any).__chatAttempts).toBe(1);
    const asst = view().messages.find((m) => m.role === "assistant");
    expect(asst?.content).toContain("你好");
    root.unmount();
    el.remove();
  });

  it("keeps the first turn when resolving a session replaces the draft thread", async () => {
    const resolveSession = vi.fn(async () => {
      const store = useStudioStore.getState();
      // Real session resolution rejects creating a session while streaming.
      // It must still see a clean draft when the first send arrives early.
      expect(sessionOf(store).running).toBe(false);
      expect(sessionOf(store).messages).toHaveLength(0);
      store.newThread(store.activeAgentId);
      store.setSessionId("first-session");
      return "first-session";
    });
    const { root, el, send } = await renderHarness({ calls: [], resolveSession });
    try {
      await send("first prompt");
      const messages = view().messages;
      expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["first prompt"]);
      expect(messages.find((m) => m.role === "assistant")?.content).toContain("你好");
      expect(resolveSession).toHaveBeenCalledTimes(1);
    } finally { root.unmount(); el.remove(); }
  });

  it("does not dispatch a second prompt while the initial session is being resolved", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const resolveSession = vi.fn(async () => {
      entered();
      await pending;
      return "first-session";
    });
    const { root, el, send } = await renderHarness({ calls: [], resolveSession });
    try {
      const first = send("first prompt");
      await started;
      await send("duplicate prompt");
      release();
      await first;
      expect(resolveSession).toHaveBeenCalledTimes(1);
      expect((globalThis as any).__chatAttempts).toBe(1);
    } finally { release(); root.unmount(); el.remove(); }
  });

  it("keeps a visible error when initial session creation fails", async () => {
    const { root, el, send } = await renderHarness({ calls: [], resolveSession: async () => { throw new Error("session creation failed"); } });
    try {
      await send("first prompt");
      expect(view().messages.find((m) => m.role === "assistant")?.content).toContain("session creation failed");
      expect((globalThis as any).__chatAttempts).toBe(0);
    } finally { root.unmount(); el.remove(); }
  });

  it("classifies transient vs terminal errors", () => {
    expect(isTransientSendError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientSendError(new Error("Server 503: unavailable"))).toBe(true);
    expect(isTransientSendError(new Error("Socket hang up"))).toBe(true);
    expect(
      isTransientSendError(
        new Error(
          'Eligibility check failed: failed to get profile picture: Get "https://lh3.googleusercontent.com/a/...": EOF'
        )
      )
    ).toBe(true);
    expect(isTransientSendError(new Error("unexpected EOF"))).toBe(true);
    expect(isTransientSendError(new Error("read: connection reset by peer"))).toBe(true);
    expect(isTransientSendError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(false);
    expect(isTransientSendError({ authRequired: true, message: "need auth" })).toBe(false);
    expect(isTransientSendError(new Error("ordinary failure"))).toBe(false);
    expect(stripRetryNotes("hi\n\n> 🔁 连接中断，正在重试 (1/2)…\n\nmore")).toBe("hi\nmore");
    // Real shape: streamed text lands directly after the note's own newline.
    expect(stripRetryNotes("\n\n> 🔁 连接中断，正在重试 (1/2)…\n你好")).toBe("你好");
    // Regression: the note must never eat following content (no trailing blank).
    expect(stripRetryNotes("a\n\n> 🔁 连接中断，正在重试 (1/2)…\nb")).toBe("ab");
  });

  it("retries a dropped stream then strips the note on success", async () => {
    const { root, el, send } = await renderHarness({
      calls: [],
      chatBehavior: ["fail", "ok"],
      retry: { max: 2, delayMs: () => 0 },
    });
    // NOTE: send() runs outside act() — act() in this env stalls stream
    // consumption (verified); store assertions need no rendering anyway.
    await send("hi");
    await new Promise((r) => setTimeout(r, 100));
    expect((globalThis as any).__chatAttempts).toBe(2);
    // 给延迟的 store 写留出 macrotask 回合，再断言终态
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const msgs = view().messages;
    const asst = msgs.find((m) => m.role === "assistant");
    expect(asst?.content).toContain("你好");
    expect(asst?.content).not.toContain("🔁");
    expect(asst?.content).not.toContain("❌");
    expect(asst?.isStreaming).toBe(false);
    root.unmount();
    el.remove();
  });

  it("gives up after budget and leaves a clean error (no stale retry note)", async () => {
    const { root, el, send } = await renderHarness({
      calls: [],
      chatBehavior: ["fail", "fail", "fail"],
      retry: { max: 1, delayMs: () => 0 },
    });
    await act(async () => {
      await send("hi");
    });
    expect((globalThis as any).__chatAttempts).toBe(2);
    const msgs = view().messages;
    const asst = msgs.find((m) => m.role === "assistant");
    expect(asst?.content).toContain("❌");
    expect(asst?.content).not.toContain("🔁");
    root.unmount();
    el.remove();
  });

  it("never retries auth errors and opens the auth flow", async () => {
    const { root, el, send } = await renderHarness({
      calls: [],
      chatBehavior: ["auth"],
      retry: { max: 2, delayMs: () => 0 },
    });
    await act(async () => {
      await send("hi");
    });
    expect((globalThis as any).__chatAttempts).toBe(1);
    expect(useStudioStore.getState().authOpen).toBe(true);
    root.unmount();
    el.remove();
  });
});
