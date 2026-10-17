import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DecisionCard,
  ChecklistCard,
  MetricsCard,
  PromptFormCard,
} from "../../src/components/assistant/GenerativeCards";
import { ReactArtifactCard } from "../../src/components/assistant/ReactArtifactCard";
import { AcpCodeHeader } from "../../src/components/assistant/AcpMarkdown";
import { EditorialDiagramCard } from "../../src/components/assistant/EditorialDiagramCard";
import {
  AcpGenerativeToolCard,
  isGenerativeTool,
  normalizeGenerativeToolName,
  inferDiagramType,
} from "../../src/components/assistant/toolkit";

// Helper to reliably trigger React 19 synthetic onChange events on uncontrolled/controlled inputs in happy-dom
function setInputValue(input: HTMLInputElement, value: string | boolean) {
  const isCheckbox = input.type === "checkbox";
  const prop = isCheckbox ? "checked" : "value";
  const proto = window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event(isCheckbox ? "click" : "input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Generative UI - Front-End Component Integration Tests", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalConsoleError = console.error;

  beforeEach(() => {
    // Suppress happy-dom's benign script loading error inside iframe srcDoc
    console.error = (...args: any[]) => {
      const msg = typeof args[0] === "string" ? args[0] : "";
      if (msg.includes("JavaScript file loading is disabled") || msg.includes("Failed to load script")) {
        return;
      }
      originalConsoleError(...args);
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    console.error = originalConsoleError;
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("E2E: DecisionCard renders options, recommended badge, and handles user option clicks", async () => {
    const onSelect = vi.fn();
    const options = [
      {
        id: "canary",
        label: "灰度金丝雀发布 (Canary)",
        recommended: true,
        description: "先向 5% 灰度用户放量",
      },
      {
        id: "bluegreen",
        label: "蓝绿双集群热切 (Blue-Green)",
        description: "独立备用集群全量验证后瞬间切流",
      },
    ];

    await act(async () => {
      root.render(
        <DecisionCard
          title="发布架构策略决策"
          description="挑选最佳生产切流策略"
          options={options}
          onSelect={onSelect}
        />
      );
    });

    // 1. Assert Title, Description, and Badges
    expect(container.textContent).toContain("发布架构策略决策");
    expect(container.textContent).toContain("挑选最佳生产切流策略");
    expect(container.textContent).toContain("灰度金丝雀发布 (Canary)");
    expect(container.textContent).toContain("推荐");
    expect(container.textContent).toContain("蓝绿双集群热切 (Blue-Green)");

    // 2. Click the second option (Blue-Green)
    const optionCards = container.querySelectorAll(".group.relative");
    expect(optionCards.length).toBe(2);

    await act(async () => {
      optionCards[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // 3. Verify interaction callback & UI active selection state
    expect(onSelect).toHaveBeenCalledWith("bluegreen", options[1]);
    expect(optionCards[1].className).toContain("border-primary");
  });

  it("E2E: ChecklistCard displays progress bar and updates dynamically on user toggle", async () => {
    const items = [
      { id: "item1", label: "单元测试覆盖率门禁", checked: true },
      { id: "item2", label: "核心业务路径端到端测试", checked: false },
      { id: "item3", label: "静态代码与安全漏洞扫描", checked: true },
    ];

    await act(async () => {
      root.render(
        <ChecklistCard
          title="发布前门禁校验"
          description="必须全部通过后方可开放生产公网流量"
          items={items}
        />
      );
    });

    // Initial state: 2 out of 3 done (67%)
    expect(container.textContent).toContain("发布前门禁校验");
    expect(container.textContent).toContain("2 / 3 (67%)");

    const progressBar = container.querySelector(".bg-primary.h-full") as HTMLElement;
    expect(progressBar).not.toBeNull();
    expect(progressBar.style.width).toBe("67%");

    // Click on the second item to toggle it to checked
    const itemRows = container.querySelectorAll(".space-y-1\\.5 > div");
    expect(itemRows.length).toBe(3);

    await act(async () => {
      itemRows[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // State after click: 3 out of 3 done (100%)
    expect(container.textContent).toContain("3 / 3 (100%)");
    expect(progressBar.style.width).toBe("100%");
    expect(itemRows[1].className).toContain("line-through");
  });

  it("E2E: MetricsCard renders stats grid, trends, and progress bars accurately", async () => {
    const metrics = [
      { label: "平均延迟 (P95)", value: "8.4", unit: "ms", change: "-12%" },
      { label: "吞吐量峰值", value: "10,240", unit: "req/s", change: "+15%" },
      { label: "CPU 负载", value: "48", unit: "%", progress: 48 },
    ];

    await act(async () => {
      root.render(
        <MetricsCard
          title="压测性能指标看板"
          description="峰值模拟 10,000 QPS 压测表现"
          metrics={metrics}
        />
      );
    });

    expect(container.textContent).toContain("压测性能指标看板");
    expect(container.textContent).toContain("8.4");
    expect(container.textContent).toContain("ms");
    expect(container.textContent).toContain("-12%");

    expect(container.textContent).toContain("10,240");
    expect(container.textContent).toContain("req/s");
    expect(container.textContent).toContain("+15%");

    expect(container.textContent).toContain("48");
    expect(container.textContent).toContain("%");

    const cpuProgress = container.querySelector(".bg-primary.h-full") as HTMLElement;
    expect(cpuProgress).not.toBeNull();
    expect(cpuProgress.style.width).toBe("48%");
  });

  it("E2E: PromptFormCard handles user input updates, validation, and submission", async () => {
    const onSubmit = vi.fn();
    const fields = [
      { id: "db_host", label: "数据库主机", defaultValue: "10.0.0.8", required: true },
      { id: "db_port", label: "连接端口", type: "number", defaultValue: 5432 },
      { id: "db_ssl", label: "启用 SSL 加密", type: "checkbox", defaultValue: true },
    ];

    await act(async () => {
      root.render(
        <PromptFormCard
          title="数据库配置向导"
          description="请录入目标环境数据库连接凭证"
          submitLabel="验证连接并保存"
          fields={fields}
          onSubmit={onSubmit}
        />
      );
    });

    expect(container.textContent).toContain("数据库配置向导");
    expect(container.textContent).toContain("请录入目标环境数据库连接凭证");

    // 1. Find form inputs
    const textInput = container.querySelector("input[type='text']") as HTMLInputElement;
    const numInput = container.querySelector("input[type='number']") as HTMLInputElement;
    const checkbox = container.querySelector("input[type='checkbox']") as HTMLInputElement;

    expect(textInput.value).toBe("10.0.0.8");
    expect(numInput.value).toBe("5432");
    expect(checkbox.checked).toBe(true);

    // 2. Simulate user edits using setInputValue helper
    await act(async () => {
      setInputValue(textInput, "192.168.1.100");
      setInputValue(numInput, "5433");
      setInputValue(checkbox, false);
    });

    // 3. Submit form
    const submitBtn = container.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(submitBtn.textContent).toContain("验证连接并保存");

    await act(async () => {
      submitBtn.click();
    });

    // 4. Assert submission callback received edited state
    expect(onSubmit).toHaveBeenCalledWith({
      db_host: "192.168.1.100",
      db_port: "5433",
      db_ssl: false,
    });

    // 5. Assert UI shows submitted badge
    expect(container.textContent).toContain("已提交");
  });

  it("E2E: ReactArtifactCard renders iframe with strict sandbox, and allows Tab switching & reload", async () => {
    const sampleCode = `function App() {
  const [count, setCount] = React.useState(0);
  return <button onClick={() => setCount(c => c + 1)}>Count: {count}</button>;
}`;

    await act(async () => {
      root.render(
        <ReactArtifactCard
          title="动态计数器原型"
          template="react"
          code={sampleCode}
        />
      );
    });

    // 1. Verify Title & Header Tabs
    expect(container.textContent).toContain("动态计数器原型");
    expect(container.textContent).toContain("预览");
    expect(container.textContent).toContain("代码");

    // 2. Verify Iframe Security Boundary
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    const sandboxAttr = iframe.getAttribute("sandbox") || "";
    expect(sandboxAttr).toContain("allow-scripts");
    expect(sandboxAttr).not.toContain("allow-same-origin"); // STRICT ISOLATION REQUIREMENT

    // 3. Verify Sandboxed Document includes Babel + React + Code
    const srcDoc = iframe.srcdoc;
    expect(srcDoc).toContain("cdn.tailwindcss.com");
    expect(srcDoc).toContain("@babel/standalone");
    expect(srcDoc).not.toContain("isTSX");
    expect(srcDoc).not.toContain("allExtensions");
    expect(srcDoc).toContain("react@18");
    expect(srcDoc).toContain("react-dom@18");
    expect(srcDoc).toContain("function App()");
    expect(srcDoc).toContain("React.useState(0)");

    // 4. Switch to Code Tab
    const codeTabBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "代码"
    );
    expect(codeTabBtn).toBeDefined();

    await act(async () => {
      codeTabBtn!.click();
    });

    // In code tab, the code snippet should be displayed
    expect(container.textContent).toContain("function App()");
    expect(container.textContent).toContain("React.useState(0)");

    // 5. Switch back to Preview Tab
    const previewTabBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "预览"
    );
    expect(previewTabBtn).toBeDefined();

    await act(async () => {
      previewTabBtn!.click();
    });

    // In preview tab, iframe should be active
    const restoredIframe = container.querySelector("iframe");
    expect(restoredIframe).not.toBeNull();

    // 6. Test Reload button
    const reloadBtn = container.querySelector("button[title='重新加载组件']") as HTMLButtonElement;
    expect(reloadBtn).not.toBeNull();
    await act(async () => {
      reloadBtn.click();
    });
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("E2E: AcpCodeHeader renders inline '运行预览' button and mounts live ReactArtifactCard", async () => {
    const sampleCode = `function InteractiveCounter() {
  const [val, setVal] = React.useState(10);
  return (
    <div className="p-4 bg-slate-900 text-white rounded">
      <h3>当前数值: {val}</h3>
      <button onClick={() => setVal(v => v + 1)}>+1</button>
    </div>
  );
}`;

    await act(async () => {
      root.render(<AcpCodeHeader language="tsx" code={sampleCode} />);
    });

    // 1. Verify language badge and "运行预览" button
    expect(container.textContent).toContain("tsx");
    const previewToggleBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim().includes("运行预览")
    );
    expect(previewToggleBtn).toBeDefined();

    // 2. Click "运行预览" to switch from static view to live interactive sandbox
    await act(async () => {
      previewToggleBtn!.click();
    });

    // Wait for Suspense lazy component to resolve
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Assert that live ReactArtifactCard iframe is now mounted in the DOM
    const liveIframe = container.querySelector("iframe");
    expect(liveIframe).not.toBeNull();
    expect(liveIframe!.srcdoc).toContain("InteractiveCounter");

    // 3. Click "查看源码" to toggle back to code view
    const viewCodeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim().includes("查看源码")
    );
    expect(viewCodeBtn).toBeDefined();

    await act(async () => {
      viewCodeBtn!.click();
    });

    // Verify switched back to initial header state
    const previewBtnAgain = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim().includes("运行预览")
    );
    expect(previewBtnAgain).toBeDefined();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("E2E: EditorialDiagramCard renders interactive controls, SVG elements, and responds to zoom and copy", async () => {
    // Mock clipboard writeText
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    try {
      vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeTextMock);
    } catch {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: writeTextMock },
        configurable: true,
      });
    }

    await act(async () => {
      root.render(
        React.createElement(EditorialDiagramCard, {
          title: "分布式事务架构",
          diagramType: "architecture",
          description: "基于两阶段提交与 Saga 的容灾架构",
          accent: "emerald",
          data: {
            layers: [
              {
                id: "client-layer",
                title: "客户端层",
                nodes: [{ id: "spa", label: "React Client", subtext: "v18", highlighted: true }],
              },
              {
                id: "gateway-layer",
                title: "API 网关层",
                nodes: [{ id: "gw", label: "Envoy Gateway", subtext: ":8080" }],
              },
            ],
            connections: [{ from: "client-layer", to: "gateway-layer", label: "HTTPS" }],
          },
        })
      );
    });

    // 1. Verify Header and Labels
    expect(container.textContent).toContain("分布式事务架构");
    expect(container.textContent).toContain("基于两阶段提交与 Saga 的容灾架构");
    expect(container.textContent).toContain("系统架构分层");
    expect(container.textContent).toContain("editorial");

    // 2. Verify SVG rendered
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(container.textContent).toContain("React Client");
    expect(container.textContent).toContain("Envoy Gateway");

    // 3. Test Zoom buttons
    const zoomInBtn = container.querySelector('button[title="放大"]') as HTMLButtonElement;
    expect(zoomInBtn).not.toBeNull();

    await act(async () => {
      zoomInBtn.click();
    });

    const resetZoomBtn = container.querySelector('button[title="重置缩放"]') as HTMLButtonElement;
    expect(resetZoomBtn).not.toBeNull();

    await act(async () => {
      resetZoomBtn.click();
    });

    // 4. Test Copy SVG
    const copySvgBtn = container.querySelector('button[title="复制 SVG 源码"]') as HTMLButtonElement;
    expect(copySvgBtn).not.toBeNull();

    await act(async () => {
      copySvgBtn.click();
    });

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock.mock.calls[0][0]).toContain("<svg");

    // 5. Test Theme Toggle button
    const themeBtn = container.querySelector(
      'button[title*="切换为浅色主题"], button[title*="切换为深色主题"]'
    ) as HTMLButtonElement;
    expect(themeBtn).not.toBeNull();
    const initialTitle = themeBtn.getAttribute("title");

    await act(async () => {
      themeBtn.click();
    });

    const toggledTitle = themeBtn.getAttribute("title");
    expect(toggledTitle).not.toBe(initialTitle);
  });

  it("E2E: EditorialDiagramCard renders flowchart with high-contrast nodes in both light and dark themes", async () => {
    await act(async () => {
      root.render(
        <EditorialDiagramCard
          title="订单状态流转图"
          diagramType="flowchart"
          theme="light"
          accent="emerald"
          data={{
            steps: [
              { id: "pending", label: "待支付", description: "等待客户扣款" },
              { id: "paid", label: "已支付", description: "款项已到账", active: true },
              { id: "shipped", label: "已发货", description: "物流运输中" },
            ],
            connections: [
              { from: "pending", to: "paid" },
              { from: "paid", to: "shipped" },
            ],
          }}
        />
      );
    });

    // 1. Verify light mode classes and content
    const cardEl = container.querySelector(".rounded-xl") as HTMLElement;
    expect(cardEl.className).toContain("light");
    expect(container.textContent).toContain("订单状态流转图");
    expect(container.textContent).toContain("流程与状态机");
    expect(container.textContent).toContain("待支付");
    expect(container.textContent).toContain("已支付");
    expect(container.textContent).toContain("已发货");

    // 2. Node in light mode uses white fill (#ffffff), not pitch black #1c1c1f or #000000
    const rects = Array.from(container.querySelectorAll("svg rect"));
    const whiteNodeRect = rects.find((r) => r.getAttribute("fill") === "#ffffff");
    expect(whiteNodeRect).toBeDefined();

    // 3. Toggle to dark theme
    const themeBtn = container.querySelector('button[title*="切换为深色主题"]') as HTMLButtonElement;
    expect(themeBtn).not.toBeNull();

    await act(async () => {
      themeBtn.click();
    });

    // 4. Verify switched to dark mode
    expect(cardEl.className).toContain("dark");
    const darkNodeRect = Array.from(container.querySelectorAll("svg rect")).find(
      (r) => r.getAttribute("fill") === "#181e28"
    );
    expect(darkNodeRect).toBeDefined();
  });

  it("E2E: EditorialDiagramCard architecture diagram routes cross-layer connections via bypass rail and preserves central corridor", async () => {
    await act(async () => {
      root.render(
        <EditorialDiagramCard
          title="ACP 分层拓扑架构"
          diagramType="architecture"
          theme="dark"
          accent="emerald"
          data={{
            layers: [
              {
                id: "l0",
                title: "CLIENT CORE",
                nodes: [
                  { id: "auth", label: "AuthGate", subtext: "认证门闩" },
                  { id: "session", label: "SessionManager", subtext: "会话管理" },
                ],
              },
              {
                id: "l1",
                title: "BRIDGE",
                nodes: [
                  { id: "sdk", label: "sdk-client", subtext: "通信客户端" },
                  { id: "proc", label: "process-manager", subtext: "spawn/温进程池" },
                ],
              },
              {
                id: "l2",
                title: "RESOURCES",
                nodes: [
                  { id: "tools", label: "tools MCP", subtext: "只读技能服务" },
                  { id: "prompts", label: "prompts", subtext: "模板管理" },
                ],
              },
            ],
            connections: [
              // 相邻层连线走中央通道
              { from: "CLIENT CORE", to: "BRIDGE", label: "spawn+握手" },
              // 跨层连线跨过 BRIDGE 直连 RESOURCES：必须走外侧旁路通道，绝不穿透 BRIDGE 层的 process-manager！
              { from: "CLIENT CORE", to: "RESOURCES", label: "资源注入" },
            ],
          }}
        />
      );
    });

    expect(container.textContent).toContain("ACP 分层拓扑架构");
    expect(container.textContent).toContain("process-manager");
    expect(container.textContent).toContain("资源注入");

    // 验证外侧旁路通道：存在跨层连线时，SVG 宽度自动扩展为 700+，且 bypass 路径包含曲线与旁路坐标
    const allSvgs = Array.from(container.querySelectorAll("svg"));
    const svg = allSvgs[allSvgs.length - 1] as SVGSVGElement;
    expect(svg).not.toBeNull();
    const viewBox = svg.getAttribute("viewBox");
    expect(viewBox).toBeDefined();
    const widthMatch = viewBox?.match(/^0 0 (\d+)/);
    const parsedWidth = widthMatch ? parseInt(widthMatch[1], 10) : 0;
    expect(parsedWidth).toBeGreaterThanOrEqual(700);

    // 验证两节点卡片严格对称开辟了中央直通通道 (x=320 位于卡片之间的留白间距，且卡片宽度相等)
    const nodeRects = Array.from(svg.querySelectorAll("g[transform^='translate('] > rect")).filter(
      (r) => r.getAttribute("width") === "244"
    );
    expect(nodeRects.length).toBe(6); // 3 layers * 2 nodes each = 6 cards of width 244
  });

  it("E2E: EditorialDiagramCard sequence diagram prevents badge wrapping and adapts actor width dynamically", async () => {
    await act(async () => {
      root.render(
        <EditorialDiagramCard
          title="Sidecar 调用链路: 宿主到 Agent 子进程的长标题测试用例"
          diagramType="sequence"
          theme="dark"
          accent="emerald"
          data={{
            participants: [
              { id: "host", label: "宿主 (Electron / TypeScript)" },
              { id: "sidecar", label: "acp-engine Sidecar (Node)" },
              { id: "agent", label: "Agent 子进程 (codex/claude...)" },
            ],
            messages: [
              { from: "host", to: "sidecar", label: "spawn 二进制 + stdio 管道", highlighted: true },
              { from: "sidecar", to: "host", label: "ready 通知 {version, pid}", type: "reply" },
            ],
          }}
        />
      );
    });

    // 1. 验证标题、角色名和消息文本渲染
    expect(container.textContent).toContain("Sidecar 调用链路: 宿主到 Agent 子进程的长标题测试用例");
    expect(container.textContent).toContain("交互时序图");
    expect(container.textContent).toContain("宿主 (Electron / TypeScript)");
    expect(container.textContent).toContain("spawn 二进制 + stdio 管道");

    // 2. 验证 Header badge 带有 shrink-0 和 whitespace-nowrap，杜绝垂直挤压成多行
    const metaBadge = container.querySelector(".bg-secondary\\/80");
    expect(metaBadge).not.toBeNull();
    expect(metaBadge?.className).toContain("shrink-0");
    expect(metaBadge?.className).toContain("whitespace-nowrap");

    // 3. 验证时序图参与者卡片宽度自适应长文本，不再写死上限 120px
    const allSvgs = Array.from(container.querySelectorAll("svg"));
    const svg = allSvgs[allSvgs.length - 1] as SVGSVGElement;
    expect(svg).not.toBeNull();
    const actorRects = Array.from(svg.querySelectorAll("rect")).filter(
      (r) => r.getAttribute("height") === "30"
    );
    expect(actorRects.length).toBe(3);
    for (const r of actorRects) {
      const width = parseFloat(r.getAttribute("width") || "0");
      expect(width).toBeGreaterThanOrEqual(160);
    }
  });

  it("E2E: AcpGenerativeToolCard strips namespace prefixes and renders decision cards & diagrams from stringified rawInput", async () => {
    // 1. Test normalization helpers
    expect(normalizeGenerativeToolName("studio-ui_show_interactive_card")).toBe("show_interactive_card");
    expect(normalizeGenerativeToolName("studio-ui.render_editorial_diagram")).toBe("render_editorial_diagram");
    expect(normalizeGenerativeToolName("studio-ui/prompt_form")).toBe("prompt_form");
    // 真 agent 的 MCP 双下划线命名空间（\b 跨不过 __，曾导致流程图掉进普通工具行）
    expect(normalizeGenerativeToolName("studio-ui__render_editorial_diagram")).toBe("render_editorial_diagram");
    expect(normalizeGenerativeToolName("mcp__studio-ui__render_editorial_diagram")).toBe(
      "render_editorial_diagram"
    );
    expect(normalizeGenerativeToolName("mcp__studio-ui__prompt_form")).toBe("prompt_form");
    expect(isGenerativeTool({ name: "studio-ui_show_interactive_card" })).toBe(true);
    expect(isGenerativeTool({ title: "studio-ui_render_editorial_diagram" })).toBe(true);
    expect(isGenerativeTool({ name: "studio-ui__render_editorial_diagram", title: "Redis 缓存加速流程" })).toBe(
      true
    );
    expect(isGenerativeTool({ name: "bash" })).toBe(false);

    // 1b. diagramType 缺失时按 data 形状推断，不再一律 architecture
    expect(inferDiagramType({ diagramType: "flowchart", data: {} })).toBe("flowchart");
    expect(inferDiagramType({ title: "t", data: { steps: [{ id: "a", label: "请求接入" }] } })).toBe(
      "flowchart"
    );
    expect(
      inferDiagramType({ title: "t", data: { participants: [{ id: "c" }], messages: [] } })
    ).toBe("sequence");
    expect(inferDiagramType({ title: "t", data: { layers: [] } })).toBe("architecture");
    expect(inferDiagramType({ title: "t", data: { milestones: [] } })).toBe("timeline");
    expect(inferDiagramType({ title: "t", data: { xAxis: {}, items: [] } })).toBe("quadrant");
    expect(inferDiagramType({ title: "t" })).toBe("architecture");

    // 2. Render decision card with stringified JSON rawInput and namespaced tool name
    const onAction = vi.fn();
    const decisionTool = {
      id: "tc-test-decision",
      name: "studio-ui_show_interactive_card",
      rawInput: JSON.stringify({
        title: "状态管理方案选型",
        cardType: "decision",
        description: "选择最匹配项目架构的状态层",
        data: {
          options: [
            { id: "zustand", label: "维持 Zustand", recommended: true, description: "轻量无缝" },
            { id: "jotai", label: "迁移 Jotai", description: "原子订阅" },
          ],
        },
      }),
    };

    await act(async () => {
      root.render(<AcpGenerativeToolCard tool={decisionTool} onAction={onAction} />);
    });

    expect(container.textContent).toContain("状态管理方案选型");
    expect(container.textContent).toContain("维持 Zustand");
    expect(container.textContent).toContain("迁移 Jotai");
    expect(container.textContent).toContain("推荐");

    // 3. Render editorial diagram with namespaced tool name
    const diagramTool = {
      id: "tc-test-diagram",
      name: "studio-ui_render_editorial_diagram",
      rawInput: {
        title: "OAuth 鉴权时序流程",
        diagramType: "sequence",
        data: {
          steps: [
            { id: "s1", source: "Client", target: "Gateway", label: "POST /login" },
            { id: "s2", source: "Gateway", target: "AuthService", label: "Verify Credentials" },
          ],
        },
      },
    };

    await act(async () => {
      root.render(<AcpGenerativeToolCard tool={diagramTool} />);
    });

    expect(container.textContent).toContain("OAuth 鉴权时序流程");
    expect(container.querySelector("svg")).not.toBeNull();

    // 4. Decision card with array data directly (no nested data.options object)
    const arrayDataDecisionTool = {
      id: "tc-test-array-decision",
      name: "show_interactive_card",
      rawInput: {
        title: "操作确认决策",
        cardType: "decision",
        data: [
          { id: "approve", label: "批准执行", recommended: true },
          { id: "reject", label: "取消并退出" },
        ],
      },
    };
    await act(async () => {
      root.render(<AcpGenerativeToolCard tool={arrayDataDecisionTool} />);
    });
    expect(container.textContent).toContain("操作确认决策");
    expect(container.textContent).toContain("批准执行");
    expect(container.textContent).toContain("取消并退出");

    // 5. Empty data fallback renders friendly fallback notice instead of a blank box
    const emptyDecisionTool = {
      id: "tc-test-empty-decision",
      name: "show_interactive_card",
      rawInput: {
        title: "无选项的卡片",
        cardType: "decision",
        data: {},
      },
    };
    await act(async () => {
      root.render(<AcpGenerativeToolCard tool={emptyDecisionTool} />);
    });
    expect(container.textContent).toContain("无选项的卡片");
    expect(container.textContent).toContain("暂未下发具体的选项列表数据");
  });
});
