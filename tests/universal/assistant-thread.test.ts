import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { AcpAssistantProvider } from "@/components/assistant/AcpAssistantProvider";
import { AcpComposer } from "@/components/assistant/AcpComposer";
import { AssistantChatView } from "@/components/assistant/AssistantChatView";
import { useStudioStore } from "@/stores/useStudioStore";
import { convertAcpMessage } from "@/lib/acp-assistant";

const composerProps = {
  onSendAttachmentOnly: () => {},
  onClear: () => {},
  isStreaming: false,
  commands: [{ name: "status", description: "查看状态" }],
  supportImage: true,
  attachments: [],
  setAttachments: () => {},
  agentTitle: "Codex",
  configOptions: null,
  connected: true,
  fallbackModels: null,
  fallbackCurrentModel: "",
};

describe("assistant-ui ACP thread (client smoke)", () => {
  it("renders user text, thought, tool call, plan and Diff", async () => {
    useStudioStore.setState({
      messages: [
        { id: "u1", role: "user", content: "你好", timestamp: "03:14" } as any,
        {
          id: "a1",
          role: "assistant",
          content: "你好！我是 Codex。\n\n```ts\nconsole.log(1);\n```\n",
          thought: "正在思考",
          thoughtTiming: { startedAt: 500, completedAt: 4500 },
          toolCalls: [{ id: "t1", title: "read src/App.tsx", kind: "file", status: "completed", startedAt: 1000, completedAt: 4400 }],
          plan: [{ content: "分析", status: "completed" }],
          timestamp: "03:15",
          startedAt: 100,
          completedAt: 5200,
          usage: { used: 39001, size: 258400 },
        } as any,
      ],
      isStreaming: false,
    } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });
    const html = el.innerHTML;
    expect(html).toContain("你好");
    expect(html).toContain("Codex");
    expect(html).toContain("思考过程");
    expect(html).toContain("执行计划");
    expect(html).toContain("复制");
    expect(html).toContain("animate-fade-slide-in");
    // 用户区无外挂行：时间戳/复制/编辑同处气泡内底部单行，常驻挂载只换透明度
    expect(html).toContain("03:14");
    expect(html).toContain("编辑后重发");
    expect(html).not.toContain("text-muted-foreground/60");
    expect(html).not.toContain("-top-3");
    // 真实耗时：整轮 + 思考（静态文本直出）
    expect(html).toContain("用时 5.1s");
    expect(html).toContain("用时 4.0s");
    // 用量面板：窗口占比 + 进度条，点击展开明细
    expect(html).toContain("context 39,001/258,400");
    expect(html).toContain("15.1%");
    const usageBtn = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("context")
    );
    expect(usageBtn).toBeTruthy();
    await act(async () => {
      usageBtn!.click();
    });
    expect(el.innerHTML).toContain("窗口总量");
    expect(el.innerHTML).toContain("219,399");
    expect(el.innerHTML).toContain("agent 未提供");
    // 工具调用收进折叠组：摘要可见、明细默认收起，点击展开
    expect(html).toContain("工具调用 · 1");
    expect(html).not.toContain("read src/App.tsx");
    const groupBtn = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("工具调用")
    );
    expect(groupBtn).toBeTruthy();
    await act(async () => {
      groupBtn!.click();
    });
    // 文件卡：显示解析出的路径 + 预览区 + Diff + 真实耗时
    expect(el.innerHTML).toContain("src/App.tsx");
    expect(el.innerHTML).toContain("Diff");
    // 工具行真实耗时（3400ms -> 3.4s）
    expect(el.innerHTML).toContain("3.4s");
    root.unmount();
    el.remove();
  });

  it("renders ACP composer with placeholder, send and model fallback", async () => {
    useStudioStore.setState({ messages: [], isStreaming: false } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AcpComposer, composerProps as any))
      );
    });
    const html = el.innerHTML;
    expect(html).toContain("@ 引用文件");
    expect(html).toContain("发送");
    expect(html).toContain("点击加载模型");
    root.unmount();
    el.remove();
  });

  it("renders model/thinking/permission selectors when session config exists", async () => {
    useStudioStore.setState({ messages: [], isStreaming: false } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AcpComposer, {
            ...composerProps,
            configOptions: [
              { id: "model", name: "模型", type: "select", currentValue: "gpt-5", options: [{ value: "gpt-5", name: "GPT-5" }, { value: "gpt-4", name: "GPT-4" }] },
              { id: "reasoning_effort", name: "思考", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
              { id: "mode", name: "权限", type: "select", currentValue: "auto", options: [{ value: "auto", name: "自动" }] },
            ],
          } as any))
      );
    });
    let html = el.innerHTML;
    expect(html).toContain("GPT-5");
    expect(html).toContain("High");
    // Permission / mode / extras moved into the "…" popover.
    expect(html).not.toContain("自动");
    await act(async () => {
      (el.querySelector('[data-testid="composer-more"]') as HTMLButtonElement).click();
    });
    html = el.innerHTML;
    expect(html).toContain("自动");
    expect(html).not.toContain("点击加载模型");
    expect(html).not.toContain("思考：—");
    root.unmount();
    el.remove();
  });

  it("shows a compact capsule before the first token", async () => {
    useStudioStore.setState({
      messages: [
        { id: "a0", role: "assistant", content: "", timestamp: "15:49", isStreaming: true } as any,
      ],
      isStreaming: true,
    } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });
    // 紧凑胶囊：有思考提示、无整卡头部（无标题栏时间戳/生成中/骨架卡）
    expect(el.innerHTML).toContain("正在思考");
    expect(el.innerHTML).not.toContain("生成中");
    expect(el.innerHTML).not.toContain("15:49");
    root.unmount();
    el.remove();
    useStudioStore.setState({ messages: [], isStreaming: false } as any);
  });

  it("shows cache hit rate only when the agent provides it", async () => {
    useStudioStore.setState({
      messages: [
        {
          id: "a2",
          role: "assistant",
          content: "答复",
          timestamp: "03:16",
          usage: { used: 10000, size: 200000, cachedTokens: 6000, totalTokens: 10000 },
        } as any,
      ],
      isStreaming: false,
    } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });
    // 摘要行即见缓存命中率
    expect(el.innerHTML).toContain("缓存 60.0%");
    const usageBtn = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("context")
    );
    await act(async () => {
      usageBtn!.click();
    });
    expect(el.innerHTML).toContain("6,000/10,000");
    root.unmount();
    el.remove();
    useStudioStore.setState({ messages: [], isStreaming: false } as any);
  });

  it("shows a loading shimmer while the session builds", async () => {
    useStudioStore.setState({ messages: [], isStreaming: false } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AcpComposer, { ...composerProps, sessionLoading: true } as any))
      );
    });
    expect(el.innerHTML).toContain("模型加载中");
    expect(el.innerHTML).not.toContain("点击加载模型");
    root.unmount();
    el.remove();
  });

  it("shows a session banner with retry when creation fails", async () => {
    useStudioStore.setState({ messages: [], isStreaming: false } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, {
            agentName: "Codex",
            onSelectSuggestion: () => {},
            connected: true,
            sessionId: null,
            sessionError: "网关超时",
            onEnsureSession: () => {},
          } as any))
      );
    });
    expect(el.innerHTML).toContain("建会话失败");
    expect(el.innerHTML).toContain("网关超时");
    expect(el.innerHTML).toContain("重试");
    root.unmount();
    el.remove();
  });

  it("renders tables via remark-gfm with ACP styling", async () => {
    useStudioStore.setState({
      messages: [
        {
          id: "a4",
          role: "assistant",
          content: "对比如下：\n\n| 方案 | 成本 |\n| --- | --- |\n| A | 低 |\n",
          timestamp: "03:18",
        } as any,
      ],
      isStreaming: false,
    } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });
    expect(el.querySelector("table")).toBeTruthy();
    expect(el.innerHTML).toContain("方案");
    expect(el.innerHTML).toContain("低");
    root.unmount();
    el.remove();
    useStudioStore.setState({ messages: [], isStreaming: false } as any);
  });

  it("renders a mermaid fence through the lazy diagram renderer", async () => {
    useStudioStore.setState({
      messages: [
        {
          id: "a3",
          role: "assistant",
          content: "流程如下：\n\n```mermaid\nflowchart LR\n  A-->B\n```\n",
          timestamp: "03:17",
        } as any,
      ],
      isStreaming: false,
    } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
      await new Promise((r) => setTimeout(r, 200));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    // 图表容器（或其加载/回退态）必须出现，而不是裸代码
    const html = el.innerHTML;
    expect(html).toContain("data-mermaid-block");
    expect(html).toContain("mermaid");
    root.unmount();
    el.remove();
    useStudioStore.setState({ messages: [], isStreaming: false } as any);
  });

  it("floats the scroll-to-bottom button with zero layout footprint", async () => {
    useStudioStore.setState({
      messages: [{ id: "u1", role: "user", content: "hi", timestamp: "03:14" } as any],
      isStreaming: false,
    } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });
    const btn = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("回到底部")
    );
    expect(btn).toBeTruthy();
    // 浮层：不占文档流，显隐不再挤压上方消息
    expect(btn!.className).toContain("absolute");
    expect(btn!.className).toContain("pointer-events-auto");
    const footer = btn!.parentElement;
    expect(footer!.className).toContain("pointer-events-none");
    expect(footer!.className).toContain("h-0");
    root.unmount();
    el.remove();
    useStudioStore.setState({ messages: [], isStreaming: false } as any);
  });

  it("shows a turn-changes entry only for edit-kind tool calls", async () => {
    useStudioStore.setState({
      messages: [
        {
          id: "a7", role: "assistant", content: "改完了", timestamp: "03:21",
          toolCalls: [{ id: "t1", title: "edit a.ts", kind: "edit", status: "completed" }],
        } as any,
      ],
      isStreaming: false,
    } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });
    expect(el.innerHTML).toContain("改动 1");
    root.unmount();
    el.remove();

    useStudioStore.setState({
      messages: [
        {
          id: "a8", role: "assistant", content: "读完了", timestamp: "03:22",
          toolCalls: [{ id: "t2", title: "read a.ts", kind: "read", status: "completed" }],
        } as any,
      ],
      isStreaming: false,
    } as any);
    const el2 = document.createElement("div");
    document.body.appendChild(el2);
    const root2 = createRoot(el2);
    await act(async () => {
      root2.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });
    expect(el2.innerHTML).not.toContain("改动");
    root2.unmount();
    el2.remove();
    useStudioStore.setState({ messages: [], isStreaming: false } as any);
  });

  it("paginates long histories with a load-earlier button", async () => {
    const many = Array.from({ length: 35 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `消息 ${i}`,
      timestamp: "03:14",
    }));
    useStudioStore.setState({ messages: many, isStreaming: false } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });
    // Latest page visible + earlier loader offered; oldest message withheld.
    expect(el.innerHTML).toContain("加载更早的消息");
    expect(el.innerHTML).toContain("消息 34");
    expect(el.innerHTML).not.toContain("消息 0");
    root.unmount();
    el.remove();
  });

  it("updates waiting status by active session and agent without consuming another chat's requests", async () => {
    useStudioStore.setState({
      activeAgentId: "opencode", sessionId: "session-a", isStreaming: true,
      messages: [{ id: "waiting", role: "assistant", content: "", isStreaming: true, startedAt: Date.now(), timestamp: "00:00" }],
      pendingPerms: [{ permissionId: "perm-a", agentId: "opencode", sessionId: "session-a", toolCall: {}, options: [] }], pendingElic: [],
    } as any);
    const el = document.createElement("div"); document.body.appendChild(el); const root = createRoot(el);
    try {
      await act(async () => root.render(h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
        h(AssistantChatView, { onSelectSuggestion: () => {} } as any))));
      expect(el.textContent).toContain("等待用户确认授权");
      for (const scope of [{ sessionId: "session-b" }, { sessionId: null }, { sessionId: "session-a", activeAgentId: "codex" }]) {
        await act(async () => useStudioStore.setState(scope));
        expect(el.textContent).not.toContain("等待用户确认授权");
      }
      await act(async () => useStudioStore.setState({ activeAgentId: "opencode", sessionId: "session-a" }));
      expect(el.textContent).toContain("等待用户确认授权");
      expect(useStudioStore.getState().pendingPerms).toHaveLength(1);
      await act(async () => useStudioStore.setState({ pendingPerms: [], pendingElic: [{ elicitationId: "q", agentId: "opencode", sessionId: "session-a", message: "Question", schema: {} }] } as any));
      expect(el.textContent).toContain("等待用户回应提问");
      await act(async () => useStudioStore.setState({ sessionId: "session-b" }));
      expect(el.textContent).not.toContain("等待用户回应提问");
    } finally { await act(async () => root.unmount()); el.remove(); useStudioStore.getState().resetStudio(); }
  });

  it("keeps permission actions out of the collapsible tool card", async () => {
    useStudioStore.setState({
      sessionId: "sess1",
      messages: [
        {
          id: "a9",
          role: "assistant",
          content: "正在执行",
          toolCalls: [{ id: "t1", title: "rm -rf /tmp/x", kind: "terminal", status: "running" }],
          timestamp: "03:15",
        },
      ],
      pendingPerms: [
        {
          permissionId: "perm1",
          agentId: "codex",
          sessionId: "sess1",
          toolCall: { toolCallId: "t1", title: "rm -rf /tmp/x" },
          options: [{ optionId: "allow", name: "允许", kind: "allow" }],
        },
      ],
      isStreaming: false,
    } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });
    expect(el.innerHTML).not.toContain("需要授权");
    expect(el.innerHTML).not.toContain("允许");
    expect(useStudioStore.getState().pendingPerms).toHaveLength(1);
    root.unmount();
    el.remove();
    useStudioStore.setState({ pendingPerms: [], sessionId: null } as any);
  });

  it("displays success ratio and scroll container for tool calls", async () => {
    const tools = [
      { id: "t1", title: "read file 1", status: "completed" },
      { id: "t2", title: "grep pattern", status: "completed" },
      { id: "t3", title: "read missing file", status: "failed" },
    ];
    useStudioStore.setState({
      sessionId: "sess1",
      messages: [
        {
          id: "a10",
          role: "assistant",
          content: "调用完毕",
          toolCalls: tools,
          timestamp: "03:20",
        },
      ],
      isStreaming: false,
    } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });
    // 展示 2/3 成功比例，而不是纯吓人的“有失败”
    expect(el.innerHTML).toContain("2/3 成功");
    expect(el.innerHTML).toContain("1 次失败/重试");
    expect(el.innerHTML).toContain("data-state=\"closed\"");
    root.unmount();
    el.remove();
  });

  it("keeps tool group open during streaming and shows latest items with 5-item conveyor container", async () => {
    const tools = [
      { id: "t1", title: "read file 1", kind: "file", status: "completed" },
      { id: "t2", title: "read file 2", kind: "file", status: "completed" },
      { id: "t3", title: "read file 3", kind: "file", status: "completed" },
      { id: "t4", title: "read file 4", kind: "file", status: "completed" },
      { id: "t5", title: "read file 5", kind: "file", status: "completed" },
      { id: "t6", title: "read file 6", kind: "file", status: "running" },
    ];
    useStudioStore.setState({
      sessionId: "sess1",
      messages: [
        {
          id: "a11",
          role: "assistant",
          content: "流式运行中",
          toolCalls: tools,
          timestamp: "03:22",
          isStreaming: true,
        },
      ],
      isStreaming: true,
    } as any);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });
    // 流式输出期间应处于工作状态，展示工具列表与计数
    expect(el.innerHTML).toContain("data-state=\"working\"");
    expect(el.innerHTML).toContain("工具调用 · 6");
    expect(el.innerHTML).toContain("read file 6");
    root.unmount();
    el.remove();
  });

  it("renders intermediate progress accordion and separates final conclusion", async () => {
    useStudioStore.setState({
      sessionId: "sess-progress-1",
      messages: [
        {
          id: "asst-prog",
          role: "assistant",
          progressContent: "收到，按 G0–G5 接线排查。核对官方包能力、梳理 present 真实链路...",
          content: "**最终接线结论**\n所有接口接线完毕，单测通过。",
          timestamp: "03:30",
          isStreaming: false,
        },
      ],
      isStreaming: false,
    } as any);

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });

    const html = el.innerHTML;
    // 阶段记录折叠卡
    expect(html).toContain("阶段推进记录");
    expect(html).toContain("(已收拢)");
    // 最终结论直接显示在正文区
    expect(html).toContain("最终接线结论");
    // 复制按钮
    expect(html).toContain("复制最终结论");

    root.unmount();
    el.remove();
  });

  it("clusters consecutive system messages into single row capsule to avoid flooding", async () => {
    useStudioStore.setState({
      sessionId: "sess-cluster-1",
      messages: [
        { id: "s1", role: "system", content: "📝 [fs_write] packages/contracts/component-ui.ts", timestamp: "03:31" },
        { id: "s2", role: "system", content: "📝 [fs_write] packages/contracts/present-result.ts", timestamp: "03:32" },
        { id: "s3", role: "system", content: "📝 [fs_write] packages/contracts/tool-display.ts", timestamp: "03:33" },
      ],
      isStreaming: false,
    } as any);

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });

    const html = el.innerHTML;
    // 聚合成单条系统记录
    expect(html).toContain("系统记录 · 3 项操作");
    expect(html).toContain("packages/contracts/tool-display.ts");

    root.unmount();
    el.remove();
  });

  it("embeds generative diagrams and interactive cards inline within prose via placeholders and transitions from skeleton to rendered card", async () => {
    useStudioStore.setState({
      sessionId: "sess-inline-gen-1",
      messages: [
        {
          id: "asst-inline-1",
          role: "assistant",
          content:
            "第一段：首先我们来看缓存读写流程图：\n\n<!--acp-tool:tc-flow-->\n\n第二段：如图所示，接下来请在下方卡片确认缓存淘汰策略：\n\n<!--acp-tool:tc-decision-->\n\n第三段：确认后系统将自动应用配置。",
          toolCalls: [
            {
              id: "tc-flow",
              name: "render_editorial_diagram",
              title: "render_editorial_diagram",
              status: "running",
            },
            {
              id: "tc-decision",
              name: "show_interactive_card",
              title: "show_interactive_card",
              status: "completed",
              rawInput: {
                title: "缓存淘汰策略选型",
                cardType: "decision",
                data: {
                  options: [
                    { id: "lru", label: "Allkeys-LRU 淘汰策略", recommended: true },
                    { id: "lfu", label: "Volatile-LFU 淘汰策略" },
                  ],
                },
              },
            },
          ],
          timestamp: "14:00",
          isStreaming: true,
        },
      ],
      isStreaming: true,
    } as any);

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
      );
    });

    // 1. 当 tc-flow 仍在后台生成时，第一段与第二段之间显示骨架屏占位
    const pendingHtml = el.innerHTML;
    expect(pendingHtml).not.toContain("<!--acp-tool:");
    expect(pendingHtml).toContain("正在生成出版级矢量图表…");
    expect(pendingHtml.indexOf("第一段：首先我们来看缓存读写流程图")).toBeLessThan(
      pendingHtml.indexOf("正在生成出版级矢量图表…")
    );
    expect(pendingHtml.indexOf("正在生成出版级矢量图表…")).toBeLessThan(
      pendingHtml.indexOf("第二段：如图所示，接下来请在下方卡片确认缓存淘汰策略")
    );

    // 2. 后台完成 tc-flow 渲染数据回填，骨架屏原位替换为流程图 SVG，且严格保持段落与卡片交错顺序
    await act(async () => {
      useStudioStore.getState().patchMessage("asst-inline-1", (m) => ({
        ...m,
        isStreaming: false,
        toolCalls: m.toolCalls?.map((tc) =>
          tc.id === "tc-flow"
            ? {
                ...tc,
                status: "completed" as const,
                rawInput: {
                  title: "Redis 读写穿透链路",
                  diagramType: "flowchart",
                  data: {
                    steps: [
                      { id: "s1", label: "请求进入网关" },
                      { id: "s2", label: "查询 Redis 缓存" },
                    ],
                  },
                },
              }
            : tc
        ),
      }));
    });

    const settledHtml = el.innerHTML;
    const idxP1 = settledHtml.indexOf("第一段：首先我们来看缓存读写流程图");
    const idxDiagram = settledHtml.indexOf("Redis 读写穿透链路");
    const idxP2 = settledHtml.indexOf("第二段：如图所示，接下来请在下方卡片确认缓存淘汰策略");
    const idxCard = settledHtml.indexOf("缓存淘汰策略选型");
    const idxP3 = settledHtml.indexOf("第三段：确认后系统将自动应用配置");

    expect(idxP1).toBeGreaterThan(-1);
    expect(idxDiagram).toBeGreaterThan(idxP1);
    expect(idxP2).toBeGreaterThan(idxDiagram);
    expect(idxCard).toBeGreaterThan(idxP2);
    expect(idxP3).toBeGreaterThan(idxCard);

    root.unmount();
    el.remove();
  });

  it("automatically heals loose bold syntax in historical messages via convertAcpMessage", () => {
    const historicalMsg = {
      id: "a-history",
      role: "assistant" as const,
      content: "出于**防止用户硬件指纹追踪 (Anti-Fingerprinting) **的隐私安全考虑，业界通常采取微采样测速法。",
      timestamp: "10:00",
      isStreaming: false,
    };
    const converted = convertAcpMessage(historicalMsg as any);
    const textPart = converted.content.find((p) => p.type === "text") as { type: "text"; text: string };
    expect(textPart).toBeDefined();
    expect(textPart.text).toBe("出于**防止用户硬件指纹追踪 (Anti-Fingerprinting)** 的隐私安全考虑，业界通常采取微采样测速法。");
  });
});


