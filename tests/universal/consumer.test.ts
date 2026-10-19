import { describe, it, expect, vi, afterEach } from "vitest";
import {
  pickUsageExtras,
  mergePromptUsage,
  consumeUniversalChat,
  buildTranscriptFromReplay,
  parseModelId,
  findConfigOption,
  configCurrentValue,
  flattenConfigOptions,
} from "../../src/lib/universal-api";
import { isTransientSendError } from "../../src/hooks/useChatSend";
import { contextUsage, promptUsage, displayedPromptUsage } from "../fixtures/usage-sample";

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

function sseSequenced(frames: Array<{ id: number; data: unknown }>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`id: ${f.id}\ndata: ${JSON.stringify(f.data)}\n\n`));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("consumeUniversalChat (v1 full updates)", () => {
  it("parses text/thought/tool/plan/usage/permission/done", async () => {
    const frames = [
      { type: "start", sessionId: "sess-1" },
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } } },
      { type: "update", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } },
      { type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read", status: "pending" } },
      { type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" } },
      { type: "update", update: { sessionUpdate: "plan", entries: [{ content: "step1", status: "in_progress" }] } },
      { type: "update", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "/status" }] } },
      { type: "update", update: { sessionUpdate: "current_mode_update", currentModeId: "agent" } },
      { type: "update", update: { sessionUpdate: "usage_update", used: 100, size: 200 } },
      { type: "permission_request", agentId: "codex", sessionId: "sess-1", permissionId: "perm-1", toolCall: {}, options: [] },
      { type: "activity", kind: "fs_read", detail: { path: "/tmp/a.txt" } },
      { type: "update", update: { sessionUpdate: "plan_update", plan: { entries: [{ content: "s", status: "completed" }] } } },
      { type: "update", update: { sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" } },
      { type: "done", sessionId: "sess-1", stopReason: "end_turn" },
    ];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => sseResponse(frames)) as unknown as typeof fetch;

    const seen: string[] = [];
    const out = await consumeUniversalChat(
      { agentId: "codex", prompt: "hi" },
      {
        onSessionId: (s) => seen.push("sid:" + s),
        onTextChunk: (t) => seen.push("text:" + t),
        onThoughtChunk: (t) => seen.push("thought:" + t),
        onToolCall: (c) => seen.push("tool:" + c.id),
        onToolCallUpdate: (c) => seen.push("toolupd:" + c.id + ":" + c.status),
        onPlan: (e) => seen.push("plan:" + e.length),
        onAvailableCommands: (c) => seen.push("cmds:" + c.length),
        onModeUpdate: (m) => seen.push("mode:" + m),
        onUsage: (u) => seen.push(`usage:${u.used}/${u.size}`),
        onPermissionRequest: (p) => seen.push("perm:" + p.permissionId),
        onActivity: (a) => seen.push("activity:" + a.kind),
        onDone: (s) => seen.push("done:" + s),
      }
    );
    expect(out.stopReason).toBe("end_turn");
    expect(seen).toContain("text:hello ");
    expect(seen).toContain("thought:thinking");
    expect(seen).toContain("tool:t1");
    expect(seen).toContain("toolupd:t1:running");
    expect(seen).toContain("plan:1");
    expect(seen).toContain("usage:100/200");
    expect(seen).toContain("perm:perm-1");
    expect(seen).toContain("activity:fs_read");
    expect(seen).toContain("activity:compaction_update");
    expect(seen).toContain("done:end_turn");
  });

  it("parses SSE ids for reconnect and marks server errors terminal", async () => {
    let requestBody: any = null;
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String((init as RequestInit)?.body || "{}"));
      return sseSequenced([
        { id: 11, data: { type: "start", sessionId: "s1" } },
        { id: 12, data: { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } },
        { id: 13, data: { type: "error", message: "boom" } },
      ]);
    }) as unknown as typeof fetch;

    const seqs: number[] = [];
    let terminal: any = null;
    const out = await consumeUniversalChat(
      { agentId: "codex", prompt: "hi", turnId: "turn-x", afterSeq: 10 },
      {
        onSequence: (seq) => seqs.push(seq),
        onError: (err) => (terminal = err),
      }
    );
    expect(requestBody).toMatchObject({ turnId: "turn-x", afterSeq: 10 });
    expect(seqs).toEqual([11, 12, 13]);
    expect(out.lastEventId).toBe(13);
    expect(terminal?.message).toBe("boom");
    expect(terminal?.terminal).toBe(true);
    expect(isTransientSendError(terminal)).toBe(false);
  });

  it("uses GET follow in follow mode instead of re-posting the prompt", async () => {
    let url = "";
    globalThis.fetch = vi.fn(async (input) => {
      url = String(input);
      return sseSequenced([{ id: 1, data: { type: "done", stopReason: "end_turn" } }]);
    }) as unknown as typeof fetch;
    await consumeUniversalChat(
      { agentId: "codex", prompt: "must-not-resend", turnId: "turn-follow", afterSeq: 3 },
      {},
      undefined,
      { follow: true }
    );
    expect(url).toContain("/api/universal/chat/turn-follow/follow?after=3");
  });

  it("treats a clean EOF without done as a transient interruption", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseSequenced([
        { id: 1, data: { type: "start", sessionId: "s1" } },
        { id: 2, data: { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } } } },
      ])
    ) as unknown as typeof fetch;
    const errors: Error[] = [];
    await expect(
      consumeUniversalChat(
        { agentId: "codex", prompt: "hi", turnId: "turn-eof" },
        { onError: (err) => errors.push(err) }
      )
    ).rejects.toThrow("unexpected eof");
    expect(errors.some((err) => /unexpected eof/.test(err.message))).toBe(true);
  });

  it("rebuilds transcripts from session/load replay", () => {
    const t = buildTranscriptFromReplay([
      { sessionUpdate: "user_message_chunk", messageId: "m1", content: { type: "text", text: "hello" } },
      { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "hi " } },
      { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "there" } },
      { sessionUpdate: "agent_thought_chunk", messageId: "m2", content: { type: "text", text: "hmm" } },
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
      { sessionUpdate: "plan", entries: [{ content: "step", status: "completed" }] },
      { sessionUpdate: "usage_update", used: 10, size: 100 },
      { sessionUpdate: "available_commands_update", availableCommands: [{ name: "/status" }] },
      { sessionUpdate: "current_mode_update", currentModeId: "agent" },
    ]);
    expect(t.messages).toHaveLength(2);
    expect(t.messages[0]).toMatchObject({ role: "user", content: "hello" });
    expect(t.messages[1]).toMatchObject({
      role: "assistant",
      content: "hi there",
      thought: "hmm",
    });
    expect(t.messages[1].toolCalls?.[0]).toMatchObject({ id: "t1", status: "completed" });
    expect(t.plan).toHaveLength(1);
    expect(t.usage).toMatchObject({ used: 10, size: 100 });
    expect(t.availableCommands).toHaveLength(1);
    expect(t.currentModeId).toBe("agent");
  });

  it("forwards usage breakdown from _meta without ever summing", async () => {
    const frames = [
      // agy-style: per-step input snapshot + breakdown under _meta
      { type: "update", update: { sessionUpdate: "usage_update", used: 5000, size: 200000, _meta: { inputTokens: 5000, outputTokens: 300, totalTokens: 5300 } } },
      // top level wins on conflict; later snapshots overwrite (replace, not add)
      { type: "update", update: { sessionUpdate: "usage_update", used: 1200, size: 200000, inputTokens: 1200, _meta: { inputTokens: 9999 } } },
      { type: "done", stopReason: "end_turn" },
    ];
    globalThis.fetch = vi.fn(async () => sseResponse(frames)) as unknown as typeof fetch;
    const seen: any[] = [];
    await consumeUniversalChat(
      { agentId: "codex", prompt: "hi" },
      { onUsage: (u) => seen.push(u) }
    );
    expect(seen[0]).toMatchObject({ used: 5000, size: 200000, inputTokens: 5000, outputTokens: 300, totalTokens: 5300 });
    // 压缩后变小直接采用（替换语义，无加法）
    expect(seen[1]).toMatchObject({ used: 1200, size: 200000, inputTokens: 1200 });
  });

  it("parses catalog model ids and maps config roles", () => {
    expect(parseModelId("gpt-5.6-luna[xhigh]")).toEqual({ model: "gpt-5.6-luna", effort: "xhigh" });
    expect(parseModelId("plain-model")).toEqual({ model: "plain-model" });
    const opts = [
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "agent", options: [] },
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "gpt-5.6-luna", options: [] },
      { id: "reasoning_effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: "xhigh", options: [] },
    ];
    expect(findConfigOption(opts, "model")?.id).toBe("model");
    expect(findConfigOption(opts, "thinking")?.id).toBe("reasoning_effort");
    expect(findConfigOption(opts, "permission")?.id).toBe("mode");
    expect(configCurrentValue(opts[0])).toBe("agent");
    expect(configCurrentValue({ id: "x", name: "x", type: "select", currentValue: { value: "v" } })).toBe("v");
    expect(configCurrentValue({ id: "arr", name: "arr", type: "select", currentValue: ["a", "b"] })).toBe('["a","b"]');

    // OpenCode dynamic effort option
    const openCodeOpts = [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "opencode-go/muse-spark-1.3-contributor" },
      { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "minimal" },
      { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "build" },
    ];
    expect(findConfigOption(openCodeOpts, "thinking")?.id).toBe("effort");

    // DeepSeek grouped options
    const deepSeekGroups = [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          { value: '["deepseek-official","deepseek-flash"]', name: "DeepSeek-V41-Flash" },
          { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
        ],
      },
    ];
    const flat = flattenConfigOptions(deepSeekGroups);
    expect(flat).toHaveLength(2);
    expect(flat[0]).toEqual({
      value: '["deepseek-official","deepseek-flash"]',
      name: "DeepSeek-V41-Flash",
      group: "DeepSeek",
      description: undefined,
    });
    expect(flat[1].value).toBe('["deepseek-official","deepseek-v4-pro"]');
  });

  it("handles subagent_active activity event with child session metadata", async () => {
    const frames = [
      { type: "start", sessionId: "parent-sess" },
      {
        type: "activity",
        kind: "subagent_active",
        detail: {
          childId: "child-subagent-1",
          title: "图像生成智能体",
          updateType: "tool_call",
        },
      },
      { type: "done", sessionId: "parent-sess", stopReason: "end_turn" },
    ];
    globalThis.fetch = vi.fn(async () => sseResponse(frames)) as unknown as typeof fetch;

    let subagentEvent: any = null;
    await consumeUniversalChat(
      { agentId: "codex", sessionId: "parent-sess", prompt: "generate icon" },
      {
        onActivity: (a) => {
          if (a.kind === "subagent_active") subagentEvent = a.detail;
        },
      }
    );
    expect(subagentEvent).toEqual({
      childId: "child-subagent-1",
      title: "图像生成智能体",
      updateType: "tool_call",
    });
  });

  it("handles state_update, tool_call_content_chunk, agent_thought, and maps in_progress tool calls to running", async () => {
    const frames = [
      { type: "start", sessionId: "sess-2" },
      { type: "update", update: { sessionUpdate: "state_update", state: "running" } },
      { type: "update", update: { sessionUpdate: "notice", message: "Repository indexing completed", severity: "info" } },
      { type: "update", update: { sessionUpdate: "agent_thought", content: "deep thinking step" } },
      { type: "update", update: { sessionUpdate: "agent_message", content: [{ type: "text", text: "block 1 " }, { type: "text", text: "block 2" }] } },
      // ACP mapAgyEvent emits status: "in_progress" for running tools
      { type: "update", update: { sessionUpdate: "tool_call", toolCallId: "tc-cmd", title: "Run command", kind: "execute", status: "in_progress" } },
      { type: "update", update: { sessionUpdate: "tool_call_content_chunk", toolCallId: "tc-cmd", content: "echo ok\n" } },
      { type: "done", sessionId: "sess-2", stopReason: "end_turn" },
    ];
    globalThis.fetch = vi.fn(async () => sseResponse(frames)) as unknown as typeof fetch;

    let receivedState = "";
    let receivedNotice: any = null;
    const seenTexts: string[] = [];
    const seenThoughts: string[] = [];
    let toolCallReceived: any = null;
    let toolCallUpdateReceived: any = null;

    await consumeUniversalChat(
      { agentId: "codex", prompt: "test" },
      {
        onStateUpdate: (st) => { receivedState = st; },
        onNotice: (n) => { receivedNotice = n; },
        onTextChunk: (t) => { seenTexts.push(t); },
        onThoughtChunk: (th) => { seenThoughts.push(th); },
        onToolCall: (tc) => { toolCallReceived = tc; },
        onToolCallUpdate: (upd) => { toolCallUpdateReceived = upd; },
      }
    );

    expect(receivedState).toBe("running");
    expect(receivedNotice).toEqual({ message: "Repository indexing completed", severity: "info" });
    expect(seenThoughts).toContain("deep thinking step");
    expect(seenTexts).toEqual(["block 1 block 2"]);
    expect(toolCallReceived).toMatchObject({
      id: "tc-cmd",
      status: "running", // mapped from in_progress
      title: "Run command",
    });
    expect(toolCallUpdateReceived).toMatchObject({
      id: "tc-cmd",
      status: "running",
      _deltaChunk: "echo ok\n",
    });
  });

  it("rebuilds transcript from ACP replay with tool content chunks and polymorphic content", () => {
    const t = buildTranscriptFromReplay([
      { sessionUpdate: "user_message", messageId: "u1", content: [{ type: "text", text: "write a file" }] },
      { sessionUpdate: "agent_thought", messageId: "a1", content: { text: "planning file write" } },
      { sessionUpdate: "tool_call", toolCallId: "tc-write", title: "write_to_file", status: "in_progress" },
      { sessionUpdate: "tool_call_content_chunk", toolCallId: "tc-write", content: "Writing line 1\n" },
      { sessionUpdate: "tool_call_content_chunk", toolCallId: "tc-write", content: "Writing line 2\n" },
      { sessionUpdate: "tool_call_update", toolCallId: "tc-write", status: "completed" },
      { sessionUpdate: "session_message", messageId: "a1", content: "File created successfully." },
    ]);

    expect(t.messages).toHaveLength(2);
    expect(t.messages[0]).toMatchObject({ role: "user", content: "write a file" });
    expect(t.messages[1]).toMatchObject({
      role: "assistant",
      thought: "planning file write",
      content: "File created successfully.",
    });
    expect(t.messages[1].toolCalls?.[0]).toMatchObject({
      id: "tc-write",
      status: "completed",
      rawOutput: "Writing line 1\nWriting line 2\n",
    });
  });
});

describe("usage extras", () => {
  it("preserves context and session cost when merging cumulative prompt tokens", () => {
    const previous = { ...contextUsage, costScope: "session" as const };
    const merged = mergePromptUsage(previous, { usage: promptUsage });
    expect(merged).toMatchObject({ ...previous, ...displayedPromptUsage });
    expect(mergePromptUsage(merged, { usage: promptUsage })).toEqual(merged);
  });

  it("does not invent context occupation when only prompt totals are provided", () => {
    expect(mergePromptUsage(null, { usage: promptUsage })).toMatchObject({ used: 0, size: 0, totalTokens: 8094326 });
  });

  it("dispatches context snapshots separately from raw end-turn usage without summing", async () => {
    globalThis.fetch = vi.fn(async () => sseResponse([
      { type: "update", update: { sessionUpdate: "usage_update", ...contextUsage } },
      { type: "update", update: { sessionUpdate: "usage_update", ...contextUsage } },
      { type: "done", stopReason: "end_turn", response: { usage: promptUsage } },
    ])) as unknown as typeof fetch;
    const onUsage = vi.fn();
    const onDone = vi.fn();
    await consumeUniversalChat({ agentId: "opencode", prompt: "usage" }, { onUsage, onDone });
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage.mock.calls[1][0]).toMatchObject({ ...contextUsage, costScope: "session" });
    expect(onDone).toHaveBeenCalledWith("end_turn", { usage: promptUsage });
  });
  it("prefers the agent-computed cache hit rate and prompt total", () => {
    const extras = pickUsageExtras({
      used: 140000,
      size: 1048576,
      _meta: {
        inputTokens: 70000,
        cachedTokens: 70000,
        promptTokens: 140000,
        cacheHitRate: 0.5,
        totalTokens: 74000,
      },
    });
    expect(extras.cacheHitRate).toBe(0.5);
    expect(extras.promptTokens).toBe(140000);
    expect(extras.cachedTokens).toBe(70000);
  });

  it("clamps a nonsense cache rate instead of rendering 1338%", () => {
    const extras = pickUsageExtras({ used: 10, size: 100, _meta: { cacheHitRate: 13.385 } });
    expect(extras.cacheHitRate).toBe(1);
  });
});
