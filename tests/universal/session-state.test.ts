// @vitest-environment node
/**
 * Regression tests for the two per-session state hazards that only show up in a
 * long-lived host: a prompt lease that outlives its turn (permanent 409 or a
 * freed mutex), and per-session caches that are never reclaimed.
 *
 * None of these start an agent process: PromptLock and SessionState are pure,
 * and the connection-level cases only touch in-memory state.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PromptLock } from "../../server/universal/prompt-lock";
import { SessionState } from "../../server/universal/session-state";
import { UniversalAgentConnection } from "../../server/universal/AgentConnection";
import { studioSessions } from "../../server/universal/session-index";

describe("PromptLock", () => {
  let lock: PromptLock;
  beforeEach(() => {
    lock = new PromptLock();
  });

  it("holds one lease per session and reports the 409 contract", () => {
    const lease = lock.acquire("s1");
    expect(lock.isBusy("s1")).toBe(true);
    expect(lock.current("s1")).toBe(lease);
    expect(() => lock.acquire("s1")).toThrow(/session busy/);
    expect(lock.isBusy("s2")).toBe(false);
    expect(lock.acquire("s2")).toBeGreaterThan(lease);
  });

  it("frees the session when the owning turn releases", () => {
    const lease = lock.acquire("s1");
    expect(lock.release("s1", lease)).toBe(true);
    expect(lock.isBusy("s1")).toBe(false);
    // Re-releasing the same (now stale) lease is harmless.
    expect(lock.release("s1", lease)).toBe(false);
  });

  it("does not let a cancelled turn free the turn that replaced it", () => {
    const cancelled = lock.acquire("s1");
    lock.preempt("s1"); // cancel() lets the UI retry immediately
    const retry = lock.acquire("s1");
    expect(retry).not.toBe(cancelled);

    // The cancelled request settles late; its finally must not unlock s1.
    expect(lock.release("s1", cancelled)).toBe(false);
    expect(lock.isBusy("s1")).toBe(true);
    expect(lock.current("s1")).toBe(retry);
    expect(() => lock.acquire("s1")).toThrow(/session busy/);
  });

  it("releases every session when the agent process exits", () => {
    lock.acquire("s1");
    lock.acquire("s2");
    expect(lock.busySessions().sort()).toEqual(["s1", "s2"]);
    lock.reset();
    expect(lock.busySessions()).toEqual([]);
    expect(lock.acquire("s1")).toBeTypeOf("number");
  });
});

describe("SessionState", () => {
  it("drops only the requested session, including its terminals", () => {
    const state = new SessionState();
    state.commands.set("s1", [{ name: "a" }]);
    state.commands.set("s2", [{ name: "b" }]);
    state.childParents.set("c1", "s1");
    state.childUpdates.set("c1", [{ kind: "tool_call" }]);
    state.turnCounts.set("s1", 3);
    state.terminalOwners.set("t1", "s1");
    state.terminalOwners.set("t2", "s2");
    state.releasedTerminals.set("t1", { sessionId: "s1", output: { terminalId: "t1", output: "x", truncated: false } });
    state.releasedTerminals.set("t2", { sessionId: "s2", output: { terminalId: "t2", output: "y", truncated: false } });
    const sink = () => {};
    state.sinks.set("s1", new Set([sink]));

    state.drop("s1");

    expect(state.sizes()).toEqual({
      sinks: 0,
      commands: 1,
      childParents: 1,
      childUpdates: 1,
      childStates: 0,
      terminalOwners: 1,
      releasedTerminals: 1,
      turnCounts: 0,
    });
    expect(state.terminalOwners.get("t2")).toBe("s2");
    expect(state.commands.get("s2")).toEqual([{ name: "b" }]);
  });

  it("ignores an empty session id and clears everything on process exit", () => {
    const state = new SessionState();
    state.commands.set("s1", []);
    state.drop("");
    expect(state.commands.size).toBe(1);
    state.clear();
    expect(Object.values(state.sizes()).every((n) => n === 0)).toBe(true);
  });
});

describe("connection reclamation", () => {
  const profile = { id: "leak-test", name: "Leak Test", command: "true", args: [] };

  it("reclaims a closed session together with its subagent children", () => {
    const agentId = "leak-test";
    studioSessions.linkChild(agentId, "parent-1", "child-1", "子任务");
    const conn: any = new UniversalAgentConnection(profile as never);

    conn.state.commands.set("parent-1", [{ name: "a" }]);
    conn.state.commands.set("child-1", [{ name: "b" }]);
    conn.state.childUpdates.set("child-1", [{ kind: "tool_call" }]);
    conn.state.childStates.set("child-1", { sessionId: "child-1", status: "running" });
    conn.state.childParents.set("child-1", "parent-1");
    conn.state.releasedTerminals.set("t-parent", { sessionId: "parent-1", output: { terminalId: "t-parent" } });

    // SessionState reclamation has exactly one owner: SessionService.
    conn.sessions.releaseSessionState("parent-1");

    const sizes = conn.state.sizes();
    expect(sizes.commands).toBe(0);
    expect(sizes.childUpdates).toBe(0);
    expect(sizes.childStates).toBe(0);
    expect(sizes.childParents).toBe(0);
    expect(sizes.releasedTerminals).toBe(0);
  });

  it("clears the per-session state and prompt leases on disconnect", async () => {
    const conn: any = new UniversalAgentConnection(profile as never);
    conn.state.commands.set("s1", [{ name: "a" }]);
    // The lease table belongs to PromptTurn now; a running turn holds one.
    conn.turns.lock.acquire("s1");
    await conn.disconnect();
    expect(conn.state.sizes().commands).toBe(0);
    expect(conn.turns.busySessions()).toEqual([]);
  });
});
