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

  it("slows the idle poll down after a while and speeds it up when a request appears", async () => {
    vi.useFakeTimers();
    const item: PendingPermission = { agentId: "opencode", sessionId: "s1", permissionId: "local", toolCall: {}, options: [] };
    useStudioStore.setState({ activeAgentId: "opencode", pendingPerms: [] });
    // Mirror the server: it is the source of truth for what is pending.
    pending.mockImplementation(async () => useStudioStore.getState().pendingPerms.filter(p => p.agentId === "opencode"));
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(<Harness />));
      // The first poll runs immediately, then every 1.5s while things happen.
      expect(pending).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(pending).toHaveBeenCalledTimes(2);

      // A waiting request keeps the cadence tight for the following round.
      useStudioStore.getState().addPermission(item);
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(pending).toHaveBeenCalledTimes(3);
    } finally { await act(async () => root.unmount()); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off to a slow cadence once the app has been idle", async () => {
    vi.useFakeTimers();
    useStudioStore.setState({ activeAgentId: "opencode", pendingPerms: [] });
    const times: number[] = [];
    pending.mockImplementation(async () => { times.push(Date.now()); return []; });
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(<Harness />));
      // Fresh start: the recovery poll runs every 1.5s.
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(times[1] - times[0]).toBe(1500);
      // After a long idle the rounds are 6s apart instead.
      await act(async () => vi.advanceTimersByTimeAsync(40_000));
      const gap = times[times.length - 1] - times[times.length - 2];
      expect(gap).toBeGreaterThanOrEqual(5000);
      // The poll never stops, it only slows down.
      expect(times.length).toBeGreaterThan(5);
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
