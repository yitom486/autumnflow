import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { renderToString as renderHtml } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StudioHeader } from "../../src/components/universal/StudioHeader";

const renderToString = (element: Parameters<typeof renderHtml>[0]) =>
  renderHtml(h(QueryClientProvider, { client: new QueryClient() }, element));

describe("StudioHeader modern UI", () => {
  it("StudioHeader renders clean 52px single header with agent selector, title, and actions", () => {
    const html = renderToString(
      h(StudioHeader, {
        agents: [
          {
            id: "codex",
            name: "Codex",
            title: "Codex (OpenAI)",
            description: "Agent",
            status: { connected: true, pid: 57124, protocolVersion: 1 },
          },
        ],
        activeAgentId: "codex",
        onSelectAgent: () => {},
        onConnect: () => {},
        connecting: false,
        onOpenAuth: () => {},
        onLogout: () => {},
        authOk: true,
        sessionId: "01a0c546-de7b-72c2",
        sessionTitle: "自我介绍请求",
        usage: { used: 3420, size: 200000 },
        hasChangesCwd: true,
        supportsFork: true,
        supportsProviders: true,
        busy: false,
        isStreaming: false,
        onNewSession: () => {},
        onForkSession: () => {},
        onOpenProviders: () => {},
        onOpenChanges: () => {},
        onCloseSession: () => {},
        onDeleteSession: () => {},
        onClearMessages: () => {},
      })
    );

    expect(html).toContain("AutumnFlow");
    expect(html).toContain("Codex (OpenAI)");
    expect(html).toContain("自我介绍请求");
    // pid / auth details live in the agent chip popover; the chip itself stays one line.
    expect(html).toContain('data-testid="agent-chip"');
    expect(html).not.toContain("pid 57124");
    expect(html).toContain("已认证");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("新会话");
    expect(html).toContain("变更");
  });

  it("new-session button never forwards the click event as a cwd", async () => {
    const onNewSession = vi.fn();
    const props = {
      agents: [
        {
          id: "opencode",
          name: "OpenCode",
          title: "OpenCode",
          description: "Agent",
          status: { connected: true, pid: 1, protocolVersion: 1 },
        },
      ],
      activeAgentId: "opencode",
      onSelectAgent: () => {},
      onConnect: () => {},
      connecting: false,
      onOpenAuth: () => {},
      onLogout: () => {},
      authOk: true,
      sessionId: "ses_dead",
      hasChangesCwd: false,
      supportsFork: false,
      supportsProviders: false,
      busy: false,
      isStreaming: false,
      onNewSession,
      onForkSession: () => {},
      onOpenProviders: () => {},
      onOpenChanges: () => {},
      onCloseSession: () => {},
      onDeleteSession: () => {},
      onClearMessages: () => {},
    } as any;

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(h(QueryClientProvider, { client: new QueryClient() }, h(StudioHeader, props)));
    });
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("新会话"));
    expect(button).toBeTruthy();
    await act(async () => {
      button!.click();
    });
    expect(onNewSession).toHaveBeenCalledTimes(1);
    // The old bug: onClick={onNewSession} passed a MouseEvent as targetCwd,
    // which crashed setWorkspace with `e.trim is not a function`.
    expect(onNewSession.mock.calls[0]).toEqual([]);
    await act(async () => root.unmount());
    el.remove();
  });

  it("shows a generic title instead of the raw session id when no title exists", () => {
    const html = renderToString(
      h(StudioHeader, {
        agents: [{ id: "opencode", name: "OpenCode", title: "OpenCode", status: { connected: true } }],
        activeAgentId: "opencode",
        onSelectAgent: () => {},
        onConnect: () => {},
        connecting: false,
        onOpenAuth: () => {},
        onLogout: () => {},
        authOk: true,
        sessionId: "01a0c546-de7b-72c2",
        sessionTitle: undefined,
        currentWorkspace: null,
        recentWorkspaces: [],
        onSelectWorkspace: () => {},
        terminalOpen: false,
        onToggleTerminal: () => {},
        hasChangesCwd: false,
        supportsFork: false,
        supportsProviders: false,
        busy: false,
        isStreaming: false,
        onNewSession: () => {},
        onForkSession: () => {},
        onOpenProviders: () => {},
        onOpenChanges: () => {},
        onCloseSession: () => {},
        onDeleteSession: () => {},
        onClearMessages: () => {},
      } as any)
    );
    expect(html).toContain("当前会话");
    // Visible text must not be the opaque id (it may still exist in title="...").
    expect(html).not.toMatch(/>01a0c546/);
  });
});
