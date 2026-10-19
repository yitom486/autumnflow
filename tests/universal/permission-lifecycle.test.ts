// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { InteractionManager } from "../../server/universal/interaction";

afterEach(() => vi.useRealTimers());

it.each(["selected", "timeout", "abort", "session", "exit"])("closes permission on %s exactly once", async reason => {
  vi.useFakeTimers();
  const events: Record<string, unknown>[] = [];
  const m = new InteractionManager("agent", (_sid, event) => events.push(event));
  const controller = new AbortController();
  const result = m.handlePermissionRequest({ sessionId: "s1", toolCall: { toolCallId: "tool" }, options: [{ optionId: "once", name: "Allow", kind: "allow_once" }] }, controller.signal);
  const settled = result.then(value => ({ value }), error => ({ error }));
  const id = m.listPendingPermissions()[0].permissionId;
  if (reason === "selected") m.resolvePermission(id, { outcome: "selected", optionId: "once" });
  if (reason === "timeout") await vi.advanceTimersByTimeAsync(300_000);
  if (reason === "abort") controller.abort();
  if (reason === "session") m.cancelPendingForSession("s1");
  if (reason === "exit") m.rejectAllOnExit(1, null);
  const outcome = await settled;
  if (reason === "exit") expect(outcome).toHaveProperty("error");
  else expect(outcome).toEqual({ value: { outcome: reason === "selected" ? { outcome: "selected", optionId: "once" } : { outcome: "cancelled" } } });
  expect(m.listPendingPermissions()).toEqual([]);
  expect(events.filter(event => event.type === "permission_closed")).toEqual([{ type: "permission_closed", agentId: "agent", sessionId: "s1", permissionId: id }]);
  expect(m.resolvePermission(id, { outcome: "selected", optionId: "once" })).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
