import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useStudioStore } from "../../src/stores/useStudioStore";
import { useSessionLifecycle } from "../../src/hooks/useSessionLifecycle";
import type { AgentSummary } from "../../src/lib/universal-api";

const { sessionNew, connectAgent, sessionRpc } = vi.hoisted(() => ({
  sessionNew: vi.fn(),
  connectAgent: vi.fn(),
  sessionRpc: vi.fn(),
}));

vi.mock("../../src/lib/universal-api", async original => ({
  ...(await original<typeof import("../../src/lib/universal-api")>()),
  sessionNew,
  connectAgent,
  sessionRpc,
}));

type Lifecycle = ReturnType<typeof useSessionLifecycle>;

function Harness({ onReady }: { onReady: (api: Lifecycle) => void }) {
  const qc = useQueryClient();
  const agentsRef = useRef<AgentSummary[]>([]);
  const api = useSessionLifecycle({
    qc,
    agents: [],
    agentsRef,
    applyDefaultConfigOptions: async () => {},
  });
  React.useEffect(() => { onReady(api); }, [api]);
  return null;
}

async function renderLifecycle() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  const root = createRoot(host);
  let api!: Lifecycle;
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <Harness onReady={(next) => { api = next; }} />
      </QueryClientProvider>
    );
  });
  return { api, root };
}

beforeEach(() => {
  useStudioStore.getState().resetStudio();
  useStudioStore.setState({ activeAgentId: "e2e-agent" });
  sessionNew.mockReset();
  connectAgent.mockReset();
  sessionRpc.mockReset();
  connectAgent.mockResolvedValue({ ok: true });
  sessionRpc.mockResolvedValue({ ok: true });
});

describe("ensureSession in-flight dedup", () => {
  it("issues one session/new when boot pre-warm and the first send race", async () => {
    // The agent is still spawning, so session/new takes a while to answer.
    let release!: (value: unknown) => void;
    sessionNew.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const { api, root } = await renderLifecycle();
    try {
      const first = api.ensureSession("e2e-agent");
      const second = api.ensureSession("e2e-agent");

      release({ sessionId: "sess-1" });
      const [a, b] = await Promise.all([first, second]);

      expect(sessionNew).toHaveBeenCalledTimes(1);
      expect(a).toBe("sess-1");
      expect(b).toBe("sess-1");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("shares one creation per agent but keeps agents independent", async () => {
    sessionNew.mockResolvedValue({ sessionId: "sess-1" });
    const { api, root } = await renderLifecycle();
    try {
      await Promise.all([
        api.ensureSession("e2e-agent"),
        api.ensureSession("e2e-agent"),
        api.ensureSession("other-agent"),
      ]);
      const agents = sessionNew.mock.calls.map((call) => call[0]);
      expect(agents.filter((id: string) => id === "e2e-agent")).toHaveLength(1);
      expect(agents.filter((id: string) => id === "other-agent")).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("lets a forced creation bypass the shared promise", async () => {
    let release!: (value: unknown) => void;
    sessionNew
      .mockReturnValueOnce(new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce({ sessionId: "sess-forced" });

    const { api, root } = await renderLifecycle();
    try {
      const pending = api.ensureSession("e2e-agent");
      const forced = api.ensureSession("e2e-agent", true);
      release({ sessionId: "sess-1" });

      await expect(forced).resolves.toBe("sess-forced");
      await pending;
      expect(sessionNew).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("releases the shared promise so a later call creates a new session", async () => {
    sessionNew.mockResolvedValue({ sessionId: "sess-1" });
    const { api, root } = await renderLifecycle();
    try {
      await api.ensureSession("e2e-agent");
      // The bound session is gone, so the next call must go back to the agent.
      useStudioStore.setState({ sessionId: null });
      sessionNew.mockResolvedValue({ sessionId: "sess-2" });
      await expect(api.ensureSession("e2e-agent")).resolves.toBe("sess-2");
      expect(sessionNew).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
