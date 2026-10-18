import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import * as acp from "@agentclientprotocol/sdk";

/**
 * Deterministic Mock ACP stdio agent for black-box pipeline tests.
 * Speaks official ACP protocol over stdin/stdout via @agentclientprotocol/sdk.
 * 100% offline, zero cloud tokens, tests complete lifecycle:
 * - Handshake (initialize)
 * - Session creation (session/new)
 * - Event streaming (text, thoughts, tool calls, images, plans, usage)
 * - Interactive client requests (requestPermission, elicitation)
 * - Session cancellation (session/cancel)
 */

let sessSeq = 0;
const cancelledSessions = new Set<string>();
const sessionCwds = new Map<string, string>();
const sessionMcpServers = new Map<string, unknown[]>();
const sessionAdditionalDirs = new Map<string, string[]>();


const app = acp
  .agent({ name: "mock-acp-agent", version: "1.0.0" })
  .onRequest(acp.methods.agent.initialize, async (ctx) => {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true, audio: false },
        sessionCapabilities: { list: {}, close: {}, fork: {}, resume: {}, load: {}, additionalDirectories: {} },
        mcpCapabilities: { http: true },
        loadSession: true,
        providers: true,
      },
      agentInfo: {
        name: "mock-acp-agent",
        title: "Mock ACP Blackbox Agent",
        version: "1.0.0",
      },
      authMethods: [],
    } as unknown as acp.InitializeResponse;
  })
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    const sessionId = `mock-session-${++sessSeq}`;
    sessionCwds.set(sessionId, ctx.params.cwd);
    sessionMcpServers.set(sessionId, ctx.params.mcpServers || []);
    sessionAdditionalDirs.set(sessionId, ctx.params.additionalDirectories || []);
    return {
      sessionId,
      models: {
        currentModelId: "mock-default",
        availableModels: [
          { id: "mock-default", name: "Mock Default Model", description: "Offline simulation model" },
          { id: "mock-fast", name: "Mock Fast Model", description: "Fast offline model" },
        ],
      },
      modes: {
        currentModeId: "agent",
        availableModes: [{ id: "agent", name: "Agent Mode" }],
      },
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "mock-default",
          options: [
            { value: "mock-default", name: "Mock Default Model" },
            { value: "mock-fast", name: "Mock Fast Model" },
          ],
        },
        {
          id: "thought_mode",
          name: "Thought Mode",
          type: "boolean",
          category: "thought",
          currentValue: true,
        },
      ],
    };
  })
  .onRequest(acp.methods.agent.session.list, async () => {
    return {
      sessions: [
        { sessionId: `mock-session-active`, createdAt: new Date().toISOString() },
      ],
    };
  })
  .onRequest(acp.methods.agent.session.resume, async (ctx: any) => {
    const sessionId = ctx.params.sessionId || `mock-resumed-session-${++sessSeq}`;
    if (ctx.params.cwd) sessionCwds.set(sessionId, ctx.params.cwd);
    if (ctx.params.mcpServers) sessionMcpServers.set(sessionId, ctx.params.mcpServers || []);
    if (ctx.params.additionalDirectories) sessionAdditionalDirs.set(sessionId, ctx.params.additionalDirectories || []);
    return {
      sessionId,
      models: {
        currentModelId: "mock-default",
        availableModels: [{ id: "mock-default", name: "Mock Default Model", description: "Offline simulation model" }],
      },
      modes: {
        currentModeId: "agent",
        availableModes: [{ id: "agent", name: "Agent Mode" }],
      },
    };
  })
  .onRequest(acp.methods.agent.session.load, async (ctx: any) => {
    const sessionId = ctx.params.sessionId || `mock-loaded-session-${++sessSeq}`;
    if (ctx.params.cwd) sessionCwds.set(sessionId, ctx.params.cwd);
    if (ctx.params.mcpServers) sessionMcpServers.set(sessionId, ctx.params.mcpServers || []);
    if (ctx.params.additionalDirectories) sessionAdditionalDirs.set(sessionId, ctx.params.additionalDirectories || []);
    return {
      sessionId,
      models: {
        currentModelId: "mock-default",
        availableModels: [{ id: "mock-default", name: "Mock Default Model", description: "Offline simulation model" }],
      },
      modes: {
        currentModeId: "agent",
        availableModes: [{ id: "agent", name: "Agent Mode" }],
      },
    };
  })
  .onRequest(acp.methods.agent.session.close, async () => {
    return {};
  })
  .onRequest(acp.methods.agent.session.delete, async () => {
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx: any) => {
    const { sessionId, prompt } = ctx.params as { sessionId: string; prompt: any[] };
    const promptText = (prompt || [])
      .map((b: any) => (b.type === "text" ? b.text : ""))
      .join(" ");

    const imageBlocks = (prompt || []).filter((b: any) => b.type === "image");

    cancelledSessions.delete(sessionId);

    // Scenario: Inspect Session CWD and McpServers
    if (promptText.includes("trigger_inspect_session")) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: JSON.stringify({
              cwd: sessionCwds.get(sessionId),
              mcpServers: sessionMcpServers.get(sessionId),
              additionalDirectories: sessionAdditionalDirs.get(sessionId) || [],
            }),
          },
        },
      });
      return { stopReason: "end_turn" };
    }

    // Scenario: Inspect raw prompt blocks received by agent
    if (promptText.includes("trigger_inspect_prompt")) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: JSON.stringify({ promptBlocks: prompt }),
          },
        },
      });
      return { stopReason: "end_turn" };
    }

    // Scenario: Test skill discovery via filesystem (additionalDirectories) and MCP tools
    if (promptText.includes("trigger_discover_skills")) {
      const extraDirs = sessionAdditionalDirs.get(sessionId) || [];
      const skillsDir = extraDirs.find((d) => fs.existsSync(d) && fs.existsSync(path.join(d, "diagram-design", "SKILL.md")));
      const diagramFile = skillsDir ? path.join(skillsDir, "diagram-design", "SKILL.md") : "";
      const genUiFile = skillsDir ? path.join(skillsDir, "generative-ui", "SKILL.md") : "";

      const fsDiscovery = {
        skillsDir: skillsDir || null,
        diagramSkillFound: fs.existsSync(diagramFile),
        diagramSkillText: fs.existsSync(diagramFile) ? fs.readFileSync(diagramFile, "utf-8").slice(0, 100) : "",
        generativeUiSkillFound: fs.existsSync(genUiFile),
      };

      // MCP Discovery
      const mcpServers = (sessionMcpServers.get(sessionId) || []) as any[];
      const studioMcp = mcpServers.find((s) => s.name === "studio-ui");
      let mcpDiscovery: any = { error: "studio-ui not found" };

      if (studioMcp?.url) {
        try {
          const initRes = await fetch(studioMcp.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "mock-init",
              method: "initialize",
              params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mock-agent", version: "1.0.0" } },
            }),
          });
          const mcpSessionId = initRes.headers.get("mcp-session-id") || "";
          const mcpHeaders: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {}),
          };

          const listRes = await fetch(studioMcp.url, {
            method: "POST",
            headers: mcpHeaders,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "mock-list-skills",
              method: "tools/call",
              params: { name: "list_studio_skills", arguments: {} },
            }),
          });
          const listData = await listRes.json();

          const getRes = await fetch(studioMcp.url, {
            method: "POST",
            headers: mcpHeaders,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "mock-get-skill",
              method: "tools/call",
              params: { name: "get_studio_skill", arguments: { name: "diagram-design" } },
            }),
          });
          const getData = await getRes.json();

          mcpDiscovery = {
            status: "ok",
            endpoint: studioMcp.url,
            listContent: listData.result?.content?.[0]?.text || "",
            skillContent: getData.result?.content?.[0]?.text || "",
            skillTitle: getData.result?.data?.title || "",
          };
        } catch (err: any) {
          mcpDiscovery = { error: err.message };
        }
      }

      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: JSON.stringify({ fsDiscovery, mcpDiscovery }),
          },
        },
      });
      return { stopReason: "end_turn" };
    }

    // Scenario: client-side guards. `trigger_fs_write <abs path>` asks the client
    // to write a file; `trigger_terminal_create <cwd>` asks it to spawn a
    // terminal there. The outcome is reported back as one text chunk:
    // "GUARD:OK" or "GUARD:ERR:<message>" so tests can assert enforcement.
    const guard = /trigger_(fs_write|terminal_create)\s+(\S+)/.exec(promptText);
    if (guard) {
      const [, kind, arg] = guard;
      let report: string;
      try {
        if (kind === "fs_write") {
          await (ctx.client as any).request(acp.methods.client.fs.writeTextFile, { sessionId, path: arg, content: "mock-write" });
        } else {
          const created = await (ctx.client as any).request(acp.methods.client.terminal.create, {
            sessionId,
            command: process.platform === "win32" ? "cmd.exe" : "true",
            args: process.platform === "win32" ? ["/c", "exit 0"] : [],
            cwd: arg,
          });
          await (ctx.client as any).request(acp.methods.client.terminal.release, { sessionId, terminalId: created.terminalId });
        }
        report = "GUARD:OK";
      } catch (err: any) {
        report = `GUARD:ERR:${err?.message || String(err)}`;
      }
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: report } },
      });
      return { stopReason: "end_turn" };
    }

    // Scenario: Interactive Permission Request
    if (promptText.includes("trigger_permission")) {
      try {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Encountered sensitive operation, requesting permission..." },
          },
        });

        const outcome = await (ctx.client as any).request(
          acp.methods.client.session.requestPermission,
          {
            sessionId,
            toolCall: {
              toolCallId: "perm-tool-1",
              title: "Execute privileged command",
              kind: "execute",
            },
            options: [
              { optionId: "allow", name: "Allow execution", kind: "allow_once" },
              { optionId: "deny", name: "Deny execution", kind: "reject_once" },
            ],
          }
        );

        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Permission resolved with: ${JSON.stringify(outcome)}` },
          },
        });

        return { stopReason: "end_turn" };
      } catch (err) {
        console.error("[mock-agent permission error]", err);
        throw err;
      }
    }

    // Scenario: Interactive Elicitation Request
    if (promptText.includes("trigger_elicitation")) {
      try {
        const elRes = await (ctx.client as any).request(
          acp.methods.client.elicitation.create,
          {
            mode: "form",
            sessionId,
            message: "Please enter your API target environment",
            requestedSchema: {
              type: "object",
              properties: {
                targetEnv: { type: "string", description: "Target environment name" },
              },
              required: ["targetEnv"],
            },
          }
        );

        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Elicitation resolved: ${JSON.stringify(elRes)}` },
          },
        });

        return { stopReason: "end_turn" };
      } catch (err) {
        console.error("[mock-agent elicitation error]", err);
        throw err;
      }
    }

    // Scenario: Cancellation
    if (promptText.includes("trigger_cancel")) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Starting long-running operation, awaiting cancellation..." },
        },
      });

      // Wait until cancelled
      for (let i = 0; i < 50; i++) {
        if (cancelledSessions.has(sessionId)) {
          return { stopReason: "cancelled" };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { stopReason: "end_turn" };
    }

    // Scenario: Generative UI Tool Calls Pipeline
    if (promptText.includes("trigger_generative_ui")) {
      // 1. Decision Card
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-gen-decision",
          title: "show_interactive_card",
          name: "show_interactive_card",
          status: "completed",
          rawInput: {
            title: "微服务部署架构决策",
            cardType: "decision",
            description: "请为当前生产集群挑选最佳发布策略",
            data: {
              options: [
                { id: "canary", label: "灰度金丝雀发布 (Canary)", recommended: true, description: "先向 5% 用户放量，监控指标平稳后全量" },
                { id: "bluegreen", label: "蓝绿双集群热切 (Blue-Green)", description: "独立备用集群全量验证后瞬间切流" },
              ],
            },
          },
          rawOutput: { status: "ready" },
        },
      });

      // 2. Checklist Card
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-gen-checklist",
          title: "show_interactive_card",
          name: "show_interactive_card",
          status: "completed",
          rawInput: {
            title: "发布前门禁校验",
            cardType: "checklist",
            description: "必须全部通过后方可开放生产公网流量",
            data: {
              items: [
                { id: "unit_tests", label: "单元测试与覆盖率门禁", checked: true },
                { id: "e2e_tests", label: "核心业务路径端到端测试", checked: false },
                { id: "security_scan", label: "静态代码与安全漏洞扫描", checked: true },
              ],
            },
          },
        },
      });

      // 3. Metrics Card
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-gen-metrics",
          title: "show_interactive_card",
          name: "show_interactive_card",
          status: "completed",
          rawInput: {
            title: "压测性能指标看板",
            cardType: "metrics",
            description: "峰值模拟 10,000 QPS 压测表现",
            data: {
              metrics: [
                { label: "平均延迟 (P95)", value: "8.4", unit: "ms", change: "-12%" },
                { label: "吞吐量峰值", value: "10,240", unit: "req/s", change: "+15%" },
                { label: "CPU 负载", value: "48", unit: "%", progress: 48 },
              ],
            },
          },
        },
      });

      // 4. Prompt Form
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-gen-form",
          title: "prompt_form",
          name: "prompt_form",
          status: "completed",
          rawInput: {
            title: "数据库配置向导",
            description: "请录入目标环境数据库连接凭证",
            submitLabel: "验证连接并保存",
            fields: [
              { id: "db_host", label: "数据库主机", defaultValue: "10.0.0.8", required: true },
              { id: "db_port", label: "连接端口", type: "number", defaultValue: 5432 },
              { id: "db_ssl", label: "启用 SSL 加密", type: "checkbox", defaultValue: true },
            ],
          },
        },
      });

      // 5. React Sandbox Prototype
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-gen-sandbox",
          title: "render_react_sandbox",
          name: "render_react_sandbox",
          status: "completed",
          rawInput: {
            title: "动态计数器原型",
            template: "react",
            description: "包含内部 useState 状态交互的沙箱原型",
            code: `function App() {
  const [count, setCount] = React.useState(0);
  return (
    <div className="p-4 bg-slate-900 text-white rounded-lg border border-slate-700 flex flex-col items-center gap-3">
      <h2 className="text-base font-bold text-sky-400">计数器原型: {count}</h2>
      <div className="flex gap-2">
        <button onClick={() => setCount(c => c - 1)} className="px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded text-sm">-1</button>
        <button onClick={() => setCount(c => c + 1)} className="px-3 py-1 bg-sky-600 hover:bg-sky-500 rounded text-sm">+1</button>
      </div>
    </div>
  );
}`,
          },
        },
      });

      // 6. Editorial Diagram
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-gen-diagram",
          title: "render_editorial_diagram",
          name: "render_editorial_diagram",
          status: "completed",
          rawInput: {
            title: "微服务容器架构拓扑",
            diagramType: "architecture",
            description: "端到端系统架构设计",
            accent: "emerald",
            data: {
              layers: [
                {
                  id: "gateway",
                  title: "接入网关层",
                  nodes: [
                    { id: "traefik", label: "Traefik Proxy", subtext: ":443", highlighted: true },
                  ],
                },
                {
                  id: "services",
                  title: "核心业务层",
                  nodes: [
                    { id: "auth", label: "Auth Service", subtext: "JWT" },
                    { id: "core", label: "Studio API", subtext: "Bun" },
                  ],
                },
              ],
              connections: [{ from: "gateway", to: "services", label: "gRPC" }],
            },
          },
        },
      });

      // Final Conclusion Text Chunk
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "已为您生成全套生成式 UI 交互卡片与 React 沙箱原型，请在上方直接交互测试。" },
        },
      });

      return { stopReason: "end_turn" };
    }

    // Scenario: Standard Full Pipeline Event Stream
    try {
      // 1. Thought chunk
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thought: Parsing user input and media items..." },
        },
      });

      // 2. Message chunk #1
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello from Mock ACP Agent! " },
        },
      });

      // 3. Image block verification if present
      if (imageBlocks.length > 0) {
        const img = imageBlocks[0];
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `[Verified image mime=${img.mimeType || "unknown"}, dataLength=${(img.data || "").length}] ` },
          },
        });
      }

      // 4. Plan entry
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Step 1: Inspect environment", priority: "medium", status: "completed" },
            { content: "Step 2: Execute mock tool call", priority: "high", status: "in_progress" },
          ],
        },
      });

      // 5. Tool Call (pending)
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-call-blackbox-1",
          title: "mock_inspect_workspace",
          kind: "read",
          status: "pending",
        },
      });

      await new Promise((r) => setTimeout(r, 20));

      // 6. Tool Call Update (completed) with valid ToolCallContent array
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-call-blackbox-1",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "All mock workspace checks passed" },
            },
          ],
        },
      });

      // 7. Message chunk #2 (final response text)
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "All stream segments delivered successfully." },
        },
      });

      // 8. Usage update
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 256,
          size: 8192,
        },
      });

      await new Promise((r) => setTimeout(r, 30));
      return { stopReason: "end_turn" };
    } catch (err) {
      console.error("[mock-agent pipeline error]", err);
      throw err;
    }
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx: any) => {
    const { sessionId } = ctx.params as { sessionId: string };
    cancelledSessions.add(sessionId);
  });

process.stdin.resume();

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
);

app.connect(stream);

process.stdin.on("end", () => {
  process.exit(0);
});
