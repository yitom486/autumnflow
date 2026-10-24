import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { sessionOf, useStudioStore } from "../../src/stores/useStudioStore";
import { useSessionLifecycle } from "../../src/hooks/useSessionLifecycle";
import type { AgentSummary } from "../../src/lib/universal-api";
import { setStudio } from "../helpers/studio";

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
  setStudio({ activeAgentId: "e2e-agent" });
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
      setStudio({ sessionId: null });
      sessionNew.mockResolvedValue({ sessionId: "sess-2" });
      await expect(api.ensureSession("e2e-agent")).resolves.toBe("sess-2");
      expect(sessionNew).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps a message that arrives while the session is being created", async () => {
    // The user can send before session/new answers. Judging "the view had
    // messages" when the response arrives would switch the thread and drop
    // that message from the chat.
    let release!: (value: unknown) => void;
    sessionNew.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { api, root } = await renderLifecycle();
    try {
      const pending = api.ensureSession("e2e-agent");
      useStudioStore.getState().appendMessage({
        id: "user-1", role: "user", content: "E2E_DIAGRAM:architecture", timestamp: "t",
      } as any);
      release({ sessionId: "sess-1" });
      await pending;

      const store = useStudioStore.getState();
      expect(sessionOf(store).messages.map((m) => m.content)).toContain("E2E_DIAGRAM:architecture");
      expect(store.sessionId).toBe("sess-1");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps the thread alive when a resume fails for a transient reason", async () => {
    // A dead session retires the thread, but a session the agent has not
    // finished loading must not: a retired thread resolves to no session at
    // all, so the next message would be dropped without a trace.
    setStudio({
      activeAgentId: "e2e-agent",
      sessionId: "sess-1",
      threads: {
        t1: { id: "t1", agentId: "e2e-agent", sessionId: "sess-1", messages: [], updatedAt: Date.now() },
      },
      activeThreadId: "t1",
    } as any);
    sessionRpc.mockRejectedValue(Object.assign(new Error("Agent e2e-agent is not connected"), { status: 503 }));
    const { api, root } = await renderLifecycle();
    try {
      await api.resolveSession("e2e-agent");
      expect(useStudioStore.getState().threads.t1?.stale).toBeFalsy();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("retires the thread when the agent says the session is gone", async () => {
    setStudio({
      activeAgentId: "e2e-agent",
      sessionId: "sess-1",
      threads: {
        t1: { id: "t1", agentId: "e2e-agent", sessionId: "sess-1", messages: [], updatedAt: Date.now() },
      },
      activeThreadId: "t1",
    } as any);
    sessionRpc.mockRejectedValue(new Error("Invalid params: unknown session"));
    const { api, root } = await renderLifecycle();
    try {
      await api.resolveSession("e2e-agent");
      expect(useStudioStore.getState().threads.t1?.stale).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
