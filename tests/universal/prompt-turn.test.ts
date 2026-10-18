// @vitest-environment node
/**
 * PromptTurn unit tests: the turn lifecycle without an agent process.
 *
 * These pin the regression that motivated PromptLock: `session/cancel` is only
 * a notification, so the cancelled turn settles *after* the UI may have started
 * the next one, and its `finally` must not free that new lease.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { PromptTurn } from "../../server/universal/prompt-turn";
import { SessionState } from "../../server/universal/session-state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const END_TURN = { stopReason: "end_turn" } as unknown as acp.PromptResponse;

function harness(request: (method: string, params: unknown) => Promise<unknown>) {
  const state = new SessionState();
  const connection = {
    agent: {
      request,
      notify: async () => {},
    },
  };
  const turn = new PromptTurn({
    agentId: () => "unit-agent",
    ensureConnection: () => connection as unknown as acp.ClientConnection,
    init: () => ({ agentCapabilities: {} }) as unknown as acp.InitializeResponse,
    state,
    subscribe: () => () => {},
    resources: { compatibilityText: () => "" } as never,
    onCancelPending: () => {},
  });
  return { turn, state };
}

const text = (value: string): acp.ContentBlock[] => [{ type: "text", text: value }];

describe("PromptTurn", () => {
  let calls: number;
  beforeEach(() => {
    calls = 0;
  });

  it("rejects a concurrent prompt on the same session with the 409 contract", async () => {
    const firstGate = deferred<unknown>();
    const { turn } = harness(() => {
      calls += 1;
      return firstGate.promise;
    });

    const first = turn.prompt("s1", text("a"), () => {});
    await expect(turn.prompt("s1", text("b"), () => {})).rejects.toThrow(/session busy/);

    firstGate.resolve(END_TURN);
    await first;
    await expect(turn.prompt("s1", text("c"), () => {})).resolves.toBe(END_TURN);
  });

  it("does not let a cancelled turn free the lease of the turn that replaced it", async () => {
    const firstGate = deferred<unknown>();
    const secondGate = deferred<unknown>();
    const { turn } = harness(() => {
      calls += 1;
      return calls === 1 ? firstGate.promise : secondGate.promise;
    });

    const first = turn.prompt("s1", text("a"), () => {});
    await turn.cancel("s1"); // pre-empt, UI may retry immediately
    const second = turn.prompt("s1", text("b"), () => {});

    // The cancelled request settles late; its finally must not unlock s1.
    firstGate.resolve({ stopReason: "cancelled" });
    await first;
    await expect(turn.prompt("s1", text("c"), () => {})).rejects.toThrow(/session busy/);
    expect(turn.busySessions()).toEqual(["s1"]);

    secondGate.resolve(END_TURN);
    await second;
    expect(turn.busySessions()).toEqual([]);
    await expect(turn.prompt("s1", text("d"), () => {})).resolves.toBe(END_TURN);
  });

  it("frees every lease when the agent process dies, without stale releases stealing the next one", async () => {
    const oldTurns = deferred<unknown>();
    const replacement = deferred<unknown>();
    const { turn } = harness(() => {
      calls += 1;
      return calls <= 2 ? oldTurns.promise : replacement.promise;
    });

    const first = turn.prompt("s1", text("a"), () => {});
    const second = turn.prompt("s2", text("b"), () => {});
    expect(turn.busySessions().sort()).toEqual(["s1", "s2"]);

    // Reset is what the connection does on process exit; the old prompts may
    // still settle, but they no longer own anything.
    turn.reset();
    expect(turn.busySessions()).toEqual([]);

    const replacementTurn = turn.prompt("s1", text("c"), () => {});
    oldTurns.resolve(END_TURN); // the dead process' requests settle late
    await Promise.all([first, second]);
    expect(turn.busySessions()).toEqual(["s1"]); // the new turn still owns s1

    replacement.resolve(END_TURN);
    await replacementTurn;
    expect(turn.busySessions()).toEqual([]);
  });
});
