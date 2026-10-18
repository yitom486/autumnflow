// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatRouter } from "../../server/universal/http/chat";
import { universalRegistry } from "../../server/universal/registry";
import { turnRegistry } from "../../server/universal/turn-registry";

afterEach(() => {
  vi.restoreAllMocks();
  turnRegistry.resetForTest();
});

function post(turnId: string, afterSeq = 0) {
  return chatRouter.request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: "mock",
      sessionId: "s1",
      prompt: "hi",
      turnId,
      afterSeq,
    }),
  });
}

describe("chat turn idempotency", () => {
  it("prompts the agent once and replays the completed turn on reconnect", async () => {
    const prompt = vi.fn(async (_sid: string, _blocks: unknown[], onEvent: (evt: any) => void) => {
      onEvent({ type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } });
      return { stopReason: "end_turn" };
    });
    vi.spyOn(universalRegistry, "connFor").mockReturnValue({
      connect: vi.fn().mockResolvedValue({}),
      prompt,
      status: () => ({ quota: null }),
    } as any);

    const first = await post("turn-idem-1");
    const firstText = await first.text();
    expect(firstText).toContain('id: 1');
    expect(firstText).toContain('"type":"done"');
    expect(prompt).toHaveBeenCalledTimes(1);

    const second = await post("turn-idem-1");
    const secondText = await second.text();
    expect(secondText).toContain('"type":"done"');
    expect(prompt).toHaveBeenCalledTimes(1);

    const snapshot = await chatRouter.request("http://localhost/turn-idem-1/snapshot?after=2");
    const snapshotJson: any = await snapshot.json();
    expect(snapshotJson.status).toBe("done");
    expect(snapshotJson.events.map((event: any) => event.seq)).toEqual([3]);
    expect(snapshotJson.lastSeq).toBe(3);
    expect(snapshotJson.firstSeq).toBe(1);
    expect(snapshotJson.resetRequired).toBe(false);

    const reset = await chatRouter.request(
      "http://localhost/turn-idem-1/follow?after=99"
    );
    const resetText = await reset.text();
    expect(resetText).toContain('"type":"reset"');
    expect(resetText).toContain('"reason":"ahead"');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("replays only events after afterSeq", async () => {
    const prompt = vi.fn(async (_sid: string, _blocks: unknown[], onEvent: (evt: any) => void) => {
      onEvent({ type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } });
      return { stopReason: "end_turn" };
    });
    vi.spyOn(universalRegistry, "connFor").mockReturnValue({
      connect: vi.fn().mockResolvedValue({}),
      prompt,
      status: () => ({ quota: null }),
    } as any);

    await (await post("turn-idem-2")).text();
    const tail = await (await post("turn-idem-2", 2)).text();
    expect(tail).not.toContain("id: 1");
    expect(tail).not.toContain("id: 2");
    expect(tail).toContain("id: 3");
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
