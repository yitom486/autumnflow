import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import {
  AcpClient,
  AcpSessionHandle,
  AcpTerminalManager,
  BUILTIN_ACP_RUNTIMES,
  getAcpRuntimeAdapter,
  codexAdapter,
  claudeAdapter,
  cursorAdapter,
  deepseekAdapter,
  geminiAdapter,
  copilotAdapter,
  opencodeAdapter,
  agyAdapter,
  getAcpProviderCodexHome,
  resolveCodexHome,
  runConnectAuthGate,
  decideConnectAuth,
  readAcpProxySettings,
  buildAcpProxySpawnEnv,
  getDefaultAgentDataDir,
  listLiveAcpRuntimeIds,
  type AcpRuntimeInfo,
} from "@yitom/acp-client";

describe("@yitom/acp-client integration in antigravity-acp", () => {
  it("exports BUILTIN_ACP_RUNTIMES with 9 official runtime definitions", () => {
    expect(Array.isArray(BUILTIN_ACP_RUNTIMES)).toBe(true);
    expect(BUILTIN_ACP_RUNTIMES.length).toBe(9);

    const runtimeIds = BUILTIN_ACP_RUNTIMES.map((r) => r.id);
    expect(runtimeIds).toContain("codex-acp");
    expect(runtimeIds).toContain("claude");
    expect(runtimeIds).toContain("cursor-cli");
    expect(runtimeIds).toContain("deepseek");
    expect(runtimeIds).toContain("gemini");
    expect(runtimeIds).toContain("copilot");
    expect(runtimeIds).toContain("opencode");
    expect(runtimeIds).toContain("opencode-v2");
    expect(runtimeIds).toContain("agy");

    for (const r of BUILTIN_ACP_RUNTIMES) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.name).toBe("string");
      expect(typeof r.command).toBe("string");
      expect(Array.isArray(r.args)).toBe(true);
    }
  });

  it("provides runtime adapters for all 8 runtimes", () => {
    const adapters = [
      codexAdapter,
      claudeAdapter,
      cursorAdapter,
      deepseekAdapter,
      geminiAdapter,
      copilotAdapter,
      opencodeAdapter,
      agyAdapter,
    ];

    for (const a of adapters) {
      expect(a).toBeDefined();
      expect(typeof a.id).toBe("string");
      expect(typeof a.probeAuth).toBe("function");

      const lookup = getAcpRuntimeAdapter(a.id);
      expect(lookup.id).toBe(a.id);
    }
  });

  it("can probe auth state for each runtime without throwing", () => {
    const runtimes = [
      "codex-acp",
      "claude",
      "cursor-cli",
      "deepseek",
      "gemini",
      "copilot",
      "opencode",
      "agy",
    ];

    for (const id of runtimes) {
      const adapter = getAcpRuntimeAdapter(id);
      const preflight = adapter.probeAuth();
      expect(preflight).toBeDefined();
      expect(typeof preflight.looksLoggedIn).toBe("boolean");
      expect(typeof preflight.hasAuthFile).toBe("boolean");
      expect(typeof preflight.hasApiKeyEnv).toBe("boolean");
    }
  });

  it("evaluates auth gate and resolves codex home paths", async () => {
    const home = await getAcpProviderCodexHome();
    expect(home === null || typeof home === "string").toBe(true);

    const resolved = resolveCodexHome();
    expect(typeof resolved).toBe("string");

    const authMethods = [
      { id: "codex-login", name: "ChatGPT Login", description: "" },
    ];
    const preflight = {
      codexHome: resolved,
      hasCodexHome: true,
      hasAuthFile: true,
      hasApiKeyEnv: false,
      looksLoggedIn: true,
    };

    const decision = decideConnectAuth(authMethods, preflight);
    expect(decision.action).toBeDefined();

    const gate = await runConnectAuthGate(authMethods, preflight, {
      authenticate: async () => {},
      tryOpenSessionWithoutAuth: async () => true,
    });
    expect(gate).toBeDefined();
    expect(typeof gate.outcome).toBe("string");
  });

  it("reads and builds proxy spawn environments correctly", async () => {
    const dataDir = getDefaultAgentDataDir();
    expect(typeof dataDir).toBe("string");

    const proxySettings = await readAcpProxySettings(dataDir);
    expect(proxySettings).toBeDefined();
    expect(typeof proxySettings.enabled).toBe("boolean");
    expect(typeof proxySettings.host).toBe("string");
    expect(typeof proxySettings.port).toBe("number");

    const env = buildAcpProxySpawnEnv(proxySettings);
    expect(env).toBeDefined();
    expect(Array.isArray(env.envRemove)).toBe(true);
  });

  it("tracks terminal management and live processes", () => {
    const tm = new AcpTerminalManager();
    expect(tm).toBeDefined();
    expect(typeof tm.create).toBe("function");
    expect(typeof tm.getOutput).toBe("function");
    expect(typeof tm.kill).toBe("function");
    expect(typeof tm.release).toBe("function");

    const live = listLiveAcpRuntimeIds();
    expect(Array.isArray(live)).toBe(true);
  });

  it("instantiates headless AcpClient cleanly and manages life cycle", () => {
    let statusLog: string[] = [];
    const client = new AcpClient({
      runtime: "codex-acp",
      workspaceRoot: process.cwd(),
      clientInfo: {
        name: "antigravity-test-client",
        version: "1.0.0",
      },
      callbacks: {
        onStatusChange: (status, detail) => {
          statusLog.push(`${status}:${detail ?? ""}`);
        },
      },
    });

    expect(client).toBeDefined();
    expect(client.currentStatus).toBe("disconnected");
    expect(client.isConnected).toBe(false);
    expect(typeof client.connect).toBe("function");
    expect(typeof client.createSession).toBe("function");
    expect(typeof client.promptSession).toBe("function");
    expect(typeof client.setSessionConfigOption).toBe("function");
    expect(typeof client.disconnect).toBe("function");
  });

  it("connects to mock ACP Agent end-to-end, creates session, and streams prompt", async () => {
    const mockAgentScript = path.resolve(__dirname, "fixtures/mock-acp-agent.ts");
    const mockRuntime: AcpRuntimeInfo = {
      id: "mock-acp-agent",
      name: "Mock Agent",
      command: "bun",
      args: ["run", mockAgentScript],
    };

    const updates: unknown[] = [];
    const client = new AcpClient({
      runtime: mockRuntime,
      workspaceRoot: path.resolve(__dirname, ".."),
      clientInfo: {
        name: "antigravity-test-client",
        version: "1.0.0",
      },
      callbacks: {
        onSessionUpdate: (u) => updates.push(u),
        onPermissionRequest: async () => ({ outcome: "approved" }),
      },
    });

    const connectRes = await client.connect();
    expect(connectRes.ok).toBe(true);
    expect(client.isConnected).toBe(true);

    const sessionRes = await client.createSession();
    expect(sessionRes.ok).toBe(true);
    if (!sessionRes.ok) return;

    const session = sessionRes.value;
    expect(session.sessionId).toBeDefined();

    const promptRes = await session.prompt("hello world");
    expect(promptRes.ok).toBe(true);
    expect(updates.length).toBeGreaterThan(0);

    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it("passes mcpServers through session/new wire protocol to Agent", async () => {
    const mockAgentScript = path.resolve(__dirname, "fixtures/mock-acp-agent.ts");
    const mockRuntime: AcpRuntimeInfo = {
      id: "mock-acp-agent",
      name: "Mock Agent",
      command: "bun",
      args: ["run", mockAgentScript],
    };

    let sessionReport = "";
    const client = new AcpClient({
      runtime: mockRuntime,
      workspaceRoot: path.resolve(__dirname, ".."),
      clientInfo: {
        name: "antigravity-test-client",
        version: "1.0.0",
      },
      callbacks: {
        onSessionUpdate: (u: any) => {
          const upd = u?.update ?? u;
          if (upd?.sessionUpdate === "agent_message_chunk" && upd?.content?.type === "text") {
            sessionReport += upd.content.text;
          }
        },
      },
    });

    const connectRes = await client.connect();
    expect(connectRes.ok).toBe(true);

    const mcpServers = [
      {
        name: "inkdown-calc",
        command: "node",
        args: ["calc.js"],
        env: [{ name: "PORT", value: "3000" }],
      },
    ];

    const sessionRes = await client.createSession({ mcpServers });
    expect(sessionRes.ok).toBe(true);
    if (!sessionRes.ok) return;

    const session = sessionRes.value;
    const promptRes = await session.prompt("trigger_inspect_session");
    expect(promptRes.ok).toBe(true);

    // session/update 通知是异步派发的，可能晚于 prompt 的响应到达：等它落地再解析。
    await vi.waitFor(() => expect(sessionReport).not.toBe(""), { timeout: 2000 });
    const parsed = JSON.parse(sessionReport);
    expect(parsed.cwd).toBe(path.resolve(__dirname, ".."));
    expect(Array.isArray(parsed.mcpServers)).toBe(true);
    expect(parsed.mcpServers.length).toBe(1);
    expect(parsed.mcpServers[0].name).toBe("inkdown-calc");
    expect(parsed.mcpServers[0].command).toBe("node");

    await client.disconnect();
  });

  it("rejects an invalid stdio MCP entry instead of silently dropping it (0.1.14 contract)", async () => {
    const mockAgentScript = path.resolve(__dirname, "fixtures/mock-acp-agent.ts");
    const mockRuntime: AcpRuntimeInfo = {
      id: "mock-acp-agent",
      name: "Mock Agent",
      command: "bun",
      args: ["run", mockAgentScript],
    };

    const client = new AcpClient({
      runtime: mockRuntime,
      workspaceRoot: path.resolve(__dirname, ".."),
      callbacks: { onSessionUpdate: () => {} },
    });

    await client.connect();

    // Invalid stdio server (missing env). acp-client 0.1.14 sets
    // preserveMcpOnRetry, so the rejected MCP list is no longer silently
    // dropped: session/new fails loudly instead of starting without tools.
    const invalidMcpServers = [
      {
        name: "invalid-calc",
        command: "node",
        args: ["calc.js"],
      },
    ];

    const sessionRes = await client.createSession({ mcpServers: invalidMcpServers });
    expect(sessionRes.ok).toBe(false);
    if (sessionRes.ok) return;
    expect(sessionRes.error.code).toBe("ACP_PROTOCOL_ERROR");

    await client.disconnect();
  });
});

