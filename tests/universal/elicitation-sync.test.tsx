import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useElicitationSync } from "../../src/hooks/useElicitationSync";
import { useStudioStore } from "../../src/stores/useStudioStore";
import type { PendingElicitation } from "../../src/lib/universal-api";
const { pending } = vi.hoisted(() => ({ pending: vi.fn() }));
vi.mock("../../src/lib/universal-api", async original => ({ ...await original<typeof import("../../src/lib/universal-api")>(), fetchPendingElicitations: pending }));
function Harness() { useElicitationSync(); return null; }
afterEach(() => { vi.useRealTimers(); pending.mockReset(); useStudioStore.setState({ pendingElic: [], activeAgentId: "codex" }); });

describe("pending interaction recovery outside chat streams", () => {
  it("restores request-scoped URL waits and removes them after completion without a chat SSE stream", async () => {
    vi.useFakeTimers();
    const item: PendingElicitation = { agentId: "opencode", sessionId: "", elicitationId: "local", status: "accepted", message: "Authorize", schema: { mode: "url", requestId: 9, message: "Authorize", elicitationId: "opaque", url: "https://example.org/authorize" } };
    useStudioStore.setState({ activeAgentId: "opencode", pendingElic: [] });
    pending.mockResolvedValueOnce([item]).mockResolvedValue([]);
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(<Harness />));
      expect(useStudioStore.getState().pendingElic).toEqual([item]);
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(useStudioStore.getState().pendingElic).toEqual([]);
    } finally { await act(async () => root.unmount()); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resurrect an interaction closed by a newer live event", async () => {
    vi.useFakeTimers();
    let deliver!: (value: PendingElicitation[]) => void;
    pending.mockReturnValue(new Promise(resolve => { deliver = resolve; }));
    useStudioStore.setState({ activeAgentId: "opencode", pendingElic: [] });
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(<Harness />));
      useStudioStore.getState().removeElicitation("closed");
      await act(async () => deliver([{ elicitationId: "closed" } as PendingElicitation]));
      expect(useStudioStore.getState().pendingElic).toEqual([]);
    } finally { await act(async () => root.unmount()); }
  });
});
