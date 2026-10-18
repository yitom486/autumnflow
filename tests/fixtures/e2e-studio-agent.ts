import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { editorialCases, mermaidCases, mindmapCode, flowJoinCase } from "./diagram-cases";

// Model decisions are scripted; MCP discovery and tool execution use the real server.
const sessions = new Map<string, { mcpServers: any[]; presented?: string; title?: string; parentID?: string }>();
if (process.env.ACP_E2E_SUBAGENTS === "1") sessions.set("external-history", { mcpServers: [], title: "外部已有会话" });
let sequence = 0;
const modelState = {
  models: { currentModelId: "e2e-default", availableModels: [{ id: "e2e-default", name: "E2E Test Model" }] },
  modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent Mode" }] },
};

async function callStudio(sessionId: string, name: string, args: Record<string, unknown>) {
  const endpoint = sessions.get(sessionId)?.mcpServers.find((server) => server.name === "studio-ui");
  if (!endpoint?.url) throw new Error("studio-ui was not injected into session/new");
  const client = new Client({ name: "e2e-studio-agent", version: "1.0.0" });
  try {
    const headers = Object.fromEntries((endpoint.headers || []).map((h: any) => [h.name, h.value]));
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers } }));
    const catalog = await client.listTools();
    if (!catalog.tools.some((tool) => tool.name === name)) throw new Error(`MCP tool missing: ${name}`);
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`MCP tool failed: ${JSON.stringify(result)}`);
    return result;
  } finally { await client.close(); }
}

async function text(ctx: any, sessionId: string, value: string) {
  await ctx.client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } },
  });
}

const app = acp.agent({ name: "e2e-agent" })
  .onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} }, mcpCapabilities: { http: true } },
    agentInfo: { name: "e2e-agent", title: "E2E Test Agent", version: "1.0.0" },
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.list, async () => ({
    sessions: [...sessions.entries()].map(([sessionId, session]) => ({ sessionId, cwd: process.cwd(), title: session.title })),
  }))
  .onRequest(acp.methods.agent.session.new, async (ctx: any) => {
    const sessionId = `e2e-session-${++sequence}`;
    sessions.set(sessionId, { mcpServers: ctx.params.mcpServers || [] });
    if (process.env.ACP_E2E_SESSION_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.ACP_E2E_SESSION_DELAY_MS)));
    return { sessionId, ...modelState };
  })
  .onRequest(acp.methods.agent.session.load, async (ctx: any) => {
    if (!sessions.has(ctx.params.sessionId)) throw new Error("Unknown session");
    return { ...modelState };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx: any) => {
    const { sessionId, prompt } = ctx.params;
    const state = sessions.get(sessionId);
    if (!state) throw new Error("Unknown session");
    const fullText = prompt
      .map((block: any) => String(block.text || ""))
      .filter((t: string) => !t.trimStart().startsWith("<acp-compat-context"))
      .join(" ");
    if (fullText.startsWith("E2E_PERMISSION")) {
      // A real reverse ACP request. No command executes in this fixture.
      const result = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: `approval-${sessionId}`, title: "E2E 安全操作", kind: "execute" },
        options: [
          { optionId: "once", name: "仅允许本次", kind: "allow_once" },
          { optionId: "always", name: "本会话始终允许", kind: "allow_always" },
          { optionId: "reject", name: "拒绝本次操作", kind: "reject_once" },
        ],
      });
      await text(ctx, sessionId, `ACP_PERMISSION_RESULT session=${sessionId} ${JSON.stringify(result)}`);
      return { stopReason: "end_turn" };
    }
    if (fullText === "E2E_URL_ELICITATION") {
      const elicitationId = `external-${sessionId}`;
      const result = await ctx.client.request(acp.methods.client.elicitation.create, {
        sessionId, mode: "url", message: "E2E 外部授权", elicitationId, url: "https://accounts.example.org/connect",
      });
      await text(ctx, sessionId, `ACP_URL_RESULT ${JSON.stringify(result)}`);
      if (acp.CreateElicitationResponse.isAccept(result)) {
        // Complete outside the chat SSE lifetime to verify snapshot recovery too.
        setTimeout(() => { void ctx.client.notify(acp.methods.client.elicitation.complete, { elicitationId }); }, 3000);
      }
      return { stopReason: "end_turn" };
    }
    if (fullText.startsWith("E2E_ELICITATION")) {
      const result = await ctx.client.request(acp.methods.client.elicitation.create, {
        sessionId, mode: "form", message: "E2E 部署问询",
        requestedSchema: {
          type: "object",
          properties: {
            environment: { type: "string", title: "部署环境", enum: ["staging", "production"] },
            replicas: { type: "integer", title: "副本数量", description: "输入期望副本数" },
          },
          required: ["environment", "replicas"],
        },
      });
      await text(ctx, sessionId, `ACP_ELICITATION_RESULT session=${sessionId} ${JSON.stringify(result)}`);
      return { stopReason: "end_turn" };
    }
    if (fullText.startsWith("E2E_DIAGRAM:")) {
      const kind = fullText.slice("E2E_DIAGRAM:".length).trim();
      const scenario = kind === "flow-join" ? flowJoinCase : editorialCases.find(item => item.kind === kind);
      if (!scenario) throw new Error(`Unknown diagram case: ${kind}`);
      const rawOutput = await callStudio(sessionId, "render_editorial_diagram", {
        title: scenario.title, diagramType: scenario.kind, data: scenario.data, theme: "system", accent: "blue",
      });
      await ctx.client.notify(acp.methods.client.session.update, { sessionId, update: {
        sessionUpdate: "tool_call", toolCallId: `e2e-${sessionId}-${kind}`,
        name: "render_editorial_diagram", title: "render_editorial_diagram", status: "completed", rawOutput,
      } });
      await text(ctx, sessionId, `图表生成完成：${scenario.kind}`);
      return { stopReason: "end_turn" };
    }
    if (fullText === "E2E_REASONING_CHUNKS") {
      // DeepSeek-style delivery: arbitrary packet IDs, blank lines and
      // pauses straddling 200ms. Packet boundaries are not semantic phases.
      for (let i = 0; i < 40; i++) {
        await ctx.client.notify(acp.methods.client.session.update, { sessionId, update: {
          sessionUpdate: "agent_thought_chunk", messageId: `reasoning-packet-${i}`,
          content: { type: "text", text: `推理段落 ${i}：分析约束并验证假设。\n\n下一行仍属于同一次思考。\n` },
        } });
        if (i % 8 === 0) await new Promise(resolve => setTimeout(resolve, 230));
      }
      await new Promise(resolve => setTimeout(resolve, 800));
      await text(ctx, sessionId, "推理分包验证完成。");
      return { stopReason: "end_turn" };
    }
    if (fullText.startsWith("E2E_MERMAID:")) {
      const kind = fullText.slice("E2E_MERMAID:".length).trim();
      const codes = kind === "mindmap" ? [mindmapCode]
        : kind === "mindmap-multiple" ? [mindmapCode, mindmapCode]
        : kind === "multiple" ? mermaidCases.map(item => item.code)
        : kind === "invalid" ? ["flowchart TD\n A[broken --> B"]
        : [mermaidCases.find(item => item.kind === kind)?.code];
      if (codes.some(code => !code)) throw new Error(`Unknown Mermaid case: ${kind}`);
      // Split a fence across ACP events to exercise the real streaming Markdown path.
      for (const code of codes) {
        await text(ctx, sessionId, "图表说明：\n\n```mer");
        await text(ctx, sessionId, `maid\n${code}\n`);
        await text(ctx, sessionId, "```\n\n");
      }
      await text(ctx, sessionId, "图表输出完成。");
      return { stopReason: "end_turn" };
    }
    if (fullText.includes("测试子会话")) {
      const childId = `${sessionId}-child`;
      sessions.set(childId, { mcpServers: [], title: "检查项目结构", parentID: sessionId });
      await ctx.client.notify(acp.methods.client.session.update, { sessionId, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "这是子智能体的独立输出" },
        _meta: { "opencode/child-session": { id: childId, parentID: sessionId, title: "检查项目结构", depth: 1 } },
      } });
      await text(ctx, sessionId, "主会话正在继续执行");
      await new Promise(resolve => setTimeout(resolve, 6000));
      await text(ctx, sessionId, "，主会话执行完成。");
      return { stopReason: "end_turn" };
    }
    // Submit markers precede broad keywords so follow-ups do not regenerate cards.
    if (fullText.includes("[方案决策:")) {
      if (state.presented !== "decision") throw new Error("Decision submitted to the wrong session");
      await text(ctx, sessionId, `【ACP 会话继续执行】已确认收到您选定的方案！ session=${sessionId}\n${fullText.split("用户已选定方案：")[1]}`);
      return { stopReason: "end_turn" };
    }
    if (fullText.includes("[表单提交:")) {
      if (state.presented !== "form") throw new Error("Form submitted to the wrong session");
      await text(ctx, sessionId, `【ACP 会话继续执行】部署参数已提交验证，正在初始化集群副本！ session=${sessionId}\n${fullText.slice(fullText.indexOf("\n") + 1)}`);
      return { stopReason: "end_turn" };
    }

    if (fullText.includes("图文混排") || fullText.includes("混排")) {
      state.presented = "decision";
      await text(ctx, sessionId, "第一部分：首先为您展示订单履约的核心状态流转图：\n\n");

      const flowToolId = `e2e-${sessionId}-inline-flow`;
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: flowToolId,
          name: "render_editorial_diagram",
          title: "render_editorial_diagram",
          status: "running",
        },
      });

      // Pause briefly so E2E can assert the intermediate inline placeholder skeleton inside the prose
      await new Promise((r) => setTimeout(r, 1500));

      const flowOutput = await callStudio(sessionId, "render_editorial_diagram", {
        title: "订单履约业务状态流转图",
        diagramType: "flowchart",
        description: "订单创建至配送完成的业务状态机",
        theme: "system",
        accent: "emerald",
        data: {
          steps: [
            { id: "created", label: "订单已创建", description: "待买家支付", status: "已完成" },
            { id: "paid", label: "在线支付成功", description: "资金渠道对账中", status: "进行中", isCurrent: true },
            { id: "stock", label: "仓储打包出库", description: "WMS 自动化分拣", status: "等待" },
          ],
          connections: [
            { from: "created", to: "paid" },
            { from: "paid", to: "stock" },
          ],
        },
      });

      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: flowToolId,
          name: "render_editorial_diagram",
          title: "render_editorial_diagram",
          status: "completed",
          rawOutput: flowOutput,
        },
      });

      await text(ctx, sessionId, "\n\n第二部分：结合上述状态流转，请在下方交互卡片中确认高可用架构方案：\n\n");

      const decisionToolId = `e2e-${sessionId}-inline-decision`;
      const decisionOutput = await callStudio(sessionId, "show_interactive_card", {
        title: "高可用服务架构选型",
        cardType: "decision",
        data: {
          options: [
            { id: "opt-event-driven", label: "事件驱动微服务 (Kafka + Go)", recommended: true },
            { id: "opt-monolith", label: "经典单体架构 (Postgres + Node)" },
          ],
        },
      });

      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: decisionToolId,
          name: "show_interactive_card",
          title: "show_interactive_card",
          status: "completed",
          rawOutput: decisionOutput,
        },
      });

      await text(ctx, sessionId, "\n\n第三部分：点击上方卡片中的方案即可直接回传您的架构决策。");
      return { stopReason: "end_turn" };
    }

    let name = "show_interactive_card";
    let args: Record<string, unknown> = {};

    if (fullText.includes("时序") || fullText.includes("sequence")) {
      name = "render_editorial_diagram";
      state.presented = "diagram";
      args = {
        title: "微服务调用链路时序图",
        diagramType: "sequence",
        description: "客户端网关与鉴权中心时序链路",
        theme: "system",
        accent: "emerald",
        data: {
          steps: [
            { source: "Browser", target: "Gateway", label: "POST /login" },
            { source: "Gateway", target: "AuthService", label: "Verify Credentials" },
            { source: "AuthService", target: "Gateway", label: "Issue JWT Token" },
          ],
        },
      };
    } else if (fullText.includes("流程") || fullText.includes("状态机") || fullText.includes("flowchart")) {
      name = "render_editorial_diagram";
      state.presented = "flowchart";
      args = {
        title: "订单履约业务状态流转图",
        diagramType: "flowchart",
        description: "订单创建至配送完成的业务状态机",
        theme: "system",
        accent: "emerald",
        data: {
          steps: [
            { id: "created", label: "订单已创建", description: "待买家支付", status: "已完成" },
            { id: "paid", label: "在线支付成功", description: "资金渠道对账中", status: "进行中", isCurrent: true },
            { id: "stock", label: "仓储打包出库", description: "WMS 自动化分拣", status: "等待" },
            { id: "delivery", label: "顺丰冷链配送", description: "预计明日送达", status: "等待" },
          ],
          connections: [
            { from: "created", to: "paid" },
            { from: "paid", to: "stock" },
            { from: "stock", to: "delivery" },
          ],
        },
      };
    } else if (fullText.includes("架构图") || fullText.includes("分层架构") || fullText.includes("architecture")) {
      name = "render_editorial_diagram";
      state.presented = "architecture";
      args = {
        title: "微服务分层系统架构图",
        diagramType: "architecture",
        description: "生产环境分层微服务拓扑结构",
        theme: "system",
        accent: "emerald",
        data: {
          layers: [
            {
              id: "gateway-layer",
              title: "接入网关层",
              nodes: [
                { id: "kong", label: "Kong Gateway", subtext: "反向代理 & 鉴权", highlighted: true },
                { id: "waf", label: "Cloudflare WAF", subtext: "DDoS 防护" },
              ],
            },
            {
              id: "service-layer",
              title: "业务服务层",
              nodes: [
                { id: "auth-svc", label: "Auth Service", subtext: "JWT & OAuth2" },
                { id: "order-svc", label: "Order Service", subtext: "订单状态机", highlighted: true },
              ],
            },
            {
              id: "data-layer",
              title: "数据持久层",
              nodes: [
                { id: "pg", label: "PostgreSQL 主从", subtext: "OLTP 存储" },
                { id: "redis", label: "Redis Cluster", subtext: "分布式缓存" },
              ],
            },
          ],
          connections: [
            { from: "gateway-layer", to: "service-layer" },
            { from: "service-layer", to: "data-layer" },
          ],
        },
      };
    } else if (fullText.includes("清单") || fullText.includes("检查项") || fullText.includes("checklist")) {
      name = "show_interactive_card";
      state.presented = "checklist";
      args = {
        title: "系统上线前安全门禁清单",
        cardType: "checklist",
        description: "生产发布前必须逐项核对确认",
        data: {
          items: [
            { id: "db_backup", label: "数据库快照已完成备份", checked: true },
            { id: "ssl_cert", label: "HTTPS 证书有效性校验", checked: false },
            { id: "firewall", label: "网关 WAF 安全策略启用", checked: false },
          ],
        },
      };
    } else if (fullText.includes("指标") || fullText.includes("监控") || fullText.includes("metrics")) {
      name = "show_interactive_card";
      state.presented = "metrics";
      args = {
        title: "微服务核心运行指标看板",
        cardType: "metrics",
        description: "生产集群最近 1 小时关键监控指标汇总",
        data: {
          metrics: [
            { label: "平均响应时延 P99", value: "12.4", unit: "ms", change: "-8.5%", progress: 75 },
            { label: "QPS 吞吐量", value: "85,400", unit: "req/s", change: "+14.2%", progress: 85 },
            { label: "错误率 (Error Rate)", value: "0.01", unit: "%", change: "-0.05%", progress: 10 },
          ],
        },
      };
    } else if (fullText.includes("沙箱") || fullText.includes("自由组件") || fullText.includes("sandbox")) {
      name = "render_react_sandbox";
      state.presented = "sandbox";
      args = {
        title: "实时计数器原型",
        description: "包含实时计数与增减交互的 React 沙箱原型",
        template: "react",
        code: `function App() {
  const [count, setCount] = React.useState(0);
  return (
    <div style={{ padding: "16px", color: "#fff" }}>
      <h4>计数器: {count}</h4>
      <button onClick={() => setCount(count + 1)}>增加</button>
    </div>
  );
}`,
      };
    } else if (fullText.includes("表单") || fullText.includes("部署参数")) {
      name = "prompt_form";
      state.presented = "form";
      args = {
        title: "服务部署参数",
        submitLabel: "确认并部署",
        fields: [
          { id: "cluster_name", label: "集群名称", type: "text", defaultValue: "prod-cluster-01", required: true },
          { id: "replicas", label: "副本数量", type: "number", defaultValue: 3, required: true },
        ],
      };
    } else {
      name = "show_interactive_card";
      state.presented = "decision";
      args = {
        title: "高可用服务架构选型",
        cardType: "decision",
        data: {
          options: [
            { id: "opt-event-driven", label: "事件驱动微服务 (Kafka + Go)", recommended: true },
            { id: "opt-monolith", label: "经典单体架构 (Postgres + Node)" },
          ],
        },
      };
    }

    const rawOutput = await callStudio(sessionId, name, args);
    // No rawInput: rendering must consume the actual MCP result.
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call", toolCallId: `e2e-${sessionId}-${state.presented}`,
        name, title: name, status: "completed", rawOutput,
      },
    });
    await text(ctx, sessionId, `真实 MCP ${name} 已返回。 session=${sessionId}`);
    return { stopReason: "end_turn" };
  });

app.connect(acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
