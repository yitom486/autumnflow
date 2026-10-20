import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UniversalAuthModal } from "../../src/components/universal/AuthModal";
import type { AgentSummary } from "../../src/lib/universal-api";

const { refreshAgentLogin, authenticateAgent } = vi.hoisted(() => ({
  refreshAgentLogin: vi.fn(),
  authenticateAgent: vi.fn(),
}));

vi.mock("../../src/lib/universal-api", async original => ({
  ...(await original<typeof import("../../src/lib/universal-api")>()),
  refreshAgentLogin,
  authenticateAgent,
}));

function codexAgent(): AgentSummary {
  return {
    id: "codex",
    name: "codex",
    title: "Codex",
    command: "bunx",
    args: ["@agentclientprotocol/codex-acp@latest"],
    status: {
      connected: true,
      authMethods: [{ id: "chat-gpt", name: "ChatGPT", description: "Use ChatGPT to authenticate" }],
    },
  } as unknown as AgentSummary;
}

beforeEach(() => {
  refreshAgentLogin.mockReset();
  authenticateAgent.mockReset();
  refreshAgentLogin.mockResolvedValue({ refreshed: { auth: true, config: false } });
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function renderModal(agent: AgentSummary | undefined, authOk: boolean | null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onAuthenticated = vi.fn();
  await act(async () =>
    root.render(
      <UniversalAuthModal
        isOpen
        onClose={() => {}}
        agent={agent}
        onAuthenticated={onAuthenticated}
        onLogout={() => {}}
        authOk={authOk}
      />
    )
  );
  return { root, host, onAuthenticated, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

describe("codex local login refresh", () => {
  it("offers to sync the machine login and reports what was copied", async () => {
    const view = await renderModal(codexAgent(), false);
    try {
      const target = Array.from(view.host.querySelectorAll("button")).find(
        (b) => (b.textContent || "").includes("同步本机登录态")
      );
      expect(target).toBeTruthy();
      await act(async () => target!.click());
      expect(refreshAgentLogin).toHaveBeenCalledWith("codex");
      expect(view.onAuthenticated).toHaveBeenCalled();
      expect(view.host.textContent).toContain("已从本机同步登录态并重连");
    } finally {
      await view.unmount();
    }
  });

  it("says so when the machine login is already current", async () => {
    refreshAgentLogin.mockResolvedValue({ refreshed: { auth: false, config: false } });
    const view = await renderModal(codexAgent(), false);
    try {
      const target = Array.from(view.host.querySelectorAll("button")).find(
        (b) => (b.textContent || "").includes("同步本机登录态")
      )!;
      await act(async () => target.click());
      expect(view.host.textContent).toContain("本机登录态已是最新");
    } finally {
      await view.unmount();
    }
  });

  it("surfaces a failure instead of claiming success", async () => {
    refreshAgentLogin.mockRejectedValue(new Error("本机没有 auth.json"));
    const view = await renderModal(codexAgent(), false);
    try {
      const target = Array.from(view.host.querySelectorAll("button")).find(
        (b) => (b.textContent || "").includes("同步本机登录态")
      )!;
      await act(async () => target.click());
      expect(view.host.textContent).toContain("同步本机登录态失败");
      expect(view.onAuthenticated).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it("does not offer the refresh for other agents", async () => {
    const other = { ...codexAgent(), id: "claude", name: "claude", title: "Claude", command: "claude" };
    const view = await renderModal(other, false);
    try {
      expect(view.host.textContent).not.toContain("同步本机登录态");
    } finally {
      await view.unmount();
    }
  });
});
