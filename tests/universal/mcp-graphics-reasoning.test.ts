import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleFlowNodes } from "../../src/components/assistant/InteractiveDiagram";
import { inferDiagramType } from "../../src/components/assistant/toolkit";
import { parsePresentResult } from "../../src/lib/present-result";
import { buildTranscriptFromReplay, consumeUniversalChat } from "../../src/lib/universal-api";
import { convertAcpMessage } from "../../src/lib/acp-assistant";

afterEach(() => vi.unstubAllGlobals());

describe("MCP graphics semantics", () => {
  it("preserves explicit mindmaps through payload parsing and inference", () => {
    const data = { root: { label: "root", children: [{ label: "child" }] } };
    const parsed = parsePresentResult({ schemaVersion: 1, id: "native-map", kind: "diagram", diagramType: "mindmap", title: "Map", data });
    expect(parsed?.kind === "diagram" && parsed.diagramType).toBe("mindmap");
    expect(inferDiagramType({ data })).toBe("mindmap");
    expect(inferDiagramType({ diagramType: "flowchart", data })).toBe("flowchart");
  });

  it("keeps shared joins, cycles and disconnected components when branches fold", () => {
    const edges: Array<[number, number]> = [[0,1],[0,2],[1,3],[2,3],[3,4],[4,3]];
    expect([...visibleFlowNodes(6, edges, new Set(["step:1"]))].sort()).toEqual([0,1,2,3,4,5]);
    expect([...visibleFlowNodes(6, edges, new Set(["step:0"]))].sort()).toEqual([0,5]);
    expect([...visibleFlowNodes(6, edges, new Set(["step:3"]))].sort()).toEqual([0,1,2,3,5]);
    expect([...visibleFlowNodes(2, [[0,1],[1,0]], new Set(["step:0"]))]).toEqual([0]);
  });
});

describe("Reasoning packets are not reasoning blocks", () => {
  const aliases = ["agent_thought_chunk", "agent_thought", "thought_chunk", "reasoning_chunk", "thought", "reasoning", "agent_message_chunk"];
  const updates = Array.from({ length: 210 }, (_, i) => ({
    sessionUpdate: aliases[i % aliases.length], messageId: `packet-${i}`, timestamp: i * 200,
    content: { type: i % aliases.length === 6 ? "reasoning" : "text", text: `第 ${i} 段\n\n连续思考，不创建新块。\n` },
  }));
  const expected = updates.map(u => u.content.text).join("");

  it("separates thought and reply sharing a message ID around a real tool call", async () => {
    const packets = [
      { sessionUpdate: "agent_thought_chunk", messageId: "shared", content: { type: "text", text: "先思考。\n" } },
      { sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read file", kind: "read", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" },
      { sessionUpdate: "agent_thought_chunk", messageId: "shared", content: { type: "text", text: "继续思考。" } },
      { sessionUpdate: "agent_message_chunk", messageId: "shared", content: { type: "text", text: "最终答复。" } },
    ];
    const stream = [...packets.map(update => ({ type: "update", update })), { type: "done", stopReason: "end_turn" }]
      .map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    const thought: string[] = [], body: string[] = [];
    const onToolCall = vi.fn(), onToolCallUpdate = vi.fn();
    await consumeUniversalChat({ agentId: "deepseek", sessionId: "s", prompt: "test" }, {
      onThoughtChunk: chunk => thought.push(chunk), onTextChunk: chunk => body.push(chunk),
      onToolCall, onToolCallUpdate,
    });
    expect(thought.join("")).toBe("先思考。\n继续思考。");
    expect(body.join("")).toBe("最终答复。");
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCallUpdate).toHaveBeenCalledTimes(1);
    const replay = buildTranscriptFromReplay(packets);
    expect(replay.messages).toHaveLength(1);
    expect(replay.messages[0].thought).toBe(thought.join(""));
    expect(replay.messages[0].content).toBe(body.join(""));
    expect(replay.messages[0].toolCalls).toHaveLength(1);
    expect(replay.messages[0].toolCalls?.[0].status).toBe("completed");
  });

  it("live SSE preserves all text with arbitrary UTF-8 boundaries and no injected separators", async () => {
    const bytes = new TextEncoder().encode([...updates.map(update => ({ type: "update", update })), { type: "done", stopReason: "end_turn" }]
      .map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));
    const response = new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 137) controller.enqueue(bytes.slice(offset, offset + 137));
      controller.close();
    } }));
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const thought: string[] = [], body: string[] = [];
    await consumeUniversalChat({ agentId: "deepseek", sessionId: "s", prompt: "test" }, {
      onThoughtChunk: chunk => thought.push(chunk), onTextChunk: chunk => body.push(chunk),
    });
    expect(thought.join("")).toBe(expected);
    expect(body).toEqual([]);
    const message = convertAcpMessage({ id: "turn", role: "assistant", timestamp: "00:00", thought: thought.join(""), content: "done" });
    expect((message.content as any[]).filter(part => part.type === "reasoning")).toHaveLength(1);
  });

  it("history aliases and changing packet IDs still rebuild one assistant turn", () => {
    const replay = buildTranscriptFromReplay([
      { sessionUpdate: "user_message_chunk", messageId: "user", content: { text: "test" } }, ...updates,
      { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "done" } },
    ]);
    expect(replay.messages).toHaveLength(2);
    expect(replay.messages[1].thought).toBe(expected);
    expect(replay.messages[1].content).toBe("done");
  });
});
