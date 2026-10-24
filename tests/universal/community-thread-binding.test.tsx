import { describe, it, expect, vi } from "vitest";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useAui } from "@assistant-ui/react";
import { AcpAssistantProvider } from "@/components/assistant/AcpAssistantProvider";
import { AssistantChatView } from "@/components/assistant/AssistantChatView";
import { useStudioStore } from "@/stores/useStudioStore";
import { setStudio } from "../helpers/studio";

// Diagnostic probe component using assistant-ui client runtime
function ThreadRuntimeProbe({ onProbe }: { onProbe: (aui: any) => void }) {
  const aui = useAui();
  onProbe(aui);
  return null;
}

describe("community component thread & session bindings", () => {
  it("binds threadList adapter to assistant-ui runtime enabling thread switching and new session", async () => {
    const onNewSession = vi.fn();
    const onOpenSession = vi.fn();

    setStudio({
      activeAgentId: "codex",
      sessionId: "session-abc-123",
      threads: {
        "th-1": {
          id: "th-1",
          agentId: "codex",
          sessionId: "session-abc-123",
          title: "测试会话 1",
          messages: [],
          updatedAt: Date.now(),
        },
        "th-2": {
          id: "th-2",
          agentId: "codex",
          sessionId: "session-def-456",
          title: "测试会话 2",
          messages: [],
          updatedAt: Date.now(),
        },
      },
      messages: [
        { id: "u1", role: "user", content: "hello", timestamp: "12:00" },
      ],
      isStreaming: false,
    } as any);

    let probedAui: any = null;
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);

    await act(async () => {
      root.render(
        h(
          AcpAssistantProvider,
          {
            onSend: vi.fn(),
            onStop: vi.fn(),
            onNewSession,
            onOpenSession,
          } as any,
          h(ThreadRuntimeProbe, { onProbe: (aui) => { probedAui = aui; } }),
          h(AssistantChatView, {
            agentName: "Codex",
            onSelectSuggestion: vi.fn(),
            onNewSession,
          } as any)
        )
      );
    });

    expect(probedAui).not.toBeNull();
    // Test switching to another thread via assistant-ui's threadList runtime
    await act(async () => {
      await probedAui.threads().switchToThread("session-def-456");
    });
    expect(onOpenSession).toHaveBeenCalledWith("session-def-456");

    // Test creating a new thread via assistant-ui's threadList runtime
    await act(async () => {
      await probedAui.threads().switchToNewThread();
    });
    expect(onNewSession).toHaveBeenCalled();

    root.unmount();
    el.remove();
  });

  it("renders recovery action button when reasoning cache expired error occurs", async () => {
    const onNewSession = vi.fn();

    setStudio({
      activeAgentId: "opencode",
      sessionId: "ses_ed67",
      messages: [
        { id: "u1", role: "user", content: "继续上一轮", timestamp: "12:00" },
        {
          id: "a1",
          role: "assistant",
          content: "上游模型推理上下文已过期 (Reasoning Cache Expired)。\n\n> 💡 **原理说明**：上游推理模型服务端缓存超时。\n> 🚀 **解决方案**：请点击下方「+ 新会话」开启干净上下文。",
          timestamp: "12:01",
        },
      ],
      isStreaming: false,
    } as any);

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);

    await act(async () => {
      root.render(
        h(
          AcpAssistantProvider,
          {
            onSend: vi.fn(),
            onStop: vi.fn(),
            onNewSession,
          } as any,
          h(AssistantChatView, {
            agentName: "OpenCode",
            onSelectSuggestion: vi.fn(),
            onNewSession,
          } as any)
        )
      );
    });

    const html = el.innerHTML;
    expect(html).toContain("上游服务端思考缓存已超时失效");
    expect(html).toContain("立即开启新会话");

    // Find and click the button
    const buttons = el.querySelectorAll("button");
    const recoveryBtn = Array.from(buttons).find((b) => b.textContent?.includes("立即开启新会话"));
    expect(recoveryBtn).toBeDefined();

    await act(async () => {
      recoveryBtn?.click();
    });

    expect(onNewSession).toHaveBeenCalled();

    root.unmount();
    el.remove();
  });
});
