import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { UniversalAgentConnection } from "../../server/universal/AgentConnection";
import { startMcpUiServer, stopMcpUiServer, getMcpUiServerInfo } from "../../server/universal/mcp-ui-server";

describe("MCP Integration Pipeline - Mock LLM Agent Tool Calls & Auto-Injection", () => {
  let conn: UniversalAgentConnection;
  const fixturePath = path.resolve(__dirname, "../fixtures/mock-acp-agent.ts");

  beforeAll(async () => {
    // 1. Ensure 5-digit MCP server is running
    await startMcpUiServer(13920);

    // 2. Connect to Deterministic Mock ACP Agent
    conn = new UniversalAgentConnection({
      id: "mock-gen-agent",
      name: "Mock Generative Agent",
      command: process.platform === "win32" ? "bun.exe" : "bun",
      args: ["run", fixturePath],
    });
    await conn.connect();
  });

  afterAll(async () => {
    await conn.disconnect();
    await stopMcpUiServer();
  });

  it("verifies 5-digit MCP server auto-injection into session/new request to agent", async () => {
    const mcpInfo = getMcpUiServerInfo();
    expect(mcpInfo).not.toBeNull();
    expect(mcpInfo!.port).toBeGreaterThanOrEqual(10000);

    const sessionRes: any = await conn.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: "custom-user-mcp", command: "test", args: [], env: [] }],
    });

    expect(sessionRes).toHaveProperty("sessionId");
    const sid = sessionRes.sessionId;

    // Trigger session inspection scenario on mock agent to verify what mcpServers were received
    const replayed: any[] = [];
    await conn.prompt(
      sid,
      [{ type: "text", text: "trigger_inspect_session" }],
      (evt: any) => {
        if (evt.type === "update") replayed.push(evt.update);
      }
    );

    const chunk = replayed.find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(chunk).toBeDefined();
    const inspected = JSON.parse(chunk.content.text);

    // Assert that studio-ui was automatically injected alongside user mcp servers!
    const studioMcp = inspected.mcpServers.find((s: any) => s.name === "studio-ui");
    expect(studioMcp).toBeDefined();
    expect(studioMcp.type).toBe("http");
    expect(studioMcp.url).toContain(`:${mcpInfo!.port}/mcp`);

    const customMcp = inspected.mcpServers.find((s: any) => s.name === "custom-user-mcp");
    expect(customMcp).toBeDefined();

    // Application configuration must not be added to writable workspace roots.
    expect(inspected.additionalDirectories).toEqual([]);
  });

  it("omits the studio-ui HTTP MCP server when the agent does not advertise mcpCapabilities.http", async () => {
    // OpenCode/DSH both advertise http, but an agent that does not must not
    // receive an HTTP descriptor it cannot mount (ACP requires capability).
    const gated = new UniversalAgentConnection({
      id: "mock-http-off",
      name: "Mock HTTP Off",
      command: process.platform === "win32" ? "bun.exe" : "bun",
      args: ["run", fixturePath],
      env: { MOCK_MCP_HTTP: "0" },
    });
    try {
      await gated.connect();
      const sessionRes: any = await gated.newSession({ cwd: process.cwd() });
      const replayed: any[] = [];
      await gated.prompt(
        sessionRes.sessionId,
        [{ type: "text", text: "trigger_inspect_session" }],
        (evt: any) => {
          if (evt.type === "update") replayed.push(evt.update);
        }
      );
      const chunk = replayed.find((u) => u.sessionUpdate === "agent_message_chunk");
      const inspected = JSON.parse(chunk.content.text);
      expect(inspected.mcpServers.some((s: any) => s.name === "studio-ui")).toBe(false);
    } finally {
      await gated.disconnect().catch(() => undefined);
    }
  });

  it("simulates mock LLM output stream delivering full set of Generative UI tool calls", async () => {
    const sessionRes: any = await conn.newSession({ cwd: process.cwd() });
    const sid = sessionRes.sessionId;

    const collectedUpdates: any[] = [];

    // Trigger the mock LLM generative UI tool call sequence
    const result: any = await conn.prompt(
      sid,
      [{ type: "text", text: "trigger_generative_ui" }],
      (evt: any) => {
        if (evt.type === "update") collectedUpdates.push(evt.update);
      }
    );

    expect(result.stopReason).toBe("end_turn");

    // Extract all tool_call updates
    const toolCalls = collectedUpdates.filter((u) => u.sessionUpdate === "tool_call");
    expect(toolCalls.length).toBe(6);

    // 1. Verify Decision Card tool call
    const decisionTc = toolCalls.find((t) => t.toolCallId === "tc-gen-decision");
    expect(decisionTc).toBeDefined();
    expect(decisionTc.name).toBe("show_interactive_card");
    expect(decisionTc.rawInput.title).toBe("微服务部署架构决策");
    expect(decisionTc.rawInput.cardType).toBe("decision");
    expect(decisionTc.rawInput.data.options.length).toBe(2);
    expect(decisionTc.rawInput.data.options[0].recommended).toBe(true);

    // 2. Verify Checklist Card tool call
    const checklistTc = toolCalls.find((t) => t.toolCallId === "tc-gen-checklist");
    expect(checklistTc).toBeDefined();
    expect(checklistTc.name).toBe("show_interactive_card");
    expect(checklistTc.rawInput.title).toBe("发布前门禁校验");
    expect(checklistTc.rawInput.cardType).toBe("checklist");
    expect(checklistTc.rawInput.data.items.length).toBe(3);

    // 3. Verify Metrics Card tool call
    const metricsTc = toolCalls.find((t) => t.toolCallId === "tc-gen-metrics");
    expect(metricsTc).toBeDefined();
    expect(metricsTc.name).toBe("show_interactive_card");
    expect(metricsTc.rawInput.cardType).toBe("metrics");
    expect(metricsTc.rawInput.data.metrics.length).toBe(3);

    // 4. Verify Prompt Form tool call
    const formTc = toolCalls.find((t) => t.toolCallId === "tc-gen-form");
    expect(formTc).toBeDefined();
    expect(formTc.name).toBe("prompt_form");
    expect(formTc.rawInput.title).toBe("数据库配置向导");
    expect(formTc.rawInput.fields.length).toBe(3);

    // 5. Verify React Sandbox tool call
    const sandboxTc = toolCalls.find((t) => t.toolCallId === "tc-gen-sandbox");
    expect(sandboxTc).toBeDefined();
    expect(sandboxTc.name).toBe("render_react_sandbox");
    expect(sandboxTc.rawInput.title).toBe("动态计数器原型");
    expect(sandboxTc.rawInput.template).toBe("react");
    expect(sandboxTc.rawInput.code).toContain("计数器原型");

    // 6. Verify Editorial Diagram tool call
    const diagramTc = toolCalls.find((t) => t.toolCallId === "tc-gen-diagram");
    expect(diagramTc).toBeDefined();
    expect(diagramTc.name).toBe("render_editorial_diagram");
    expect(diagramTc.rawInput.title).toBe("微服务容器架构拓扑");
    expect(diagramTc.rawInput.diagramType).toBe("architecture");
    expect(diagramTc.rawInput.accent).toBe("emerald");
    expect(diagramTc.rawInput.data.layers.length).toBe(2);

    // Verify final message chunk
    const textChunk = collectedUpdates.find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(textChunk).toBeDefined();
    expect(textChunk.content.text).toContain("已为您生成全套生成式 UI 交互卡片");
  });

  it("injects encouraging Generative UI & Editorial Diagram guidance on turn 0 of a session and avoids duplicate injection on turn 1+", async () => {
    const sessionRes: any = await conn.newSession({ cwd: process.cwd() });
    const sid = sessionRes.sessionId;

    // Turn 0: Send first prompt
    const turn0Updates: any[] = [];
    await conn.prompt(
      sid,
      [{ type: "text", text: "trigger_inspect_prompt" }],
      (evt: any) => {
        if (evt.type === "update") turn0Updates.push(evt.update);
      }
    );

    const chunk0 = turn0Updates.find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(chunk0).toBeDefined();
    const data0 = JSON.parse(chunk0.content.text);
    // Should have 2 blocks: [0] client hint, [1] user trigger
    expect(data0.promptBlocks.length).toBe(2);
    expect(data0.promptBlocks[0].text).toContain("【客户端交互能力与体验建议 / Client Interactive Capabilities】");
    expect(data0.promptBlocks[0].text).toContain("render_editorial_diagram");
    expect(data0.promptBlocks[0].text).toContain("show_interactive_card");
    expect(data0.promptBlocks[1].text).toContain("trigger_inspect_prompt");

    // Turn 1: Send second prompt in the same session
    const turn1Updates: any[] = [];
    await conn.prompt(
      sid,
      [{ type: "text", text: "trigger_inspect_prompt" }],
      (evt: any) => {
        if (evt.type === "update") turn1Updates.push(evt.update);
      }
    );

    const chunk1 = turn1Updates.find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(chunk1).toBeDefined();
    const data1 = JSON.parse(chunk1.content.text);
    // Should have only 1 block on subsequent turns (no duplicate hint)
    expect(data1.promptBlocks.length).toBe(1);
    expect(data1.promptBlocks[0].text).toContain("trigger_inspect_prompt");
    expect(data1.promptBlocks[0].text).not.toContain("【客户端交互能力与体验建议");
  });

  it("discovers application skills through MCP without granting write access to configuration", async () => {
    const sessionRes: any = await conn.newSession({ cwd: process.cwd() });
    const sid = sessionRes.sessionId;

    const collectedUpdates: any[] = [];
    await conn.prompt(
      sid,
      [{ type: "text", text: "trigger_discover_skills" }],
      (evt: any) => {
        if (evt.type === "update") collectedUpdates.push(evt.update);
      }
    );

    const chunk = collectedUpdates.find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(chunk).toBeDefined();
    const data = JSON.parse(chunk.content.text);

    // Unverified runtimes use the read-only MCP entry, not a writable config root.
    expect(data.fsDiscovery.skillsDir).toBeNull();

    // 2. MCP protocol discovery via injected studio-ui server
    expect(data.mcpDiscovery.status).toBe("ok");
    expect(data.mcpDiscovery.listContent).toContain("diagram-design");
    expect(data.mcpDiscovery.listContent).toContain("generative-ui");
    expect(data.mcpDiscovery.skillContent).toContain("出版级矢量图表设计指南");
    expect(data.mcpDiscovery.skillContent).toContain("1-Accent Principle");
  });

  it("delivers OpenCode tool-directory guidance on first prompt and after restoring a session", async () => {
    const opencode = new UniversalAgentConnection({
      id: "opencode", name: "OpenCode mock", command: process.platform === "win32" ? "bun.exe" : "bun",
      args: ["run", fixturePath],
    });
    try {
      await opencode.connect();
      const session: any = await opencode.newSession({ cwd: process.cwd() });
      const inspect = async () => {
        const updates: any[] = [];
        await opencode.prompt(session.sessionId, [{ type: "text", text: "trigger_inspect_prompt" }], evt => {
          if (evt.type === "update") updates.push(evt.update);
        });
        return JSON.parse(updates.find(update => update.sessionUpdate === "agent_message_chunk").content.text).promptBlocks;
      };
      const first = await inspect();
      const guidance = first.find((block: any) => block.text?.includes("【OpenCode 交互指引】"));
      expect(guidance.text).toContain('tools["studio-ui"]');
      expect(guidance.text).toContain("search");
      expect((await inspect()).some((block: any) => block.text?.includes("【OpenCode 交互指引】"))).toBe(false);
      await opencode.resumeSession({ sessionId: session.sessionId, cwd: process.cwd() });
      expect((await inspect()).some((block: any) => block.text?.includes('tools["studio-ui"]'))).toBe(true);
    } finally {
      await opencode.disconnect();
    }
  });

  it("ensures multiple concurrent sessions discover skills independently with strict isolation", async () => {
    // Open Session A and Session B concurrently
    const sessA: any = await conn.newSession({ cwd: process.cwd() });
    const sessB: any = await conn.newSession({ cwd: process.cwd() });
    expect(sessA.sessionId).not.toBe(sessB.sessionId);

    // Verify Session A gets Turn 0 prompt hint
    const updatesA: any[] = [];
    await conn.prompt(
      sessA.sessionId,
      [{ type: "text", text: "trigger_inspect_prompt" }],
      (evt: any) => {
        if (evt.type === "update") updatesA.push(evt.update);
      }
    );
    const chunkA = updatesA.find((u) => u.sessionUpdate === "agent_message_chunk");
    const dataA = JSON.parse(chunkA.content.text);
    expect(dataA.promptBlocks.length).toBe(2);
    expect(dataA.promptBlocks[0].text).toContain("【客户端交互能力与体验建议");

    // Verify Session B independently gets Turn 0 prompt hint
    const updatesB: any[] = [];
    await conn.prompt(
      sessB.sessionId,
      [{ type: "text", text: "trigger_inspect_prompt" }],
      (evt: any) => {
        if (evt.type === "update") updatesB.push(evt.update);
      }
    );
    const chunkB = updatesB.find((u) => u.sessionUpdate === "agent_message_chunk");
    const dataB = JSON.parse(chunkB.content.text);
    expect(dataB.promptBlocks.length).toBe(2);
    expect(dataB.promptBlocks[0].text).toContain("【客户端交互能力与体验建议");

    // Close Session A and verify Session B remains completely operational
    await conn.closeSession({ sessionId: sessA.sessionId });

    const updatesB2: any[] = [];
    await conn.prompt(
      sessB.sessionId,
      [{ type: "text", text: "trigger_inspect_prompt" }],
      (evt: any) => {
        if (evt.type === "update") updatesB2.push(evt.update);
      }
    );
    const chunkB2 = updatesB2.find((u) => u.sessionUpdate === "agent_message_chunk");
    const dataB2 = JSON.parse(chunkB2.content.text);
    // Turn 1 on Session B: exactly 1 block, no hint
    expect(dataB2.promptBlocks.length).toBe(1);

    await conn.closeSession({ sessionId: sessB.sessionId });
  });

  it("verifies session/resume and session/load automatically inject studio-ui MCP and skills directory with turn-0 onboarding", async () => {
    const mcpInfo = getMcpUiServerInfo();
    expect(mcpInfo).not.toBeNull();

    // 1. Test resumeSession
    const resumeRes: any = await conn.resumeSession({
      sessionId: "test-resumed-session-1",
      cwd: process.cwd(),
      mcpServers: [{ name: "caller-mcp", command: "cmd", args: [], env: [] }],
    });
    expect(resumeRes.sessionId).toBe("test-resumed-session-1");

    // Inspect resumed session parameters
    const resumeInspectUpdates: any[] = [];
    await conn.prompt(
      "test-resumed-session-1",
      [{ type: "text", text: "trigger_inspect_session" }],
      (evt: any) => {
        if (evt.type === "update") resumeInspectUpdates.push(evt.update);
      }
    );
    const resumeChunk = resumeInspectUpdates.find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(resumeChunk).toBeDefined();
    const resumeData = JSON.parse(resumeChunk.content.text);

    // Assert studio-ui MCP was auto-injected on resume!
    const resumeStudioMcp = resumeData.mcpServers.find((s: any) => s.name === "studio-ui");
    expect(resumeStudioMcp).toBeDefined();
    expect(resumeStudioMcp.type).toBe("http");
    expect(resumeStudioMcp.url).toContain(`:${mcpInfo!.port}/mcp`);

    // Assert caller mcp was preserved
    expect(resumeData.mcpServers.some((s: any) => s.name === "caller-mcp")).toBe(true);

    // Assert skillsDir was auto-injected in additionalDirectories on resume!
    expect(resumeData.additionalDirectories).toEqual([]);

    // 2. Test loadSession
    const { result: loadRes } = await conn.loadSession({
      sessionId: "test-loaded-session-2",
      cwd: process.cwd(),
    });
    expect((loadRes as any).sessionId).toBe("test-loaded-session-2");

    const loadInspectUpdates: any[] = [];
    await conn.prompt(
      "test-loaded-session-2",
      [{ type: "text", text: "trigger_inspect_session" }],
      (evt: any) => {
        if (evt.type === "update") loadInspectUpdates.push(evt.update);
      }
    );
    const loadChunk = loadInspectUpdates.find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(loadChunk).toBeDefined();
    const loadData = JSON.parse(loadChunk.content.text);

    const loadStudioMcp = loadData.mcpServers.find((s: any) => s.name === "studio-ui");
    expect(loadStudioMcp).toBeDefined();
    expect(loadStudioMcp.type).toBe("http");
    expect(loadData.additionalDirectories).toEqual([]);

    await conn.closeSession({ sessionId: "test-resumed-session-1" });
    await conn.closeSession({ sessionId: "test-loaded-session-2" });
  });
});
