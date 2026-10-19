import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePermissionSync } from "../../src/hooks/usePermissionSync";
import { useStudioStore } from "../../src/stores/useStudioStore";
import type { PendingPermission } from "../../src/lib/universal-api";
const { pending } = vi.hoisted(() => ({ pending: vi.fn() }));
vi.mock("../../src/lib/universal-api", async original => ({ ...await original<typeof import("../../src/lib/universal-api")>(), fetchPendingPermissions: pending }));
function Harness() { usePermissionSync(); return null; }
afterEach(() => { vi.useRealTimers(); pending.mockReset(); useStudioStore.setState({ pendingPerms: [], activeAgentId: "codex" }); });

describe("pending interaction recovery outside chat streams", () => {
  it("restores pending permissions and removes expired requests without a chat SSE stream", async () => {
    vi.useFakeTimers();
    const item: PendingPermission = { agentId: "opencode", sessionId: "s1", permissionId: "local", toolCall: {}, options: [] };
    useStudioStore.setState({ activeAgentId: "opencode", pendingPerms: [] });
    pending.mockResolvedValueOnce([item]).mockResolvedValue([]);
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(<Harness />));
      expect(useStudioStore.getState().pendingPerms).toEqual([item]);
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(useStudioStore.getState().pendingPerms).toEqual([]);
    } finally { await act(async () => root.unmount()); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resurrect an interaction closed by a newer live event", async () => {
    vi.useFakeTimers();
    let deliver!: (value: PendingPermission[]) => void;
    pending.mockReturnValue(new Promise(resolve => { deliver = resolve; }));
    useStudioStore.setState({ activeAgentId: "opencode", pendingPerms: [] });
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(<Harness />));
      useStudioStore.getState().removePermission("closed");
      await act(async () => deliver([{ permissionId: "closed" } as PendingPermission]));
      expect(useStudioStore.getState().pendingPerms).toEqual([]);
    } finally { await act(async () => root.unmount()); }
  });
});
