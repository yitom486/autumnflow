// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnRegistry, TURN_RETENTION_MS } from "../../server/universal/turn-registry";

let registry: TurnRegistry;
afterEach(() => registry?.resetForTest());

describe("turn ledger", () => {
  it("assigns monotonic seq, replays afterSeq, follows live events and ends once", async () => {
    registry = new TurnRegistry();
    const turn = registry.create("turn-1", { agentId: "opencode", sessionId: "s1" });
    expect(turn.status).toBe("running");
    registry.append("turn-1", { type: "start" });
    registry.append("turn-1", { type: "update", n: 1 });

    const seen: number[] = [];
    let ended = 0;
    const unsub = registry.subscribe("turn-1", 1, (event) => seen.push(event.seq), () => ended++);
    expect(seen).toEqual([2]);
    registry.append("turn-1", { type: "update", n: 2 });
    expect(seen).toEqual([2, 3]);
    registry.finish("turn-1", "done");
    expect(ended).toBe(1);
    expect(registry.get("turn-1")?.status).toBe("done");
    // A late subscriber gets the full replay and one end callback.
    const replayed: number[] = [];
    registry.subscribe("turn-1", 0, (event) => replayed.push(event.seq), () => ended++);
    await Promise.resolve();
    expect(replayed).toEqual([1, 2, 3]);
    expect(ended).toBe(2);
    unsub();
  });

  it("never appends to a finished turn and keeps duplicate create idempotent", () => {
    registry = new TurnRegistry();
    const a = registry.create("same", { agentId: "codex", sessionId: "s" });
    const b = registry.create("same", { agentId: "codex", sessionId: "s" });
    expect(b).toBe(a);
    registry.finish("same", "done");
    expect(registry.append("same", { type: "late" })).toBeNull();
  });

  it("prunes finished turns after retention but keeps running ones", () => {
    registry = new TurnRegistry();
    registry.create("running", { agentId: "a", sessionId: "s" });
    registry.create("done", { agentId: "a", sessionId: "s" });
    registry.finish("done", "done");
    registry.prune(Date.now() + TURN_RETENTION_MS + 1);
    expect(registry.get("done")).toBeUndefined();
    expect(registry.get("running")).toBeDefined();
  });

  it("calls end immediately for unknown or already-finished turns", () => {
    registry = new TurnRegistry();
    const end = vi.fn();
    registry.subscribe("missing", 0, () => {}, end);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("reports gap/ahead replay plans for trimmed or restored windows", () => {
    registry = new TurnRegistry();
    registry.restore({
      turnId: "turn-gap",
      agentId: "codex",
      sessionId: "s",
      status: "done",
      startedAt: 1,
      events: [
        { seq: 10, data: { type: "update", n: 10 } },
        { seq: 11, data: { type: "done" } },
      ],
    });
    expect(registry.replayPlan("turn-gap", 5)).toMatchObject({
      from: 9,
      firstSeq: 10,
      lastSeq: 11,
      resetRequired: true,
      reason: "gap",
    });
    expect(registry.replayPlan("turn-gap", 12)).toMatchObject({
      from: 9,
      resetRequired: true,
      reason: "ahead",
    });
    expect(registry.replayPlan("turn-gap", 9)).toMatchObject({
      from: 9,
      resetRequired: false,
    });
  });
});
