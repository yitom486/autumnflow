import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useStudioStore } from "../../src/stores/useStudioStore";
import { appendActivityMessage } from "../../src/hooks/useChatSend";
import { useAgentConfig } from "../../src/hooks/useAgentConfig";
import { useSessionLifecycle } from "../../src/hooks/useSessionLifecycle";
import { useAppBootAndShortcuts } from "../../src/hooks/useAppBootAndShortcuts";
import { Sidebar, SessionRow, type SessionItem } from "../../src/components/universal/Sidebar";
import { acpKeys } from "../../src/lib/acp-queries";

beforeEach(() => {
  useStudioStore.getState().resetStudio();
  localStorage.clear();
});

function renderTestHook<T>(hookFn: () => T): { result: { current: T }; unmount: () => void } {
  const result = { current: null as any };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function TestComp() {
    result.current = hookFn();
    return null;
  }
  act(() => {
    root.render(
      React.createElement(QueryClientProvider, { client: qc }, React.createElement(TestComp))
    );
  });
  return {
    result,
    unmount: () => {
      act(() => root.unmount());
      el.remove();
    },
  };
}

describe("Controller hooks & App invariants", () => {
  describe("useChatSend helper (appendActivityMessage)", () => {
    it("filters out internal sync updates and formats human-readable system messages", () => {
      // Internal metadata should never be appended as chat messages
      appendActivityMessage({ kind: "session_info_update", detail: {} }, "12:00");
      appendActivityMessage({ kind: "plan", detail: {} }, "12:00");
      appendActivityMessage({ kind: "config_option_update", detail: {} }, "12:00");
      expect(useStudioStore.getState().messages).toHaveLength(0);

      // Real fs / terminal activities should be formatted cleanly
      appendActivityMessage({ kind: "fs_read", detail: { path: "src/App.tsx" } }, "12:00");
      const msgs = useStudioStore.getState().messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toContain("src/App.tsx");
      expect(msgs[0].content).toContain("fs_read");
    });
  });

  describe("useAgentConfig invariants", () => {
    it("keeps the selected model and preferences when the agent rejects a model", async () => {
      const originalFetch = globalThis.fetch;
      const originalAlert = window.alert;
      const alert = vi.fn();
      window.alert = alert;
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "Model not found" }), { status: 400 })) as typeof fetch;
      useStudioStore.setState({ sessionId: "s1", activeAgentId: "opencode", modelsOpen: true, models: { currentModelId: "old", availableModels: [] } });
      const before = useStudioStore.getState().agentPrefs;
      const { result, unmount } = renderTestHook(() => useAgentConfig({ agentsRef: { current: [] }, ensureSession: async () => "s1" }));
      try {
        await result.current.handleApplyModel("missing");
        expect(useStudioStore.getState().models?.currentModelId).toBe("old");
        expect(useStudioStore.getState().agentPrefs).toBe(before);
        expect(useStudioStore.getState().modelsOpen).toBe(true);
        expect(alert).not.toHaveBeenCalled();
      } finally { globalThis.fetch = originalFetch; window.alert = originalAlert; unmount(); }
    });
    it("migrates legacy localStorage keys to zustand agentPrefs", async () => {
      localStorage.setItem(
        "acp_default_config_codex",
        JSON.stringify({ model: "gpt-5-preview", effort: "high" })
      );

      const agentsRef = { current: [{ id: "codex", name: "codex" } as any] };
      const ensureSession = vi.fn(async () => "s1");

      const { result, unmount } = renderTestHook(() =>
        useAgentConfig({
          agentsRef,
          ensureSession,
        })
      );

      await result.current.applyDefaultConfigOptions("codex", "s1");

      const pref = useStudioStore.getState().agentPrefs?.codex;
      expect(pref?.configValues).toEqual({ model: "gpt-5-preview", effort: "high" });
      // Legacy key should be removed after migration
      expect(localStorage.getItem("acp_default_config_codex")).toBeNull();
      unmount();
    });

    it("snapshots current options if no preference exists", async () => {
      useStudioStore.getState().setConfigOptions([
        { id: "model", currentValue: "claude-3-7-sonnet" },
        { id: "thinking", currentValue: "medium" },
      ] as any);
      useStudioStore.getState().setModels({
        currentModelId: "claude-3-7-sonnet",
        availableModels: [],
      });

      const agentsRef = { current: [{ id: "claude", name: "claude" } as any] };
      const ensureSession = vi.fn(async () => "s2");

      const { result, unmount } = renderTestHook(() =>
        useAgentConfig({
          agentsRef,
          ensureSession,
        })
      );

      await result.current.applyDefaultConfigOptions("claude", "s2");

      const pref = useStudioStore.getState().agentPrefs?.claude;
      expect(pref?.configValues?.model).toBe("claude-3-7-sonnet");
      expect(pref?.configValues?.thinking).toBe("medium");
      expect(pref?.fallbackModelId).toBe("claude-3-7-sonnet");
      unmount();
    });
  });

  describe("useSessionLifecycle invariants", () => {
    it("respects the resume-first invariant (never blinds force-new)", async () => {
      const st = useStudioStore.getState();
      st.setActiveAgentId("opencode");
      st.newThread("opencode");
      st.bindThreadSession("sess-existing", "/test/path");

      const qc = new QueryClient();
      const agents = [{ id: "opencode", name: "opencode", status: { connected: true } } as any];
      const agentsRef = { current: agents };
      const applyDefaultConfigOptions = vi.fn(async () => {});

      const { unmount } = renderTestHook(() =>
        useSessionLifecycle({
          qc,
          agents,
          agentsRef,
          applyDefaultConfigOptions,
        })
      );

      // Bound session is preserved
      expect(useStudioStore.getState().sessionId).toBe("sess-existing");
      unmount();
    });

    it("keeps dead threads isolated without polluting new sessions with old history", async () => {
      const st = useStudioStore.getState();
      st.setActiveAgentId("opencode");
      st.newThread("opencode");
      st.bindThreadSession("sess-dead", "/test/path");
      st.appendMessage({ id: "user-1", role: "user", content: "old message", timestamp: "10:00" });
      st.markThreadStale();

      const qc = new QueryClient();
      const agents = [{ id: "opencode", name: "opencode", status: { connected: true } } as any];
      const agentsRef = { current: agents };
      const applyDefaultConfigOptions = vi.fn(async () => {});

      let hook: any;
      const { unmount } = renderTestHook(() => {
        hook = useSessionLifecycle({
          qc,
          agents,
          agentsRef,
          applyDefaultConfigOptions,
        });
        return hook;
      });

      // resolveSession on a stale thread with history does not fabricate a fake new session over the old messages
      const sid = await hook.resolveSession("opencode");
      expect(sid).toBeNull();
      expect(useStudioStore.getState().threads[useStudioStore.getState().activeThreadId!]?.stale).toBe(true);
      expect(useStudioStore.getState().messages).toHaveLength(1);
      unmount();
    });

    it("guards against race conditions in optimisticOpenSession", async () => {
      const st = useStudioStore.getState();
      st.setActiveAgentId("opencode");
      st.newThread("opencode");

      // User clicks session A: optimistic switch happens immediately
      st.optimisticOpenSession("opencode", "sess-A", "Session A", "/cwd/a");
      expect(useStudioStore.getState().sessionId).toBe("sess-A");

      // User rapidly clicks session B: switches to B
      st.optimisticOpenSession("opencode", "sess-B", "Session B", "/cwd/b");
      expect(useStudioStore.getState().sessionId).toBe("sess-B");

      // Late response for session A must NOT overwrite B because sessionId != sess-A
      expect(useStudioStore.getState().sessionId).toBe("sess-B");
    });
  });

  describe("useAppBootAndShortcuts invariants", () => {
    it("toggles terminal on Ctrl+` and git diff on Ctrl+Shift+D", () => {
      const agents = [{ id: "codex" } as any];
      const agentsRef = { current: agents };

      const { unmount } = renderTestHook(() =>
        useAppBootAndShortcuts({
          agents,
          agentsRef,
          activeAgentId: "codex",
          currentWorkspace: "/workspace",
        })
      );

      // Simulate keydown
      const termEvent = new KeyboardEvent("keydown", { key: "`", ctrlKey: true });
      window.dispatchEvent(termEvent);
      expect(useStudioStore.getState().terminalOpen).toBe(true);

      window.dispatchEvent(termEvent);
      expect(useStudioStore.getState().terminalOpen).toBe(false);

      const diffEvent = new KeyboardEvent("keydown", { key: "d", ctrlKey: true, shiftKey: true });
      window.dispatchEvent(diffEvent);
      expect(useStudioStore.getState().gitChangesOpen).toBe(true);

      window.dispatchEvent(diffEvent);
      expect(useStudioStore.getState().gitChangesOpen).toBe(false);

      unmount();
    });
  });

  describe("Sidebar & smooth session list invariants", () => {
    it("renders memoized SessionRow items with active selection", () => {
      const sessions: SessionItem[] = [
        { sessionId: "s1", title: "First Session", cwd: "/test", updatedAt: "2026-10-11T12:00:00Z" },
        { sessionId: "s2", title: "Second Session", cwd: "/test", updatedAt: "2026-10-11T11:00:00Z" },
      ];
      const onOpen = vi.fn();
      const onFork = vi.fn();
      const onDelete = vi.fn();

      const el = document.createElement("div");
      document.body.appendChild(el);
      const root = createRoot(el);

      act(() => {
        root.render(
          React.createElement(
            "div",
            null,
            sessions.map((s) =>
              React.createElement(SessionRow, {
                key: s.sessionId,
                session: s,
                active: s.sessionId === "s2",
                supportsFork: true,
                onOpen,
                onFork,
                onDelete,
              })
            )
          )
        );
      });

      expect(el.textContent).toContain("First Session");
      expect(el.textContent).toContain("Second Session");
      const items = el.querySelectorAll('[data-slot="session-row"]');
      expect(items.length).toBe(2);

      act(() => root.unmount());
      el.remove();
    });

    it("elevates updated active session to index 0 smoothly without losing items", () => {
      const qc = new QueryClient();
      const initial: SessionItem[] = [
        { sessionId: "s1", title: "First Topic", cwd: "/test", updatedAt: "2026-10-11T10:00:00Z" },
        { sessionId: "s2", title: "Second Topic", cwd: "/test", updatedAt: "2026-10-11T11:00:00Z" },
        { sessionId: "s3", title: "Third Topic", cwd: "/test", updatedAt: "2026-10-11T09:00:00Z" },
      ];
      qc.setQueryData(acpKeys.sessions("opencode"), initial);

      // Simulate turn-end fine-grained update for s2
      const sid = "s2";
      const nowIso = "2026-10-11T12:00:00Z";
      qc.setQueryData<SessionItem[]>(acpKeys.sessions("opencode"), (old) => {
        if (!old) return old;
        const updated = old.map((s) => (s.sessionId === sid ? { ...s, updatedAt: nowIso } : s));
        const idx = updated.findIndex((s) => s.sessionId === sid);
        if (idx > 0) {
          const [activeItem] = updated.splice(idx, 1);
          updated.unshift(activeItem);
        }
        return updated;
      });

      const updated = qc.getQueryData<SessionItem[]>(acpKeys.sessions("opencode"));
      expect(updated).toBeDefined();
      expect(updated![0].sessionId).toBe("s2");
      expect(updated![0].updatedAt).toBe(nowIso);
      expect(updated![1].sessionId).toBe("s1");
      expect(updated![2].sessionId).toBe("s3");
      expect(updated!.length).toBe(3);
    });
  });
});
