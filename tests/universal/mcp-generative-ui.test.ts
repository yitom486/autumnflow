import { describe, it, expect, afterAll } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { startMcpUiServer, stopMcpUiServer, getMcpUiServerInfo } from "../../server/universal/mcp-ui-server";
import { listStudioSkills, getStudioSkill, getStudioSkillsDir } from "../../server/universal/studio-skills";
import { convertAcpMessages } from "../../src/lib/acp-assistant";
import { DecisionCard, ChecklistCard, MetricsCard, PromptFormCard } from "../../src/components/assistant/GenerativeCards";
import { ReactArtifactCard } from "../../src/components/assistant/ReactArtifactCard";
import { EditorialDiagramCard } from "../../src/components/assistant/EditorialDiagramCard";

describe("AutumnFlow - 5-Digit MCP Server & Generative UI", () => {
  let mcpSessionId = "";

  afterAll(async () => {
    await stopMcpUiServer();
  });

  it("boots the 5-digit MCP server with auto-increment fallback on a dedicated port >= 10000", async () => {
    const info = await startMcpUiServer(13920);
    expect(info.port).toBeGreaterThanOrEqual(10000);
    expect(info.url).toContain(`:${info.port}/mcp`);
    expect(getMcpUiServerInfo()?.port).toBe(info.port);

    // Verify /health endpoint returns server details
    const res = await fetch(`http://127.0.0.1:${info.port}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.name).toBe("studio-ui");
    expect(data.port).toBe(info.port);
    expect(data.endpoint).toContain("/mcp");

    // Verify /mcp endpoint accepts Streamable HTTP requests
    const mcpRes = await fetch(`http://127.0.0.1:${info.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "init-1",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    expect(mcpRes.status).toBe(200);
    mcpSessionId = mcpRes.headers.get("mcp-session-id") || "";
  });

  it("maps ACP generative UI tool calls with full structured args and rawOutput in convertAcpMessages", () => {
    const msg = {
      id: "msg-gen-ui",
      role: "assistant" as const,
      content: "这里是结论",
      timestamp: "12:00",
      toolCalls: [
        {
          id: "tc-card-1",
          name: "show_interactive_card",
          title: "show_interactive_card",
          status: "completed" as const,
          rawInput: {
            title: "重构技术选型",
            cardType: "decision",
            data: {
              options: [
                { id: "opt-a", label: "方案 A", recommended: true },
                { id: "opt-b", label: "方案 B" },
              ],
            },
          },
          rawOutput: { status: "ok" },
        },
        {
          id: "tc-sandbox-1",
          name: "render_react_sandbox",
          title: "render_react_sandbox",
          status: "completed" as const,
          rawInput: {
            title: "倒计时组件原型",
            code: "function App() { return <div>Timer</div>; }",
            template: "react",
          },
        },
      ],
    };

    const converted = convertAcpMessages([msg]);
    expect(converted.length).toBe(1);
    const part0 = converted[0].content[0] as any;
    expect(part0.type).toBe("tool-call");
    expect(part0.toolName).toBe("show_interactive_card");
    expect(part0.args.title).toBe("重构技术选型");
    expect(part0.args.cardType).toBe("decision");
    expect(part0.result).toEqual({ status: "ok" });

    const part1 = converted[0].content[1] as any;
    expect(part1.type).toBe("tool-call");
    expect(part1.toolName).toBe("render_react_sandbox");
    expect(part1.args.code).toContain("Timer");
  });

  it("renders Generative UI decision, checklist, metrics, and prompt form components smoothly", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement("div", null, [
          React.createElement(DecisionCard, {
            key: "dec",
            title: "发布目标环境",
            description: "选择部署集群",
            options: [
              { id: "prod", label: "生产环境", recommended: true },
              { id: "staging", label: "预发环境" },
            ],
          }),
          React.createElement(ChecklistCard, {
            key: "chk",
            title: "发布检查清单",
            items: [
              { id: "build", label: "打包通过", checked: true },
              { id: "tests", label: "门禁测试", checked: false },
            ],
          }),
          React.createElement(MetricsCard, {
            key: "met",
            title: "系统指标",
            metrics: [
              { label: "吞吐量", value: "1,200", unit: "req/s" },
              { label: "P99 延迟", value: "12", unit: "ms" },
            ],
          }),
          React.createElement(PromptFormCard, {
            key: "form",
            title: "数据库连接配置",
            fields: [
              { id: "host", label: "主机地址", defaultValue: "127.0.0.1" },
              { id: "port", label: "端口号", defaultValue: 5432 },
            ],
          }),
        ])
      );
    });

    expect(container.textContent).toContain("发布目标环境");
    expect(container.textContent).toContain("生产环境");
    expect(container.textContent).toContain("推荐");
    expect(container.textContent).toContain("发布检查清单");
    expect(container.textContent).toContain("打包通过");
    expect(container.textContent).toContain("系统指标");
    expect(container.textContent).toContain("吞吐量");
    expect(container.textContent).toContain("数据库连接配置");
    expect(container.textContent).toContain("主机地址");

    act(() => root.unmount());
    container.remove();
  });

  it("renders ReactArtifactCard with iframe sandbox='allow-scripts' without leaking privileges", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement(ReactArtifactCard, {
          code: "function App() { return <div>Hello Sandbox</div>; }",
          template: "react",
          title: "测试组件",
        })
      );
    });

    expect(container.textContent).toContain("测试组件");
    expect(container.textContent?.toLowerCase()).toContain("react");

    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    // Invariant: sandbox must be allow-scripts and strictly NEVER allow-same-origin
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin");

    act(() => root.unmount());
    container.remove();
  });

  it("renders EditorialDiagramCard with SVG architecture, sequence, and quadrant layouts", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement("div", null, [
          React.createElement(EditorialDiagramCard, {
            key: "arch",
            title: "微服务容器架构",
            diagramType: "architecture",
            accent: "emerald",
            data: {
              layers: [
                {
                  id: "l1",
                  title: "接入网关层",
                  nodes: [
                    { id: "n1", label: "Traefik Gateway", subtext: "Port 443", highlighted: true },
                    { id: "n2", label: "Auth Proxy", subtext: "OIDC" },
                  ],
                },
                {
                  id: "l2",
                  title: "核心服务层",
                  nodes: [
                    { id: "n3", label: "User Service", subtext: "Node.js" },
                    { id: "n4", label: "Payment Service", subtext: "Go" },
                  ],
                },
              ],
              connections: [{ from: "l1", to: "l2", label: "gRPC" }],
            },
          }),
          React.createElement(EditorialDiagramCard, {
            key: "seq",
            title: "OAuth 授权时序",
            diagramType: "sequence",
            accent: "blue",
            data: {
              participants: [
                { id: "client", label: "Web Client" },
                { id: "server", label: "API Gateway" },
                { id: "db", label: "Postgres" },
              ],
              messages: [
                { from: "client", to: "server", label: "POST /login", highlighted: true },
                { from: "server", to: "db", label: "SELECT * FROM users" },
                { from: "server", to: "client", label: "200 OK + JWT", dashed: true },
              ],
            },
          }),
        ])
      );
    });

    expect(container.textContent).toContain("微服务容器架构");
    expect(container.textContent).toContain("Traefik Gateway");
    expect(container.textContent).toContain("OAuth 授权时序");
    expect(container.textContent).toContain("Web Client");
    expect(container.textContent).toContain("POST /login");

    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThanOrEqual(2);

    act(() => root.unmount());
    container.remove();
  });

  it("discovers built-in Studio skills (diagram-design, generative-ui) with frontmatter metadata", () => {
    const skills = listStudioSkills();
    expect(skills.length).toBeGreaterThanOrEqual(2);

    const diagram = skills.find((s) => s.name === "diagram-design");
    expect(diagram).toBeDefined();
    expect(diagram!.title).toContain("出版级矢量图表设计");

    const genUi = skills.find((s) => s.name === "generative-ui");
    expect(genUi).toBeDefined();
    expect(genUi!.title).toContain("生成式富交互卡片");

    const fullSkill = getStudioSkill("diagram-design");
    expect(fullSkill).not.toBeNull();
    expect(fullSkill!.content).toContain("1-Accent Principle");
    expect(fullSkill!.content).toContain("architecture");
  });

  it("calls list_studio_skills and get_studio_skill via MCP JSON-RPC tools/call", async () => {
    const info = getMcpUiServerInfo();
    expect(info).not.toBeNull();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {}),
    };

    // 1. Call list_studio_skills
    const listRes = await fetch(`http://127.0.0.1:${info!.port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "call-skills-list",
        method: "tools/call",
        params: {
          name: "list_studio_skills",
          arguments: {},
        },
      }),
    });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.result.content[0].text).toContain("diagram-design");

    // 2. Call get_studio_skill for diagram-design
    const getRes = await fetch(`http://127.0.0.1:${info!.port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "call-get-skill",
        method: "tools/call",
        params: {
          name: "get_studio_skill",
          arguments: { name: "diagram-design" },
        },
      }),
    });
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.result.content[0].text).toContain("出版级矢量图表设计指南");
    expect(getData.result.content[0].text).toContain("architecture");
  });
});
