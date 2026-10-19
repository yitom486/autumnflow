import { expect, it } from "vitest";
import { permissionInScope, elicitationInScope } from "../../src/lib/interaction-scope";

it("isolates approvals by both agent and established session", () => {
  const request = { agentId: "opencode", sessionId: "session-a" };
  expect(permissionInScope(request, "opencode", "session-a")).toBe(true);
  expect(permissionInScope(request, "opencode", "session-b")).toBe(false);
  expect(permissionInScope(request, "codex", "session-a")).toBe(false);
  expect(permissionInScope(request, "opencode", null)).toBe(false);
  expect(permissionInScope({ agentId: "opencode" }, "opencode", null)).toBe(false);
});

it("scopes session questions while retaining genuinely agent-wide setup questions", () => {
  const request = { agentId: "opencode", sessionId: "session-a" };
  expect(elicitationInScope(request, "opencode", "session-a")).toBe(true);
  expect(elicitationInScope(request, "opencode", "session-b")).toBe(false);
  expect(elicitationInScope(request, "opencode", null)).toBe(false);
  expect(elicitationInScope({ agentId: "opencode", sessionId: "" }, "opencode", null)).toBe(true);
  expect(elicitationInScope({ agentId: "opencode", sessionId: "" }, "codex", null)).toBe(false);
});
