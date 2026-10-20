/**
 * Universal AutumnFlow Built-in MCP Server for Generative UI.
 *
 * Runs a Streamable HTTP MCP server on a shared local port.
 * (default starting at 13920, automatically cascading up if occupied).
 *
 * Exposes core interactive tools:
 * - `show_interactive_card`: Structured cards (forms, decisions, metrics, checklists).
 * - `render_react_sandbox`: Arbitrary React / HTML sandboxed interactive prototypes.
 * - `prompt_form`: Human-in-the-loop interactive form inputs.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer, type RegisteredTool, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { listStudioSkills, getStudioSkill } from "./studio-skills";
import { STUDIO_MCP_INSTRUCTIONS } from "./studio-tool-guidance";
import { getStudioToolDescriptor } from "./studio-tools";
import { isSkillEnabled, isToolEnabled } from "./capability-registry";
import {
  presentResultId,
  PRESENT_SCHEMA_VERSION,
  type PresentResultKind,
} from "../../src/lib/present-result";

export interface McpServerInfo {
  port: number;
  url: string;
  name: string;
  version: string;
}

interface McpUiSession {
  mcp: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  requests: number;
  closed: boolean;
  closing?: Promise<void>;
  /** Registered tools of this session, so switches apply without a restart. */
  tools: Map<string, RegisteredTool>;
}

interface McpUiRuntime {
  server: http.Server;
  info: McpServerInfo | null;
  sessions: Map<string, McpUiSession>;
  connections: Set<McpUiSession>;
  sweep?: ReturnType<typeof setInterval>;
  stopping: boolean;
}

export interface McpUiServerOptions {
  /** Reclaim abandoned sessions with no active HTTP requests or SSE streams. */
  sessionIdleTimeoutMs?: number;
  sessionSweepIntervalMs?: number;
}

let activeRuntime: McpUiRuntime | null = null;
let lifecycle: Promise<unknown> = Promise.resolve();

// Serialize start/stop, including calls made while listen() or shutdown is pending.
function withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycle.then(operation);
  lifecycle = result.catch(() => undefined);
  return result;
}

export function getMcpUiServerInfo(): McpServerInfo | null {
  return activeRuntime?.info ?? null;
}

/** Hide the tools the user switched off before the session is handed out. */
function applyToolSwitches(tools: Map<string, RegisteredTool>): void {
  for (const [name, tool] of tools) {
    if (isToolEnabled(name)) tool.enable();
    else tool.disable();
  }
}

/**
 * Show or hide one studio-ui tool for every live MCP session.
 *
 * The switch is visible to the agent immediately: a disabled tool disappears
 * from tools/list and calls to it are rejected.
 */
export function setStudioToolEnabled(name: string, enabled: boolean): boolean {
  if (!getStudioToolDescriptor(name)) return false;
  const runtime = activeRuntime;
  if (runtime) {
    for (const session of runtime.connections) {
      const tool = session.tools.get(name);
      if (!tool) continue;
      if (enabled) tool.enable();
      else tool.disable();
    }
  }
  return true;
}

/**
 * Creates the McpServer instance with registered Generative UI tools.
 *
 * The registered handles are returned so a tool can be hidden or shown again
 * at runtime without restarting the server.
 */
export function createMcpUiServer(): { mcp: McpServer; tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>();
  const registerStudioTool = <
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    cb: ToolCallback<InputArgs>
  ) => {
    const tool = mcp.registerTool(name, config, cb);
    tools.set(name, tool);
    return tool;
  };
  const mcp = new McpServer({
    name: "studio-ui",
    version: "1.0.0",
  }, { instructions: STUDIO_MCP_INSTRUCTIONS });

  // 1. 结构化富交互卡片（决策、指标、核对清单、表单）
  registerStudioTool(
    "show_interactive_card",
    {
      description: getStudioToolDescriptor("show_interactive_card")!.description,
      inputSchema: {
        title: z.string().describe("卡片展示标题"),
        cardType: z
          .enum(["decision", "metrics", "checklist", "form"])
          .describe("卡片种类：decision(方案决策)、metrics(关键指标与对比)、checklist(步骤勾选清单)、form(通用表单)"),
        description: z.string().optional().describe("卡片简要说明或辅助文案"),
        data: z
          .union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()])
          .describe(
            "卡片核心数据结构。规范格式（严禁留空）：\n" +
            "- decision: { options: [{ id: 'opt1', label: '方案名', description: '说明', recommended: true, badge: '推荐' }] }\n" +
            "- checklist: { items: [{ id: 't1', title: '任务标题', checked: false, description: '说明' }] }\n" +
            "- metrics: { metrics: [{ label: '指标名', value: '100ms', change: '+5%', status: 'good' }] }\n" +
            "- form: { fields: [{ id: 'action', label: '操作名称', type: 'text', placeholder: '请输入' }] }"
          ),
      },
    },
    async ({ title, cardType, description, data }) => {
      let normalizedData: any = data;
      if (typeof normalizedData === "string") {
        try {
          normalizedData = JSON.parse(normalizedData);
        } catch {}
      }
      if (Array.isArray(normalizedData)) {
        if (cardType === "decision") normalizedData = { options: normalizedData };
        else if (cardType === "form") normalizedData = { fields: normalizedData };
        else if (cardType === "metrics") normalizedData = { metrics: normalizedData };
        else if (cardType === "checklist") normalizedData = { items: normalizedData };
      }

      const canonical = JSON.stringify({ title, cardType, data: normalizedData });
      const id = presentResultId(cardType as PresentResultKind, canonical);
      const presentPayload = {
        schemaVersion: PRESENT_SCHEMA_VERSION,
        id,
        kind: cardType,
        cardType,
        title,
        description,
        data: normalizedData,
      };
      return {
        content: [
          {
            type: "text",
            text: `[Present: ${cardType}] 呈现数据已生成（id=${id}，标题="${title}"），等待客户端渲染与用户交互。`,
          },
        ],
        structuredContent: presentPayload,
        data: presentPayload,
      };
    }
  );

  // 2. 自由 React / HTML 沙箱预览
  registerStudioTool(
    "render_react_sandbox",
    {
      description: getStudioToolDescriptor("render_react_sandbox")!.description,
      inputSchema: {
        title: z.string().describe("沙箱组件原型标题"),
        code: z.string().describe("完整的 React TSX/JSX 代码或 HTML+JS 原型代码"),
        template: z
          .enum(["react", "html"])
          .default("react")
          .describe("组件模板类型：'react'（自动注入 React/Tailwind 运行时）或 'html'"),
        description: z.string().optional().describe("组件功能与交互亮点说明"),
      },
    },
    async ({ title, code, template, description }) => {
      const canonical = JSON.stringify({ title, code, template });
      const id = presentResultId("react-artifact", canonical);
      const presentPayload = {
        schemaVersion: PRESENT_SCHEMA_VERSION,
        id,
        kind: "react-artifact",
        title,
        description,
        code,
        template,
      };
      return {
        content: [
          {
            type: "text",
            text: `[Present: react-artifact] 沙箱组件数据已生成（id=${id}，标题="${title}"），等待客户端隔离加载。`,
          },
        ],
        structuredContent: presentPayload,
        data: presentPayload,
      };
    }
  );

  // 3. 人机协同表单输入
  registerStudioTool(
    "prompt_form",
    {
      description: getStudioToolDescriptor("prompt_form")!.description,
      inputSchema: {
        title: z.string().describe("表单标题"),
        description: z.string().optional().describe("表单目的说明与操作指引"),
        submitLabel: z.string().default("提交并继续").describe("提交按钮文字"),
        fields: z
          .array(
            z.object({
              id: z.string().describe("字段 key"),
              label: z.string().describe("字段标签"),
              type: z
                .enum(["text", "number", "select", "checkbox", "textarea"])
                .default("text")
                .describe("字段输入控件类型"),
              placeholder: z.string().optional().describe("占位提示文本"),
              options: z.array(z.string()).optional().describe("select 类型的候选项列表"),
              defaultValue: z.unknown().optional().describe("默认填充值"),
              required: z.boolean().default(false).describe("是否必填"),
            })
          )
          .describe("待填写的表单字段集合"),
      },
    },
    async ({ title, description, submitLabel, fields }) => {
      const canonical = JSON.stringify({ title, fields });
      const id = presentResultId("form", canonical);
      const presentPayload = {
        schemaVersion: PRESENT_SCHEMA_VERSION,
        id,
        kind: "form",
        title,
        description,
        submitLabel,
        fields,
      };
      return {
        content: [
          {
            type: "text",
            text: `[Present: form] 表单数据已生成（id=${id}，共 ${fields.length} 个字段），等待客户端渲染与用户填写。`,
          },
        ],
        structuredContent: presentPayload,
        data: presentPayload,
      };
    }
  );

  // 4. 出版级精美图表（Editorial Diagram - Architecture, Sequence, Flowchart, Quadrant, Timeline）
  registerStudioTool(
    "render_editorial_diagram",
    {
      description: getStudioToolDescriptor("render_editorial_diagram")!.description,
      inputSchema: {
        title: z.string().describe("图表主标题"),
        description: z.string().optional().describe("图表副标题或背景说明"),
        diagramType: z
          .enum(["architecture", "sequence", "flowchart", "quadrant", "timeline", "mindmap"])
          .describe(
            "图表类型：mindmap(可折叠思维导图)、architecture(系统架构与分层容器)、sequence(交互时序图)、flowchart(流程与状态机)、quadrant(四象限技术选型/决策矩阵)、timeline(演进里程碑)"
          ),
        theme: z
          .enum(["light", "dark", "system"])
          .default("system")
          .describe("图表主题：light(浅色纸面风格)、dark(深色黑曜石风格)、system(跟随主界面)"),
        accent: z
          .enum(["emerald", "blue", "indigo", "violet", "amber", "rose", "cyan"])
          .default("emerald")
          .describe("单一聚焦主强调色（遵循 1-Accent 聚焦原则，仅用于凸显核心路径或高亮节点）"),
        data: z
          .record(z.string(), z.unknown())
          .describe(
            "结构化图表数据：mindmap 使用 root: {label, description?, children: [...] } 递归树，分支支持点击折叠展开；例如 architecture 包含 layers 和 connections；sequence 包含 participants 和 messages；flowchart 包含 steps 和 connections；quadrant 包含 xAxis、yAxis 和 items；timeline 包含 milestones"
          ),
      },
    },
    async ({ title, diagramType, description, theme, accent, data }) => {
      const canonical = JSON.stringify({ title, diagramType, data });
      const id = presentResultId("diagram", canonical);
      const presentPayload = {
        schemaVersion: PRESENT_SCHEMA_VERSION,
        id,
        kind: "diagram",
        title,
        description,
        diagramType,
        theme,
        accent,
        data,
      };
      return {
        content: [
          {
            type: "text",
            text: `[Present: diagram-${diagramType}] 矢量图表数据已生成（id=${id}，标题="${title}"），等待客户端渲染呈现。`,
          },
        ],
        structuredContent: presentPayload,
        data: presentPayload,
      };
    }
  );

  // 5. 按需检索 Studio 内置技能目录
  registerStudioTool(
    "list_studio_skills",
    {
      description: getStudioToolDescriptor("list_studio_skills")!.description,
      inputSchema: {},
    },
    async () => {
      const skills = listStudioSkills().filter((skill) => isSkillEnabled(skill.name));
      return {
        content: [
          {
            type: "text",
            text:
              `当前 AutumnFlow 已加载 ${skills.length} 个内置专业技能：\n` +
              skills.map((s) => `- **${s.name}**: ${s.title} — ${s.description}`).join("\n"),
          },
        ],
        data: { skills },
      };
    }
  );

  // 6. 按需读取 Studio 技能指导与 Schema 规范
  registerStudioTool(
    "get_studio_skill",
    {
      description: getStudioToolDescriptor("get_studio_skill")!.description,
      inputSchema: {
        name: z.string().describe("必填技能标识。图表规范传 'diagram-design'，交互卡片规范传 'generative-ui'；不确定时先调用 list_studio_skills 获取 name，不能省略此字段。"),
      },
    },
    async ({ name }) => {
      const skill = isSkillEnabled(name) ? getStudioSkill(name) : null;
      if (!skill) {
        return {
          content: [
            {
              type: "text",
              text: `未找到名称为 "${name}" 的 Studio 技能。可用技能可通过 list_studio_skills 工具查看。`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: skill.content,
          },
        ],
        data: { name: skill.name, title: skill.title, path: skill.path },
      };
    }
  );

  return { mcp, tools };
}

/**
 * Attempts to listen on a port. If occupied (EADDRINUSE), increments and tries next port.
 */
async function listenWithCascade(
  server: http.Server,
  startPort: number,
  maxAttempts = 30
): Promise<number> {
  let port = startPort;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: any) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return (server.address() as import("node:net").AddressInfo).port;
    } catch (err: any) {
      if (err.code === "EADDRINUSE") {
        console.warn(`[MCP Server] 端口 ${port} 已被占用，自动顺延到 ${port + 1}...`);
        port++;
      } else {
        throw err;
      }
    }
  }
  throw new Error(`[MCP Server] 无法在端口 ${startPort} 到 ${port} 范围内找到可用端口。`);
}

function forgetSession(runtime: McpUiRuntime, session: McpUiSession): void {
  const id = session.transport.sessionId;
  if (id && runtime.sessions.get(id) === session) runtime.sessions.delete(id);
}

function closeSession(runtime: McpUiRuntime, session: McpUiSession): Promise<void> {
  if (session.closing) return session.closing;
  session.closed = true;
  forgetSession(runtime, session);
  // Protocol.close also closes its transport, terminating only this session's streams.
  session.closing = session.mcp.close().finally(() => runtime.connections.delete(session));
  return session.closing;
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function trackRequest(session: McpUiSession, res: http.ServerResponse): void {
  session.lastActivity = Date.now();
  session.requests++;
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    session.requests--;
    session.lastActivity = Date.now();
    res.removeListener("finish", complete);
    res.removeListener("close", complete);
  };
  // Track the response lifetime, including uploads and long-lived SSE streams.
  res.once("finish", complete);
  res.once("close", complete);
}

async function handleMcpRequest(runtime: McpUiRuntime, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let session: McpUiSession | undefined;
  let created = false;
  try {
    if (runtime.stopping) { rpcError(res, 503, -32000, "MCP server is stopping"); return; }
    const id = req.headers["mcp-session-id"];
    if (typeof id === "string") {
      session = runtime.sessions.get(id);
      if (!session || session.closed) { rpcError(res, 404, -32001, "MCP session not found"); return; }
      // Protect the session from idle eviction while the request body is arriving.
      trackRequest(session, res);
    }
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { rpcError(res, 400, -32700, "Parse error"); return; }
    }

    if (!session && req.method === "POST" && isInitializeRequest(body)) {
      created = true;
      const { mcp, tools } = createMcpUiServer();
      applyToolSwitches(tools);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: sessionId => {
          if (runtime.stopping || session!.closed) throw new Error("MCP server is stopping");
          runtime.sessions.set(sessionId, session!);
        },
        onsessionclosed: () => forgetSession(runtime, session!),
      });
      session = { mcp, transport, lastActivity: Date.now(), requests: 0, closed: false, tools };
      runtime.connections.add(session);
      await mcp.connect(transport);
      const protocolOnClose = transport.onclose;
      // Preserve the SDK's protocol cleanup when removing our routing entry.
      transport.onclose = () => {
        session!.closed = true;
        forgetSession(runtime, session!);
        runtime.connections.delete(session!);
        protocolOnClose?.();
      };
    } else if (!session) {
      rpcError(res, 400, -32000, "Initialize a new MCP session or provide Mcp-Session-Id");
      return;
    }

    if (runtime.stopping || session.closed) {
      await closeSession(runtime, session);
      rpcError(res, 503, -32000, "MCP server is stopping");
      return;
    }
    if (created) trackRequest(session, res);
    await session.transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("[MCP Server] Streamable HTTP request error:", err);
    if (!res.headersSent && !res.destroyed) rpcError(res, 500, -32603, "Internal MCP error");
    else if (!res.writableEnded) res.end();
  } finally {
    // Invalid/aborted handshakes must not leave an unrouteable server behind.
    if (created && session && (!session.transport.sessionId || res.statusCode >= 400 || res.destroyed && !res.writableFinished)) {
      await closeSession(runtime, session).catch(err => console.error("[MCP Server] Session cleanup failed:", err));
    }
  }
}

async function closeRuntime(runtime: McpUiRuntime): Promise<void> {
  runtime.stopping = true;
  clearInterval(runtime.sweep);
  // Stop accepting clients first; closing transports releases open SSE responses.
  const stopped = new Promise<void>(resolve => runtime.server.close(() => resolve()));
  await Promise.allSettled([...runtime.connections].map(session => closeSession(runtime, session)));
  runtime.sessions.clear();
  runtime.connections.clear();
  runtime.server.closeIdleConnections?.();
  runtime.server.closeAllConnections();
  await stopped;
}

/** One HTTP listener, with independent MCP protocol state per client connection. */
export function startMcpUiServer(preferredPort = 13920, options: McpUiServerOptions = {}): Promise<McpServerInfo> {
  return withLifecycle(async () => {
    if (activeRuntime?.info) return activeRuntime.info;
    const idleTimeout = options.sessionIdleTimeoutMs ?? 60 * 60 * 1000;
    const sweepInterval = options.sessionSweepIntervalMs ?? 60 * 1000;
    if (![idleTimeout, sweepInterval].every(value => Number.isFinite(value) && value > 0)) {
      throw new Error("MCP session timeouts must be positive finite numbers");
    }
    const runtime: McpUiRuntime = {
      server: http.createServer(), info: null, sessions: new Map(), connections: new Set(), stopping: false,
    };
    runtime.server.on("request", (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, X-Requested-With, Mcp-Session-Id, Mcp-Protocol-Version");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
      if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (pathname === "/" || pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: "studio-ui", version: "1.0.0", port: runtime.info?.port,
          endpoint: runtime.info?.url, activeSessions: runtime.sessions.size }));
      } else if (pathname === "/mcp") {
        void handleMcpRequest(runtime, req, res);
      } else res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    });
    try {
      const port = process.env.MCP_PORT ? Number(process.env.MCP_PORT) : preferredPort;
      const boundPort = await listenWithCascade(runtime.server, port);
      runtime.info = { port: boundPort, url: `http://127.0.0.1:${boundPort}/mcp`, name: "studio-ui", version: "1.0.0" };
      runtime.sweep = setInterval(() => {
        const cutoff = Date.now() - idleTimeout;
        for (const session of runtime.connections) {
          if (!session.requests && session.lastActivity <= cutoff) {
            void closeSession(runtime, session).catch(err => console.error("[MCP Server] Idle session cleanup failed:", err));
          }
        }
      }, sweepInterval);
      runtime.sweep.unref();
      activeRuntime = runtime;
      console.log(`[MCP Server] Studio UI MCP Server running at ${runtime.info.url} (Streamable HTTP)`);
      return runtime.info;
    } catch (err) {
      await closeRuntime(runtime);
      throw err;
    }
  });
}

/** Close every session and release the listener before permitting a restart. */
export function stopMcpUiServer(): Promise<void> {
  return withLifecycle(async () => {
    const runtime = activeRuntime;
    if (!runtime) return;
    activeRuntime = null;
    await closeRuntime(runtime);
    console.log("[MCP Server] Studio UI MCP Server stopped.");
  });
}
