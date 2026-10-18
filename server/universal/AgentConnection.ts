import * as fs from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
import { requestAgent, sdkRequest, sdkValue, requireAgentCapability } from "./acp-sdk";
import { applyArtifactUpdate } from "../../shared/acp-session-state";
import { TerminalAuthentication } from "./terminal-auth";
import { AcpTransport, type AcpClientHandlers } from "./acp-transport";
import { isCodexProfile, provisionCodexCodeModeHome } from "./codex-code-mode-home";
import { SessionService } from "./session-service";
import {
  QuotaCache,
  type AcpAgentQuota,
  AcpTerminalManager,
  codexAdapter,
  agyAdapter,
  claudeAdapter,
  opencodeAdapter,
  cursorAdapter,
  deepseekAdapter,
} from "@yitom/acp-client";
import type { AgentProfile, PendingElicitation, PendingPermission } from "./types";
import {
  findHeadlessLauncher,
  isRuntimeBinary,
  RUNTIME_BASENAMES,
  whichCommand,
} from "./platform/spawn";
import { InteractionManager } from "./interaction";
import { FsGuard } from "./fs-guard";
import { PromptTurn } from "./prompt-turn";
import { SessionState } from "./session-state";
import { probeLiveAgyQuota } from "./runtimes/agy-quota";
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
 * One long-lived ACP connection: the facade that ties transport to semantics.
 *
 * `AcpTransport` owns the process, NDJSON stream, initialize handshake and
 * teardown; `SessionService` owns session RPCs and their bookkeeping;
 * `PromptTurn` owns the prompt lease and cancellation. This class decides what
 * the remaining protocol events *mean* (permissions, filesystem guards,
 * terminals, subagents, quota, broadcasting) and forwards the rest.
 */
export class UniversalAgentConnection {
  readonly profile: AgentProfile;
  /** Process, stream and handshake live here; this class owns the semantics. */
  private transport: AcpTransport;
  /** Session RPCs and their bookkeeping; the only owner of session reclamation. */
  private sessions: SessionService;
  /** Prompt turns: lease, cancel-on-abort, first-turn compatibility blocks. */
  private turns: PromptTurn;
  /** Per-session memory with one reclamation point (close / delete / exit). */
  private state = new SessionState();

  private interaction: InteractionManager;
  private fsGuard: FsGuard;
  private terminals = new AcpTerminalManager();

  private quotaCache = new QuotaCache();
  private lastQuota: AcpAgentQuota | null = null;
  private resources = new StudioAgentResources(CLIENT_GENERATIVE_UI_HINT);
  private terminalAuth: TerminalAuthentication;

  constructor(profile: AgentProfile) {
    this.profile = profile;
    this.transport = new AcpTransport(() => this.profile, {
      prepareEnv: async ({ cwd, resolvedCommand, env }) => {
        const prepared = await this.resources.prepare(profile.id, cwd, resolvedCommand, env);
        if (!isCodexProfile(profile) || profile.env?.CODEX_HOME?.trim()) return prepared;
        // Codex runs against an app-owned CODEX_HOME seeded from the user's
        // home (auth + config, copied once), so `features.code_mode` is on
        // without writing ~/.codex. Any failure falls back to the user's home.
        try {
          const home = await provisionCodexCodeModeHome();
          for (const warning of home.warnings) {
            console.warn(`[UniversalACP:${profile.id}] codex home: ${warning}`);
          }
          return { ...(prepared ?? {}), CODEX_HOME: home.home };
        } catch (error) {
          console.warn(
            `[UniversalACP:${profile.id}] code-mode home unavailable; using the user's Codex home`,
            error,
          );
          return prepared;
        }
      },
      terminalAuthAvailable: (resolvedCommand) => this.terminalAuth.available(resolvedCommand),
      onInitialized: (init) => {
        this.resources.handshake(init.agentInfo?.version || "");
        void this.probeQuotaBackground();
      },
      onExit: (code, signal) => {
        // Fail pending permission/elicitation and drop prompt leases so a dead
        // process cannot pin a session in 409 forever.
        this.interaction.rejectAllOnExit(code, signal);
        this.turns.reset();
        this.terminals.releaseAll();
      },
    });
    this.terminalAuth = new TerminalAuthentication(profile);
    this.interaction = new InteractionManager(profile.id, (sid, evt) => this.broadcast(sid, evt));
    this.fsGuard = new FsGuard(profile.id, (sid, kind, detail) => this.emitActivity(sid, kind, detail));
    this.sessions = new SessionService({
      profile: () => this.profile,
      ensureConnection: () => this.ensureConn(),
      init: () => this.initResult,
      state: this.state,
      resources: this.resources,
      fsGuard: this.fsGuard,
      subscribe: (sessionId, send) => this.subscribe(sessionId, send),
    });
    this.turns = new PromptTurn({
      agentId: () => this.profile.id,
      ensureConnection: () => this.ensureConn(),
      init: () => this.initResult,
      state: this.state,
      subscribe: (sessionId, send) => this.subscribe(sessionId, send),
      resources: this.resources,
      onCancelPending: (sessionId) => this.interaction.cancelPendingForSession(sessionId),
    });
    // Initial best-effort probe based on profile
    this.probeQuotaBackground();
  }

  /** Transport views, kept private so call sites read like connection state. */
  private get conn(): acp.ClientConnection | null {
    return this.transport.connectionOrNull();
  }

  private get initResult(): acp.InitializeResponse | null {
    return this.transport.init;
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
      } else if (id === "deepseek") {
        // DSH's ACP surface has no account/quota channel; the adapter probes the
        // official /user/balance endpoint with DEEPSEEK_API_KEY (no rate windows).
        q = (await deepseekAdapter.probeQuota?.()) ?? null;
        if (q) q.runtimeId = "deepseek";
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
    return this.transport.connected;
  }

  get pid(): number | null {
    return this.transport.pid;
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
      lastError: this.transport.lastError,
      startedAt: this.transport.startedAt,
    };
  }

  getInitResult(): acp.InitializeResponse | null {
    return this.initResult;
  }

  subscribe(sessionId: string, send: SseSend): () => void {
    let set = this.state.sinks.get(sessionId);
    if (!set) {
      set = new Set();
      this.state.sinks.set(sessionId, set);
    }
    set.add(send);
    return () => {
      set!.delete(send);
      if (set!.size === 0) this.state.sinks.delete(sessionId);
    };
  }

  /** Cached commands for a session (undefined = agent never sent any). */
  getAvailableCommands(sessionId: string): unknown[] | undefined {
    return this.state.commands.get(sessionId);
  }

  /** Wait briefly for a trailing available_commands_update after a session RPC. */
  async awaitAvailableCommands(sessionId: string, maxMs = 150): Promise<unknown[] | undefined> {
    for (let t = 0; t < maxMs && !this.state.commands.has(sessionId); t += 25) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.state.commands.get(sessionId);
  }

  private broadcast(sessionId: string, evt: Record<string, unknown>) {
    if (!sessionId || sessionId === "*") {
      for (const set of this.state.sinks.values()) {
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
    const set = this.state.sinks.get(sessionId);
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
    const subagents = [...this.state.childStates.entries()]
      .map(([sessionId, state]) => ({
        sessionId,
        title: String((state as any)?.title || (state as any)?.name || ""),
        status: String((state as any)?.status || ""),
      }))
      .filter((subagent) => !subagent.status || /running|pending|started|in_progress/i.test(subagent.status));
    return {
      agentId: this.profile.id,
      runningSessions: this.turns.busySessions(),
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
    // A new agent process knows nothing about the previous one's sessions, so
    // drop the per-session view before (re)spawning; a failed handshake also
    // has to release the resource snapshot, which lives here, not in transport.
    if (!this.connected) {
      this.state.clear();
      this.turns.reset();
    }
    try {
      return await this.transport.connect(this.clientHandlers());
    } catch (err) {
      await this.disconnect().catch(() => undefined);
      throw err;
    }
  }

  /** The ACP client surface: protocol events mapped onto connection semantics. */
  private clientHandlers(): AcpClientHandlers {
    return {
      requestPermission: (params, signal) => this.interaction.handlePermissionRequest(params, signal),
      readTextFile: (params) => this.fsGuard.handleReadFile(params),
      writeTextFile: (params) => this.fsGuard.handleWriteFile(params),
      createTerminal: (params) => this.handleTerminalCreate(params),
      terminalOutput: (params) => {
        this.requireTerminalOwner(params);
        return this.terminals.getOutput(params.terminalId);
      },
      terminalRelease: (params) => {
        this.requireTerminalOwner(params);
        this.state.releasedTerminals.set(params.terminalId, {
          sessionId: params.sessionId,
          output: this.terminals.getOutput(params.terminalId),
        });
        this.state.terminalOwners.delete(params.terminalId);
        this.emitActivity(params.sessionId || "", "terminal_release", { terminalId: params.terminalId });
        return this.terminals.release(params.terminalId);
      },
      terminalWaitForExit: (params) => {
        this.requireTerminalOwner(params);
        return this.terminals.waitForExit(params.terminalId);
      },
      terminalKill: (params) => {
        this.requireTerminalOwner(params);
        this.emitActivity(params.sessionId || "", "terminal_kill", { terminalId: params.terminalId });
        return this.terminals.kill(params.terminalId);
      },
      createElicitation: (params, signal) => this.interaction.handleElicitation(params, signal),
      sessionUpdate: (params) => this.handleSessionUpdate(params),
      elicitationComplete: (params) => this.interaction.completeElicitation(params),
    };
  }

  /**
   * session/update arrives through the transport but only means something to a
   * session: child linkage, title/command caches, quota observation, broadcast.
   */
  private handleSessionUpdate(params: acp.SessionNotification): void {
    if (params.update.sessionUpdate === "subagent_update") {
      const previous = this.state.childStates.get(params.update.sessionId);
      const entries = applyArtifactUpdate(previous ? [{ kind: "subagent", value: previous }] : [], params.update);
      const state = entries[0];
      if (state?.kind === "subagent") this.state.childStates.set(state.value.sessionId, state.value);
    }
    const association = childAssociation(params.sessionId, params.update);
    if (association) {
      studioSessions.linkChild(this.profile.id, association.parentSessionId, association.sessionId, association.title);
      this.state.childParents.set(association.sessionId, association.parentSessionId);
      this.fsGuard.rememberSessionRoots(association.sessionId, this.fsGuard.allowedRootsFor(association.parentSessionId));
    }
    const childId = association?.sessionId || (this.state.childParents.has(params.sessionId) ? params.sessionId : null);
    if (childId && params.update.sessionUpdate !== "subagent_update") {
      const updates = this.state.childUpdates.get(childId) || [];
      updates.push(params.update);
      if (updates.length > 200) updates.shift();
      this.state.childUpdates.set(childId, updates);
      // Keep child output out of the main transcript. A read-only replay subscriber
      // still receives it on the child's own ID.
      this.broadcast(childId, { type: "update", sessionId: childId, update: params.update });

      // Inform parent session sink that child session is actively working
      const parentSessionId = this.state.childParents.get(childId);
      if (parentSessionId) {
        const childTitle = studioSessions.get(this.profile.id, childId)?.title || "子智能体";
        this.emitActivity(parentSessionId, "subagent_active", {
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
          this.broadcast(parentSessionId, {
            type: "update",
            agentId: this.profile.id,
            sessionId: parentSessionId,
            update: {
              ...u,
              title: prefixedTitle,
            },
          });
        } else if (updateType === "agent_thought_chunk") {
          this.broadcast(parentSessionId, {
            type: "update",
            agentId: this.profile.id,
            sessionId: parentSessionId,
            update: params.update,
          });
        }
      }
      return;
    }
    if (params.update.sessionUpdate === "session_info_update") {
      const title = params.update.title;
      if (typeof title === "string") studioSessions.update(this.profile.id, params.sessionId, { title, updatedAt: new Date().toISOString() });
    }
    if (params.update?.sessionUpdate === "available_commands_update" && params.sessionId) {
      const list = (params.update as { availableCommands?: unknown }).availableCommands;
      this.state.commands.set(params.sessionId, Array.isArray(list) ? list : []);
    }
    const observed = this.quotaCache.observe(params, this.profile.id);
    if (observed) {
      this.lastQuota = observed;
    }
    this.broadcast(params.sessionId, {
      type: "update",
      agentId: this.profile.id,
      sessionId: params.sessionId,
      update: params.update,
      quota: this.lastQuota,
    });
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
    this.state.terminalOwners.set(terminal.terminalId, sessionId);
    return Promise.resolve(terminal);
  }

  private requireTerminalOwner(params: acp.TerminalOutputRequest): void {
    if (this.state.terminalOwners.get(params.terminalId) !== params.sessionId) throw acp.RequestError.invalidParams(undefined, "Unknown terminal in this session");
  }

  terminalDisplayOutput(params: acp.TerminalOutputRequest): acp.TerminalOutputResponse {
    const released = this.state.releasedTerminals.get(params.terminalId);
    if (released?.sessionId === params.sessionId) return released.output;
    this.requireTerminalOwner(params);
    return this.terminals.getOutput(params.terminalId);
  }

  async disconnect(): Promise<void> {
    this.terminalAuth.dispose();
    this.interaction.rejectAllOnExit(null, null);
    this.state.clear();
    this.turns.reset();
    this.terminals.releaseAll();
    const gone = await this.transport.stop();
    // Never remove a resource snapshot that a live bridge may still be reading.
    if (gone) {
      await this.resources.dispose();
    } else {
      throw new Error("Agent process did not exit; application resource snapshot retained for cleanup");
    }
  }

  private ensureConn(): acp.ClientConnection {
    return this.transport.ensureConnection();
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

  // ---- session RPCs ----
  // All session bookkeeping lives in SessionService; these forwards keep the
  // connection's public surface (and every route) unchanged.
  async newSession(args: {
    cwd?: string;
    mcpServers?: unknown[];
    additionalDirectories?: string[];
    codeMode?: unknown;
    _meta?: unknown;
  }): Promise<unknown> {
    return this.sessions.newSession(args);
  }

  async loadSession(args: Record<string, unknown>): Promise<{ result: unknown; replayed: unknown[] }> {
    return this.sessions.loadSession(args);
  }

  async forkSession(args: Record<string, unknown>): Promise<unknown> {
    return this.sessions.forkSession(args);
  }

  async resumeSession(args: Record<string, unknown>): Promise<unknown> {
    return this.sessions.resumeSession(args);
  }

  async listSessions(args: Record<string, unknown> = {}): Promise<unknown> {
    return this.sessions.listSessions(args);
  }

  async viewChild(sessionId: string): Promise<{ replayed: unknown[]; source: "live" | "agent" }> {
    return this.sessions.viewChild(sessionId);
  }

  async deleteSession(args: Record<string, unknown>): Promise<unknown> {
    return this.sessions.deleteSession(args);
  }

  async closeSession(args: Record<string, unknown>): Promise<unknown> {
    return this.sessions.closeSession(args);
  }

  async setMode(args: Record<string, unknown>): Promise<unknown> {
    return this.sessions.setMode(args);
  }

  async setConfigOption(args: Record<string, unknown>): Promise<unknown> {
    return this.sessions.setConfigOption(args);
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






  // ---- prompt turns ----
  async cancel(sessionId: string): Promise<void> {
    return this.turns.cancel(sessionId);
  }

  canCancelSession(sessionId: string): boolean {
    return this.turns.canCancel(sessionId);
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
    return this.turns.prompt(sessionId, prompt, onEvent, opts);
  }


}
