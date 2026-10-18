import { type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
import { clientCapabilities, requestAgent, sdkRequest, sdkValue, requireAgentCapability } from "./acp-sdk";
import { applyArtifactUpdate } from "../../shared/acp-session-state";
import { TerminalAuthentication } from "./terminal-auth";
import {
  QuotaCache,
  type AcpAgentQuota,
  AcpTerminalManager,
  codexAdapter,
  agyAdapter,
  claudeAdapter,
  opencodeAdapter,
  cursorAdapter,
} from "@yitom/acp-client";
import type { AgentProfile, PendingElicitation, PendingPermission } from "./types";
import {
  findHeadlessLauncher,
  isRuntimeBinary,
  RUNTIME_BASENAMES,
  spawnCrossPlatform,
  whichCommand,
} from "./platform/spawn";
import { InteractionManager } from "./interaction";
import { FsGuard } from "./fs-guard";
import { probeLiveAgyQuota } from "./runtimes/agy-quota";
import { getMcpUiServerInfo } from "./mcp-ui-server";
import { StudioAgentResources } from "./studio-agent-resources";
import { studioSessions, childAssociation } from "./session-index";

// Re-export platform helpers for external consumers & test compatibility
export {
  findHeadlessLauncher,
  isRuntimeBinary,
  RUNTIME_BASENAMES,
  whichCommand,
};

export type SseSend = (evt: Record<string, unknown>) => void;

/**
 * Encouraging client capability guidance injected into the first turn of each agent session.
 * Gently reminds the agent that Generative UI & Editorial Diagram tools are available on `studio-ui`
 * — IF the agent actually has them in its tool list (honesty gate: some agents/runtimes do not
 * load MCP servers in headless sessions; never promise tools the session does not have).
 */
export const CLIENT_GENERATIVE_UI_HINT = [
  "【客户端交互能力与体验建议 / Client Interactive Capabilities】",
  "当前客户端支持专用的富交互式 UI 与出版级矢量图表服务（MCP 服务：studio-ui）。请先检查你本次会话可用工具列表中是否包含该 MCP 服务的工具；仅当以下工具真实存在并可调用时，才在契合场景下优先调用它们，为用户提供清晰生动的视觉与交互体验。如果你的工具列表中没有这些工具，请直接忽略本段，切勿向用户承诺你可以调用它们：",
  "- 出版级矢量图表（render_editorial_diagram）：当呈现系统架构分层拓扑、服务调用时序、流程业务状态机、技术选型四象限决策矩阵或项目演进里程碑时，鼓励优先调用生成出版级矢量图表，代替原始简陋的 Mermaid 文本；",
  "- 结构化富交互卡片（show_interactive_card）：当向用户提供方案对比决策(cardType='decision')、任务排查或门禁清单('checklist')、核心性能与指标看板('metrics')或表单填报('form')时直接渲染。调用时 data 必须携带非空内容（如 decision 必须含 options: [{ id, label, description, recommended }]，严禁传空数据）；若向用户征询执行方案确认或授权决策，请调用 cardType='decision' 提供明确的选择支；真正的高危文件修改与终端命令在执行时宿主底层安全机制会自动拦截并弹出系统权限气泡；",
  "- 人机协同交互表单（prompt_form）与动态组件沙箱原型（render_react_sandbox）；",
  "- 选项确认与技术路线决策：优先通过已协商支持的 ACP elicitation 表单向用户提问，并等待用户提交答案。运行时未提供该协议通道时，使用 show_interactive_card(cardType='decision') 或正文编号选项；不要反复调用运行时明确不支持的提问工具；",
  "- 专业技能按需调取：查图表规范调用 get_studio_skill({name:\"diagram-design\"})，查交互卡片规范传 name:\"generative-ui\"；name 必填，不确定时先调用 list_studio_skills 获取标识。",
  "（注：以上工具均为可选的体验增强手段，请在符合对话场景时自然适度地运用。）",
].join("\n");

/**
 * One long-lived stdio connection to a generic ACP agent.
 * Uses @agentclientprotocol/sdk `client().connect(stream)` (persistent),
 * coordinates interaction (permissions/elicitations), filesystem guards,
 * upstream terminal management via @yitom/acp-client, and SSE broadcasting.
 */
export class UniversalAgentConnection {
  readonly profile: AgentProfile;
  private proc: ChildProcess | null = null;
  private stoppingProc: ChildProcess | null = null;
  private conn: acp.ClientConnection | null = null;
  private initResult: acp.InitializeResponse | null = null;
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private stderrTail: string[] = [];

  private connectInFlight: Promise<unknown> | null = null;
  private sessionSinks = new Map<string, Set<SseSend>>();
  private sessionCommands = new Map<string, unknown[]>();
  /** Short-lived first-page session/list cache: sidebar polls history every 5s. */
  private listedSessionsCache: { at: number; result: unknown } | null = null;
  private childParents = new Map<string, string>();
  private childUpdates = new Map<string, unknown[]>();
  private childStates = new Map<string, acp.SubagentUpdate>();

  private interaction: InteractionManager;
  private fsGuard: FsGuard;
  private terminals = new AcpTerminalManager();
  private terminalOwners = new Map<string, string>();
  private releasedTerminals = new Map<string, { sessionId: string; output: acp.TerminalOutputResponse }>();

  /**
   * Per-session prompt mutex: ACP session/prompt is strictly serial per
   * session. Concurrent prompt() calls for the same sessionId throw
   * `session busy ... (409)`; routes translate that into HTTP 409 so the
   * frontend can serialize/queue instead of interleaving turns.
   */
  private promptLocks = new Set<string>();
  private sessionTurnCounts = new Map<string, number>();
  private quotaCache = new QuotaCache();
  private lastQuota: AcpAgentQuota | null = null;
  private resources = new StudioAgentResources(CLIENT_GENERATIVE_UI_HINT);
  private terminalAuth: TerminalAuthentication;

  constructor(profile: AgentProfile) {
    this.profile = profile;
    this.terminalAuth = new TerminalAuthentication(profile);
    this.interaction = new InteractionManager(profile.id, (sid, evt) => this.broadcast(sid, evt));
    this.fsGuard = new FsGuard(profile.id, (sid, kind, detail) => this.emitActivity(sid, kind, detail));
    // Initial best-effort probe based on profile
    this.probeQuotaBackground();
  }

  async probeQuotaBackground(): Promise<AcpAgentQuota | null> {
    try {
      const id = this.profile.id;
      let q: AcpAgentQuota | null = null;
      if (id === "codex") {
        q = (await codexAdapter.probeQuota?.()) ?? null;
        if (q) q.runtimeId = "codex";
      } else if (id === "antigravity-stdio" || id === "agy") {
        const live = await probeLiveAgyQuota(id);
        console.log(`[probeQuotaBackground] live agy quota:`, live ? "SUCCESS" : "NULL");
        q = live ?? (await agyAdapter.probeQuota?.()) ?? null;
        if (q) q.runtimeId = id;
      } else if (id === "claude") {
        q = (await claudeAdapter.probeQuota?.()) ?? null;
      } else if (id === "opencode" || id === "opencode-v2") {
        q = (await opencodeAdapter.probeQuota?.()) ?? null;
      } else if (id === "cursor-cli") {
        q = (await cursorAdapter.probeQuota?.()) ?? null;
      }
      if (q) {
        this.lastQuota = q;
        this.quotaCache.set(q);
      }
      return q;
    } catch {
      return null;
    }
  }

  get connected(): boolean {
    return !!this.conn && !!this.proc && this.proc.exitCode === null && !(this.proc.killed ?? false);
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  status() {
    const init = this.initResult;
    // codex puts authStatus under agentCapabilities._meta, others (if any)
    // under top-level _meta — check both.
    const capsMeta = init?.agentCapabilities?._meta;
    return {
      id: this.profile.id,
      connected: this.connected,
      pid: this.pid,
      protocolVersion: init?.protocolVersion ?? null,
      agentInfo: init?.agentInfo ?? null,
      agentCapabilities: init?.agentCapabilities ?? null,
      authMethods: init?.authMethods ?? null,
      // Raw `_meta` from initialize (e.g. codex steering/goal/jetbrains), plus
      // a convenience alias so clients don't need to dig into `_meta`.
      authStatus: init?._meta?.authStatus ?? capsMeta?.authStatus ?? null,
      meta: init?._meta ?? null,
      quota: this.lastQuota,
      resources: this.resources.report(),
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }

  getInitResult(): acp.InitializeResponse | null {
    return this.initResult;
  }

  subscribe(sessionId: string, send: SseSend): () => void {
    let set = this.sessionSinks.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionSinks.set(sessionId, set);
    }
    set.add(send);
    return () => {
      set!.delete(send);
      if (set!.size === 0) this.sessionSinks.delete(sessionId);
    };
  }

  /** Cached commands for a session (undefined = agent never sent any). */
  getAvailableCommands(sessionId: string): unknown[] | undefined {
    return this.sessionCommands.get(sessionId);
  }

  /** Wait briefly for a trailing available_commands_update after a session RPC. */
  async awaitAvailableCommands(sessionId: string, maxMs = 150): Promise<unknown[] | undefined> {
    for (let t = 0; t < maxMs && !this.sessionCommands.has(sessionId); t += 25) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.sessionCommands.get(sessionId);
  }

  private broadcast(sessionId: string, evt: Record<string, unknown>) {
    if (!sessionId || sessionId === "*") {
      for (const set of this.sessionSinks.values()) {
        for (const send of set) {
          try {
            send(evt);
          } catch {
            // ignore closed sinks
          }
        }
      }
      return;
    }
    const set = this.sessionSinks.get(sessionId);
    if (set) {
      for (const send of set) {
        try {
          send(evt);
        } catch {
          // ignore closed sinks
        }
      }
    }
  }

  /** Broadcast an fs/terminal/compaction activity line into session sinks. */
  private emitActivity(sessionId: string, kind: string, detail?: unknown) {
    if (!sessionId) return;
    this.broadcast(sessionId, { type: "activity", agentId: this.profile.id, sessionId, kind, detail });
  }

  listPendingPermissions(sessionId?: string) {
    return this.interaction.listPendingPermissions(sessionId);
  }

  listPendingElicitations(sessionId?: string) {
    return this.interaction.listPendingElicitations(sessionId);
  }

  /** Snapshot used by the quit/update guard; no tool output or file contents. */
  inspectActiveWork() {
    const subagents = [...this.childStates.entries()]
      .map(([sessionId, state]) => ({
        sessionId,
        title: String((state as any)?.title || (state as any)?.name || ""),
        status: String((state as any)?.status || ""),
      }))
      .filter((subagent) => !subagent.status || /running|pending|started|in_progress/i.test(subagent.status));
    return {
      agentId: this.profile.id,
      runningSessions: [...this.promptLocks],
      permissions: this.listPendingPermissions(),
      elicitations: this.listPendingElicitations(),
      subagents,
    };
  }

  resolvePermission(permissionId: string, outcome: unknown): boolean {
    return this.interaction.resolvePermission(permissionId, outcome);
  }

  resolveElicitation(elicitationId: string, result: unknown): boolean {
    return this.interaction.resolveElicitation(elicitationId, result);
  }

  /** 会话允许写入的根（未知会话 → 只剩全局根）。供测试与诊断。 */
  allowedRootsFor(sessionId: string): string[] {
    return this.fsGuard.allowedRootsFor(sessionId);
  }

  async connect(): Promise<unknown> {
    if (this.connected && this.initResult) return this.initResult;
    if (this.connectInFlight) return this.connectInFlight;

    this.connectInFlight = (async () => {
      try {
        await this.spawn();
        return this.initResult;
      } catch (err) {
        await this.disconnect();
        throw err;
      } finally {
        this.connectInFlight = null;
      }
    })();

    return this.connectInFlight;
  }

  private async spawn(): Promise<void> {
    await this.disconnect();
    this.lastError = null;
    this.stderrTail = [];

    const env = { ...process.env, ...(this.profile.env || {}) } as Record<string, string>;
    // Ensure NO_PROXY for localhost so local MCP/servers never go through proxy
    env.NO_PROXY = env.NO_PROXY || "localhost,127.0.0.1,::1";
    env.no_proxy = env.no_proxy || "localhost,127.0.0.1,::1";

    const cwd = this.profile.defaultCwd && fs.existsSync(this.profile.defaultCwd) ? this.profile.defaultCwd : process.cwd();
    // Shell principle: fail fast with install guidance when the vendor CLI
    // is missing, instead of a cryptic spawn ENOENT/EINVAL.
    const resolved = whichCommand(this.profile.command);
    if (!resolved) {
      const hint = this.profile.installHint ? ` ${this.profile.installHint}` : "";
      throw new Error(`命令 '${this.profile.command}' 不在 PATH 中。${hint}`.trim());
    }
    Object.assign(env, await this.resources.prepare(this.profile.id, cwd, resolved, env));
    console.log(`[UniversalACP:${this.profile.id}] spawn: ${this.profile.command} ${(this.profile.args || []).join(" ")}`);

    const proc = spawnCrossPlatform(this.profile.command, this.profile.args || [], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    this.startedAt = new Date().toISOString();

    proc.on("error", (err) => {
      this.lastError = `spawn error: ${(err as Error).message}`;
      console.error(`[UniversalACP:${this.profile.id}]`, this.lastError);
    });
    proc.on("exit", (code, signal) => {
      console.warn(`[UniversalACP:${this.profile.id}] exited code=${code} signal=${signal} stderrTail=${this.stderrTail.slice(-3).join(" | ")}`);
      // Fail pending permission/elicitation so prompt turns don't hang forever
      this.interaction.rejectAllOnExit(code, signal);
      this.terminals.releaseAll();
      this.conn = null;
      if (!this.lastError && (code !== 0 || signal)) {
        const details = this.stderrTail.length ? `: ${this.stderrTail.slice(-3).join(" | ")}` : "";
        this.lastError = `Agent process exited unexpectedly (code ${code}, signal ${signal})${details}`;
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        this.stderrTail.push(t);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
      }
      process.stderr.write(`[ACP:${this.profile.id}] ${text}`);
    });

    if (!proc.stdin || !proc.stdout) {
      throw new Error(`Failed to open stdio pipes for ${this.profile.id}`);
    }

    const toWebWritable = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>;
    const toWebReadable = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(toWebWritable, toWebReadable);

    const self = this;
    const app = acp
      .client({ name: "acp-studio-universal" })
      .onRequest(acp.methods.client.session.requestPermission, ctx => self.interaction.handlePermissionRequest(ctx.params, ctx.signal))
      .onRequest(acp.methods.client.fs.readTextFile, ctx => self.fsGuard.handleReadFile(ctx.params))
      .onRequest(acp.methods.client.fs.writeTextFile, ctx => self.fsGuard.handleWriteFile(ctx.params))
      .onRequest(acp.methods.client.terminal.create, ctx => self.handleTerminalCreate(ctx.params))
      .onRequest(acp.methods.client.terminal.output, ctx => {
        self.requireTerminalOwner(ctx.params);
        return self.terminals.getOutput(ctx.params.terminalId);
      })
      .onRequest(acp.methods.client.terminal.release, ctx => {
        const params = ctx.params;
        self.requireTerminalOwner(params);
        self.releasedTerminals.set(params.terminalId, { sessionId: params.sessionId, output: self.terminals.getOutput(params.terminalId) });
        self.terminalOwners.delete(params.terminalId);
        self.emitActivity(params.sessionId || "", "terminal_release", { terminalId: params.terminalId });
        return self.terminals.release(params.terminalId);
      })
      .onRequest(acp.methods.client.terminal.waitForExit, ctx => {
        self.requireTerminalOwner(ctx.params);
        return self.terminals.waitForExit(ctx.params.terminalId);
      })
      .onRequest(acp.methods.client.terminal.kill, ctx => {
        const params = ctx.params;
        self.requireTerminalOwner(params);
        self.emitActivity(params.sessionId || "", "terminal_kill", { terminalId: params.terminalId });
        return self.terminals.kill(params.terminalId);
      })
      .onRequest(acp.methods.client.elicitation.create, ctx => self.interaction.handleElicitation(ctx.params, ctx.signal))
      .onNotification(acp.methods.client.session.update, async ctx => {
        const params = ctx.params;
        if (params.update.sessionUpdate === "subagent_update") {
          const previous = self.childStates.get(params.update.sessionId);
          const entries = applyArtifactUpdate(previous ? [{ kind: "subagent", value: previous }] : [], params.update);
          const state = entries[0];
          if (state?.kind === "subagent") self.childStates.set(state.value.sessionId, state.value);
        }
        const association = childAssociation(params.sessionId, params.update);
        if (association) {
          studioSessions.linkChild(self.profile.id, association.parentSessionId, association.sessionId, association.title);
          self.childParents.set(association.sessionId, association.parentSessionId);
          self.fsGuard.rememberSessionRoots(association.sessionId, self.fsGuard.allowedRootsFor(association.parentSessionId));
        }
        const childId = association?.sessionId || (self.childParents.has(params.sessionId) ? params.sessionId : null);
        if (childId && params.update.sessionUpdate !== "subagent_update") {
          const updates = self.childUpdates.get(childId) || [];
          updates.push(params.update);
          if (updates.length > 200) updates.shift();
          self.childUpdates.set(childId, updates);
          // Keep child output out of the main transcript. A read-only replay subscriber
          // still receives it on the child's own ID.
          self.broadcast(childId, { type: "update", sessionId: childId, update: params.update });

          // Inform parent session sink that child session is actively working
          const parentSessionId = self.childParents.get(childId);
          if (parentSessionId) {
            const childTitle = studioSessions.get(self.profile.id, childId)?.title || "子智能体";
            self.emitActivity(parentSessionId, "subagent_active", {
              childId,
              title: childTitle,
              updateType: params.update.sessionUpdate,
            });

            // 将子智能体的工具调用与思考过程实时桥接至父会话广播流，
            // 确保用户界面实时展示子任务的工具调用卡片与思考过程，避免“静默等待”
            const updateType = params.update.sessionUpdate;
            if (updateType === "tool_call" || updateType === "tool_call_update") {
              const u = params.update;
              const origTitle = typeof u.title === "string" ? u.title : "";
              const prefixedTitle = origTitle ? `[${childTitle}] ${origTitle}` : `[${childTitle}] 工具调用`;
              self.broadcast(parentSessionId, {
                type: "update",
                agentId: self.profile.id,
                sessionId: parentSessionId,
                update: {
                  ...u,
                  title: prefixedTitle,
                },
              });
            } else if (updateType === "agent_thought_chunk") {
              self.broadcast(parentSessionId, {
                type: "update",
                agentId: self.profile.id,
                sessionId: parentSessionId,
                update: params.update,
              });
            }
          }
          return;
        }
        if (params.update.sessionUpdate === "session_info_update") {
          const title = params.update.title;
          if (typeof title === "string") studioSessions.update(self.profile.id, params.sessionId, { title, updatedAt: new Date().toISOString() });
        }
        if (params.update?.sessionUpdate === "available_commands_update" && params.sessionId) {
          const list = (params.update as { availableCommands?: unknown }).availableCommands;
          self.sessionCommands.set(params.sessionId, Array.isArray(list) ? list : []);
        }
        const observed = self.quotaCache.observe(params, self.profile.id);
        if (observed) {
          self.lastQuota = observed;
        }
        self.broadcast(params.sessionId, {
          type: "update",
          agentId: self.profile.id,
          sessionId: params.sessionId,
          update: params.update,
          quota: self.lastQuota,
        });
      })
      .onNotification(acp.methods.client.elicitation.complete, ctx => self.interaction.completeElicitation(ctx.params));

    this.conn = app.connect(stream);

    // initialize handshake with full client capabilities (ACP v1)
    try {
      const res = await requestAgent(this.conn, acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { ...clientCapabilities, auth: { terminal: this.terminalAuth.available(resolved) } },
        clientInfo: { name: "acp-studio-universal", title: "ACP Studio Universal", version: "1.0.0" },
      });
      if (res.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`Unsupported ACP protocol version: ${res.protocolVersion}`);
      this.initResult = res;
      this.resources.handshake(this.initResult.agentInfo?.version || "");
      console.log(
        `[UniversalACP:${this.profile.id}] initialize ok protocol=${this.initResult.protocolVersion}`
      );
      this.probeQuotaBackground();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? "ACP connection failed");
      const stderr = this.stderrTail.length ? `. stderr: ${this.stderrTail.slice(-5).join(" | ")}` : "";
      this.lastError = `initialize failed: ${msg}${stderr}`;
      console.error(`[UniversalACP:${this.profile.id}]`, this.lastError);
      await this.disconnect().catch(() => undefined);
      throw new Error(this.lastError);
    }
  }

  private handleTerminalCreate(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    const command = String(params.command || "");
    if (!command) throw new Error("terminal/create: command is required");
    const sessionCwd = this.fsGuard.getSessionCwd(String(params.sessionId || ""));
    const requested = typeof params.cwd === "string" && params.cwd ? params.cwd : "";
    const cwd = requested || sessionCwd || this.profile.defaultCwd || process.cwd();
    let cwdOk = false;
    try {
      cwdOk = fs.existsSync(cwd) && fs.statSync(cwd).isDirectory();
    } catch (err) {
      throw new acp.RequestError(-32602, `terminal/create: cannot access cwd ${cwd}: ${(err as Error).message}`, { cwd });
    }
    if (!cwdOk) {
      throw new acp.RequestError(-32602, `terminal/create: cwd does not exist or is not a directory: ${cwd}`, { cwd });
    }
    const sessionId = String(params.sessionId || "");
    this.emitActivity(sessionId, "terminal_create", { command, args: params.args, cwd });
    const terminal = this.terminals.create({
        command,
        args: params.args ?? [],
        cwd,
        workspaceRoot: sessionCwd || cwd,
        env: params.env ?? undefined,
        outputByteLimit: typeof params.outputByteLimit === "number" ? params.outputByteLimit : undefined,
        sessionId,
      });
    this.terminalOwners.set(terminal.terminalId, sessionId);
    return Promise.resolve(terminal);
  }

  private requireTerminalOwner(params: acp.TerminalOutputRequest): void {
    if (this.terminalOwners.get(params.terminalId) !== params.sessionId) throw acp.RequestError.invalidParams(undefined, "Unknown terminal in this session");
  }

  terminalDisplayOutput(params: acp.TerminalOutputRequest): acp.TerminalOutputResponse {
    const released = this.releasedTerminals.get(params.terminalId);
    if (released?.sessionId === params.sessionId) return released.output;
    this.requireTerminalOwner(params);
    return this.terminals.getOutput(params.terminalId);
  }

  async disconnect(): Promise<void> {
    this.terminalAuth.dispose();
    this.interaction.rejectAllOnExit(null, null);
    this.childStates.clear();
    this.childParents.clear();
    this.childUpdates.clear();
    this.sessionCommands.clear();
    this.terminalOwners.clear();
    this.releasedTerminals.clear();
    const proc = this.proc || this.stoppingProc;
    this.stoppingProc = proc;
    this.proc = null;
    this.conn = null;
    this.initResult = null;
    this.startedAt = null;
    this.terminals.releaseAll();
    if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { proc.removeListener("close", done); resolve(); }, 2000);
        const done = () => { clearTimeout(timer); resolve(); };
        proc.once("close", done);
        try { proc.kill(); } catch { clearTimeout(timer); proc.removeListener("close", done); resolve(); }
      });
    }
    // Never remove a resource snapshot that a live bridge may still be reading.
    if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) {
      await this.resources.dispose();
      this.stoppingProc = null;
    }
    else throw new Error("Agent process did not exit; application resource snapshot retained for cleanup");
  }

  private ensureConn(): acp.ClientConnection {
    if (!this.conn || !this.connected) {
      throw new Error(`Agent ${this.profile.id} is not connected`);
    }
    return this.conn;
  }

  async authenticate(methodId: string, extra?: Record<string, unknown>): Promise<unknown> {
    const conn = this.ensureConn();
    const method = this.initResult?.authMethods?.find(candidate => candidate.id === methodId);
    if (!method) throw acp.RequestError.invalidParams(undefined, "Authentication method was not advertised by this agent");
    if ("type" in method && method.type === "terminal") {
      const descriptor = sdkValue<acp.AuthMethodTerminal>("AuthMethodTerminal", method);
      return { terminal: this.terminalAuth.start(whichCommand(this.profile.command) || this.profile.command, descriptor) };
    }
    return requestAgent(conn, acp.methods.agent.authenticate, sdkRequest(acp.methods.agent.authenticate, { ...extra, methodId }));
  }

  async finishTerminalAuth(id: string): Promise<void> {
    this.terminalAuth.finish(id);
    await this.disconnect();
    await this.connect();
  }
  cancelTerminalAuth(id: string): void { this.terminalAuth.cancel(id); }

  async logout(): Promise<unknown> {
    const conn = this.ensureConn();
    requireAgentCapability("auth.logout", this.initResult?.agentCapabilities?.auth?.logout);
    return requestAgent(conn, acp.methods.agent.logout, {});
  }

  /**
   * Enrich sessions with local MCP descriptors and the SDK's version-gated resource binding.
   * Applied symmetrically to session/new, session/resume, session/load, session/fork.
   */
  private enrichSessionPayload<T extends { cwd?: unknown; mcpServers?: unknown; additionalDirectories?: unknown }>(args: T): {
    cwd: string;
    mcpServers: acp.McpServer[];
    additionalDirectories: string[];
    roots: string[];
    resourceMeta?: Record<string, unknown>;
  } {
    const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : (this.profile.defaultCwd || process.cwd());
    const additionalDirectories = Array.isArray(args.additionalDirectories) ? args.additionalDirectories.map(directory => {
      if (typeof directory !== "string") throw acp.RequestError.invalidParams(undefined, "Additional directory must be a path string");
      return directory;
    }) : [];
    if (additionalDirectories.length) requireAgentCapability("session.additionalDirectories", this.initResult?.agentCapabilities?.sessionCapabilities?.additionalDirectories);
    const roots = this.fsGuard.sessionRootsFor(cwd, additionalDirectories);
    const mcpServers = Array.isArray(args.mcpServers) ? args.mcpServers.map(server => sdkValue<acp.McpServer>("McpServer", server)) : [];
    for (const configured of this.resources.configuredMcpServers()) {
      const server = sdkValue<acp.McpServer>("McpServer", configured);
      if (!mcpServers.some(existing => existing.name === server.name)) mcpServers.push(server);
    }
    const mcpInfo = getMcpUiServerInfo();
    const agentCaps = this.initResult?.agentCapabilities?.mcpCapabilities;
    for (const server of mcpServers) {
      if ("type" in server) requireAgentCapability(`mcp.${server.type}`, agentCaps?.[server.type]);
    }
    if (mcpInfo && agentCaps?.http) {
      const alreadyHas = mcpServers.some(
        s => s.name === mcpInfo.name || ("url" in s && s.url === mcpInfo.url)
      );
      if (!alreadyHas) {
        mcpServers.push({
          type: "http",
          name: mcpInfo.name,
          url: mcpInfo.url,
          headers: [],
        });
      }
    }
    return { cwd, mcpServers, additionalDirectories, roots, resourceMeta: this.resources.sessionMeta() };
  }

  async newSession(args: { cwd?: string; mcpServers?: unknown[]; additionalDirectories?: string[] }): Promise<unknown> {
    const conn = this.ensureConn();
    const { cwd, mcpServers, additionalDirectories, roots, resourceMeta } = this.enrichSessionPayload(args);
    const result = await requestAgent(conn, acp.methods.agent.session.new, {
      cwd,
      mcpServers,
      ...(resourceMeta ? { _meta: resourceMeta } : {}),
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
    });
    const newSid = result.sessionId;
    if (typeof newSid === "string") {
      studioSessions.remember(this.profile.id, newSid, "created", { cwd });
      this.sessionTurnCounts.set(newSid, 0);
      this.resources.rememberSession(newSid, result);
    }
    this.fsGuard.rememberSessionRoots(newSid, roots);
    return result;
  }

  async loadSession(args: Record<string, unknown>): Promise<{ result: unknown; replayed: unknown[] }> {
    const conn = this.ensureConn();
    requireAgentCapability("loadSession", this.initResult?.agentCapabilities?.loadSession);
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    const { cwd, mcpServers, additionalDirectories, roots, resourceMeta } = this.enrichSessionPayload(args);
    const payload = {
      ...args,
      sessionId,
      cwd,
      mcpServers,
      ...(resourceMeta ? { _meta: { ...this.requestMeta(args._meta), ...resourceMeta } } : {}),
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
    };
    // session/load replays history via session/update notifications before
    // responding. Collect them so HTTP clients can rebuild the transcript.
    const replayed: unknown[] = [];
    const unsub = sessionId ? this.subscribe(sessionId, (evt) => {
      if ((evt as { type?: string }).type === "update") replayed.push((evt as { update?: unknown }).update);
    }) : () => undefined;
    try {
      const result = await requestAgent(conn, acp.methods.agent.session.load, sdkRequest(acp.methods.agent.session.load, payload));
      if (sessionId) {
        this.sessionTurnCounts.set(sessionId, 0);
        this.resources.rememberSession(sessionId, result);
      }
      this.fsGuard.rememberSessionRoots(sessionId, roots);
      // Grace window: session/update notifications are dispatched
      // asynchronously and can lag behind the load response. Unsubscribing
      // immediately drops the tail (e.g. the final assistant chunk). Wait
      // until quiet instead (same reason prompt() waits 50ms post-result).
      for (let i = 0; i < 20; i++) {
        const n = replayed.length;
        await new Promise((r) => setTimeout(r, 25));
        if (replayed.length === n) break;
      }
      // session/load replay is the authoritative place to recover the title
      // when session/list is unavailable or hasn't polled yet. Read it after
      // the grace window so a trailing session_info_update is not missed.
      const titleUpdate = [...replayed].reverse().find(
        (update: any) => update?.sessionUpdate === "session_info_update" && typeof update.title === "string" && update.title.trim(),
      ) as { title?: string } | undefined;
      if (titleUpdate?.title && sessionId) {
        studioSessions.update(this.profile.id, sessionId, { title: titleUpdate.title });
      }
      return { result, replayed };
    } finally {
      unsub();
    }
  }

  /** UNSTABLE session/fork (advertised via sessionCapabilities.fork, e.g. codex). */
  async forkSession(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.ensureConn();
    requireAgentCapability("session.fork", this.initResult?.agentCapabilities?.sessionCapabilities?.fork);
    const { cwd, mcpServers, additionalDirectories, roots, resourceMeta } = this.enrichSessionPayload(args);
    const payload = {
      ...args,
      cwd,
      mcpServers,
      ...(resourceMeta ? { _meta: { ...this.requestMeta(args._meta), ...resourceMeta } } : {}),
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
    };
    const result = await requestAgent(conn, acp.methods.agent.session.fork, sdkRequest(acp.methods.agent.session.fork, payload));
    const newSid = result.sessionId;
    if (typeof newSid === "string") {
      studioSessions.remember(this.profile.id, newSid, "created", { cwd });
      this.sessionTurnCounts.set(newSid, 0);
      this.resources.rememberSession(newSid, result);
    }
    this.fsGuard.rememberSessionRoots(newSid, roots);
    return result;
  }

  /** UNSTABLE providers/* (advertised via providers capability, e.g. codex). */
  async providersRpc(action: "list" | "set" | "disable", body: Record<string, unknown>): Promise<unknown> {
    const conn = this.ensureConn();
    requireAgentCapability("providers", this.initResult?.agentCapabilities?.providers);
    if (action === "list") return requestAgent(conn, acp.methods.agent.providers.list, sdkRequest(acp.methods.agent.providers.list, body));
    if (action === "set") return requestAgent(conn, acp.methods.agent.providers.set, sdkRequest(acp.methods.agent.providers.set, body));
    return requestAgent(conn, acp.methods.agent.providers.disable, sdkRequest(acp.methods.agent.providers.disable, body));
  }

  /**
   * Escape hatch for legacy/unstable agent methods (e.g. session/set_model
   * on agy-style servers that lack session config options).
   */
  async rawRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const conn = this.ensureConn();
    // Vendor legacy method, explicitly separated from the standard SDK surface.
    if (!method.startsWith("_") && !(method === "session/set_model" && ["antigravity-stdio", "agy"].includes(this.profile.id))) {
      throw acp.RequestError.methodNotFound("Unnegotiated vendor method");
    }
    return conn.agent.request<unknown, Record<string, unknown>>(method, params);
  }

  async resumeSession(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.ensureConn();
    requireAgentCapability("session.resume", this.initResult?.agentCapabilities?.sessionCapabilities?.resume);
    const { cwd, mcpServers, additionalDirectories, roots, resourceMeta } = this.enrichSessionPayload(args);
    const payload = {
      ...args,
      cwd,
      mcpServers,
      ...(resourceMeta ? { _meta: { ...this.requestMeta(args._meta), ...resourceMeta } } : {}),
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
    };
    const request = sdkRequest(acp.methods.agent.session.resume, payload);
    const result = await requestAgent(conn, acp.methods.agent.session.resume, request);
    const sid = request.sessionId;
    if (sid) {
      this.sessionTurnCounts.set(sid, 0);
      this.resources.rememberSession(sid, result);
    }
    this.fsGuard.rememberSessionRoots(sid, roots);
    return result;
  }

  async listSessions(args: Record<string, unknown> = {}): Promise<unknown> {
    const conn = this.ensureConn();
    requireAgentCapability("session.list", this.initResult?.agentCapabilities?.sessionCapabilities?.list);
    const firstPage = !args.cursor;
    if (firstPage && this.listedSessionsCache && Date.now() - this.listedSessionsCache.at < 15_000) {
      return this.listedSessionsCache.result;
    }
    const result = await requestAgent(conn, acp.methods.agent.session.list, sdkRequest(acp.methods.agent.session.list, args));
    const rows = Array.isArray(result.sessions) ? result.sessions : [];
    // Pull Agent-provided titles/timestamps into the app's own reference rows.
    // Only existing rows are touched, so opening the sidebar never imports
    // unrelated sessions from the agent's store.
    const known = new Set(studioSessions.list(this.profile.id).map(row => row.sessionId));
    studioSessions.updateMany(
      this.profile.id,
      rows
        .filter(row => known.has(String(row.sessionId || "")))
        .map(row => ({
          sessionId: String(row.sessionId || ""),
          ...(typeof row.title === "string" && row.title.trim() ? { title: row.title } : {}),
          ...(typeof row.updatedAt === "string" && row.updatedAt ? { updatedAt: row.updatedAt } : {}),
          ...(typeof row.cwd === "string" && row.cwd ? { cwd: row.cwd } : {}),
        })),
    );
    for (const row of rows) {
      const association = childAssociation("", row);
      if (association) {
        studioSessions.linkChild(this.profile.id, association.parentSessionId, association.sessionId, association.title);
        this.childParents.set(association.sessionId, association.parentSessionId);
      }
    }
    if (firstPage) this.listedSessionsCache = { at: Date.now(), result };
    return result;
  }

  /** Child inspection never binds the UI, resumes, prompts or changes its configuration. */
  async viewChild(sessionId: string): Promise<{ replayed: unknown[]; source: "live" | "agent" }> {
    const record = studioSessions.get(this.profile.id, sessionId);
    if (record?.kind !== "subagent") throw new Error("该会话不是已识别的子智能体会话");
    const live = this.childUpdates.get(sessionId);
    if (live?.length) return { replayed: [...live], source: "live" };
    if (!this.initResult?.agentCapabilities?.loadSession) throw new Error("该 Agent 未提供子会话历史回放，当前也没有可查看的运行记录。");
    this.childParents.set(sessionId, record.parentSessionId!);
    const replayed: unknown[] = [];
    const unsubscribe = this.subscribe(sessionId, event => {
      if (event.type === "update") replayed.push(event.update);
    });
    try {
      await this.ensureConn().agent.request(acp.methods.agent.session.load, {
        sessionId, cwd: record.cwd || process.cwd(), mcpServers: [],
      });
      return { replayed, source: "agent" };
    } finally { unsubscribe(); }
  }

  async deleteSession(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.ensureConn();
    const sid = typeof args.sessionId === "string" ? args.sessionId : "";
    this.listedSessionsCache = null;
    if (sid) {
      this.sessionTurnCounts.delete(sid);
    }
    requireAgentCapability("session.delete", this.initResult?.agentCapabilities?.sessionCapabilities?.delete);
    const result = await requestAgent(conn, acp.methods.agent.session.delete, sdkRequest(acp.methods.agent.session.delete, args));
    studioSessions.forget(this.profile.id, sid);
    this.resources.forgetSession(sid);
    return result;
  }

  async closeSession(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.ensureConn();
    const sid = typeof args.sessionId === "string" ? args.sessionId : "";
    this.listedSessionsCache = null;
    if (sid) {
      this.sessionTurnCounts.delete(sid);
    }
    const caps = this.initResult?.agentCapabilities;
    if (!caps?.sessionCapabilities?.close) {
      // Best-effort: drop local sinks even if agent has no close
      if (sid) this.sessionSinks.delete(sid);
      this.resources.forgetSession(sid);
      return {};
    }
    const result = await requestAgent(conn, acp.methods.agent.session.close, sdkRequest(acp.methods.agent.session.close, args));
    this.resources.forgetSession(sid);
    return result;
  }

  async setMode(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.ensureConn();
    return requestAgent(conn, acp.methods.agent.session.setMode, sdkRequest(acp.methods.agent.session.setMode, args));
  }

  async setConfigOption(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.ensureConn();
    // Normalize to SetSessionConfigOptionRequest shapes:
    // select -> {sessionId, configId, value: "<valueId>"} (value_id variant),
    // boolean/string -> value as-is. Accept both camelCase and snake_case from callers.
    const sessionId = (args.sessionId ?? args.session_id) as string;
    const configId = (args.configId ?? args.config_id) as string;
    let value = args.value;
    if (typeof value === "object" && value !== null) {
      const v = value as { value_id?: unknown; valueId?: unknown };
      if (typeof v.value_id === "string") value = v.value_id;
      else if (typeof v.valueId === "string") value = v.valueId;
    }
    if (!sessionId || !configId) {
      throw new Error(`setConfigOption: sessionId and configId required (got sessionId=${sessionId}, configId=${configId})`);
    }
    return requestAgent(conn, acp.methods.agent.session.setConfigOption, sdkRequest(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      value,
      ...(typeof value === "boolean" ? { type: "boolean" } : {}),
    }));
  }

  async cancel(sessionId: string): Promise<void> {
    const conn = this.ensureConn();
    if (!this.canCancelSession(sessionId)) throw acp.RequestError.invalidParams(undefined, "This child session did not permit cancellation");
    try {
      await conn.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    } catch (err) {
      console.error(`[UniversalACP:${this.profile.id}] cancel notify failed session=${sessionId}: ${(err as Error).message}`);
      throw err;
    } finally {
      // Release the prompt mutex so a fresh turn can start after cancel
      if (sessionId && this.promptLocks.has(sessionId)) {
        this.promptLocks.delete(sessionId);
      }
    }
    // Unblock any pending permission for this session as cancelled
    this.interaction.cancelPendingForSession(sessionId);
  }

  canCancelSession(sessionId: string): boolean {
    return studioSessions.get(this.profile.id, sessionId)?.kind !== "subagent" || this.childStates.get(sessionId)?.capabilities?.cancel != null;
  }

  /**
   * Send session/prompt. Streams session/update via onEvent callback until stop.
   * Permission/elicitation requests are surfaced via onEvent as well; the
   * underlying agent request stays pending until UI responds.
   * Mutex: same sessionId concurrent prompt() throws 409.
   */
  async prompt(
    sessionId: string,
    prompt: acp.ContentBlock[],
    onEvent: SseSend,
    opts?: { signal?: AbortSignal }
  ): Promise<unknown> {
    const conn = this.ensureConn();
    const supported = this.initResult?.agentCapabilities?.promptCapabilities;
    for (const block of prompt) {
      if (block.type === "image") requireAgentCapability("prompt.image", supported?.image);
      if (block.type === "audio") requireAgentCapability("prompt.audio", supported?.audio);
      if (block.type === "resource") requireAgentCapability("prompt.embeddedContext", supported?.embeddedContext);
    }
    if (!sessionId) throw new Error("sessionId is required");
    if (studioSessions.get(this.profile.id, sessionId)?.kind === "subagent") throw new Error("子智能体会话仅供查看，请在主会话中发送消息");
    if (this.promptLocks.has(sessionId)) {
      throw new Error("session busy: previous prompt still running (409)");
    }
    studioSessions.update(this.profile.id, sessionId, { updatedAt: new Date().toISOString() });
    this.promptLocks.add(sessionId);
    const unsub = this.subscribe(sessionId, onEvent);
    let onAbort: (() => void) | undefined;
    try {
      if (opts?.signal) {
        onAbort = () => {
          this.cancel(sessionId).catch((err) => {
            console.error(`[UniversalACP:${this.profile.id}] abort-cancel failed session=${sessionId}: ${(err as Error).message}`);
          });
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Verified native delivery keeps application rules out of user messages.
      // Unverified runtimes receive one explicitly marked compatibility block.
      const turnCount = this.sessionTurnCounts.get(sessionId) ?? 0;
      this.sessionTurnCounts.set(sessionId, turnCount + 1);

      let effectivePrompt = prompt;
      const compatibilityContext = this.resources.compatibilityText(sessionId);
      const isOpencode = this.profile.id === "opencode";
      const opencodeCompatibility = (isOpencode && turnCount === 0)
        ? "【OpenCode 交互指引】：客户端已通过官方 ACP SDK 声明并处理标准 elicitation 的 form 和 url 模式。只有运行时实际转发 elicitation/create，原生提问才能显示；若当前版本未转发或原生 question 已被禁用，请使用 show_interactive_card(cardType='decision') 或正文编号选项等待用户选择，不要重复调用失败的原生 question。"
        : null;

      const prefixBlocks: acp.ContentBlock[] = [];
      if (compatibilityContext) {
        prefixBlocks.push({ type: "text", text: compatibilityContext });
      }
      if (opencodeCompatibility) {
        prefixBlocks.push({ type: "text", text: opencodeCompatibility });
      }

      if (prefixBlocks.length > 0 && Array.isArray(prompt)) {
        effectivePrompt = [...prefixBlocks, ...prompt];
      }

      const res = await requestAgent(conn, acp.methods.agent.session.prompt, sdkRequest(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: effectivePrompt,
      }));
      return res;
    } finally {
      try {
        if (opts?.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);
      } catch (err) {
        console.error(`[UniversalACP:${this.profile.id}] abort listener cleanup failed: ${(err as Error).message}`);
      }
      this.promptLocks.delete(sessionId);
      await new Promise((r) => setTimeout(r, 50));
      unsub();
    }
  }

  private requestMeta(value: unknown): Record<string, unknown> {
    if (value == null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw acp.RequestError.invalidParams(undefined, "Invalid ACP _meta");
    return Object.fromEntries(Object.entries(value));
  }

}
