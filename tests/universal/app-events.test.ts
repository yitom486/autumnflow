import { describe, expect, it } from "vitest";
import { assertNever, normalizeAppEvent } from "../../src/lib/app-events";

describe("normalizeAppEvent", () => {
  it("normalizes the closed transport union", () => {
    expect(normalizeAppEvent({ type: "start", sessionId: "s1", agentId: "codex" })).toEqual({
      type: "start",
      sessionId: "s1",
      agentId: "codex",
    });
    expect(normalizeAppEvent({ type: "update", update: { sessionUpdate: "plan" } })).toEqual({
      type: "update",
      update: { sessionUpdate: "plan" },
    });
    expect(normalizeAppEvent({ type: "done", stopReason: "end_turn", response: {} })).toMatchObject({
      type: "done",
      stopReason: "end_turn",
    });
    expect(normalizeAppEvent({ type: "error", message: "boom", code: 409 })).toEqual({
      type: "error",
      message: "boom",
      code: 409,
    });
    expect(
      normalizeAppEvent({ type: "permission_request", permissionId: "p", agentId: "a", sessionId: "s" })
    ).toMatchObject({ type: "permission_request", permissionId: "p", options: [] });
    expect(
      normalizeAppEvent({ type: "elicitation_request", elicitationId: "e", message: "m", schema: {} })
    ).toMatchObject({ type: "elicitation_request", elicitationId: "e" });
    expect(normalizeAppEvent({ type: "elicitation_completed", elicitationId: "e" })).toEqual({
      type: "elicitation_closed",
      elicitationId: "e",
    });
    expect(normalizeAppEvent({ type: "activity", kind: "fs_read", detail: {} })).toMatchObject({
      type: "activity",
      kind: "fs_read",
    });
  });

  it("preserves unknown and malformed frames instead of throwing", () => {
    expect(normalizeAppEvent({ type: "future_event", x: 1 })).toEqual({
      type: "unknown",
      rawType: "future_event",
      raw: { type: "future_event", x: 1 },
    });
    expect(normalizeAppEvent(null)).toEqual({ type: "unknown", rawType: "", raw: {} });
    expect(normalizeAppEvent({ type: "start" })).toMatchObject({ type: "unknown", rawType: "start" });
    expect(normalizeAppEvent({ type: "update", update: null })).toMatchObject({ type: "unknown" });
    expect(() => assertNever("x" as never)).toThrow("Unhandled AppEvent");
  });
});
