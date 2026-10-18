/**
 * Session RPCs and the session metadata that goes with them.
 *
 * ACP sessions are the unit a long-lived host opens, resumes, forks and closes
 * for days, so their bookkeeping (which agent session ids are known, which ones
 * are subagents of which parent, what each session cost in memory) lives here
 * rather than in the transport or the prompt path.
 *
 * The connection keeps the public surface and forwards; state reclamation has
 * exactly one owner: `releaseSessionState`.
 */
import * as acp from "@agentclientprotocol/sdk";
import { requestAgent, requireAgentCapability, sdkRequest, sdkValue } from "./acp-sdk";
import type { AgentProfile } from "./types";
import type { FsGuard } from "./fs-guard";
import type { SessionState } from "./session-state";
import type { StudioAgentResources } from "./studio-agent-resources";
import { getMcpUiServerInfo } from "./mcp-ui-server";
import { childAssociation, studioSessions } from "./session-index";

export interface SessionServiceDeps {
  /** Re-resolved on use: the registry swaps the profile to keep env overrides live. */
  profile: () => AgentProfile;
  ensureConnection: () => acp.ClientConnection;
  init: () => acp.InitializeResponse | null;
  state: SessionState;
  resources: StudioAgentResources;
  fsGuard: FsGuard;
  /** Live SSE subscription, so session/load and child replay can collect updates. */
  subscribe: (sessionId: string, send: (evt: Record<string, unknown>) => void) => () => void;
}

export class SessionService {
  /** Short-lived first-page session/list cache: the sidebar polls every 5s. */
  private listedSessionsCache: { at: number; result: unknown } | null = null;

  constructor(private readonly deps: SessionServiceDeps) {}

  private get agentId(): string {
    return this.deps.profile().id;
  }

  private get defaultCwd(): string | undefined {
    return this.deps.profile().defaultCwd;
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
    const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : (this.defaultCwd || process.cwd());
    const additionalDirectories = Array.isArray(args.additionalDirectories) ? args.additionalDirectories.map(directory => {
      if (typeof directory !== "string") throw acp.RequestError.invalidParams(undefined, "Additional directory must be a path string");
      return directory;
    }) : [];
    if (additionalDirectories.length) requireAgentCapability("session.additionalDirectories", this.deps.init()?.agentCapabilities?.sessionCapabilities?.additionalDirectories);
    const roots = this.deps.fsGuard.sessionRootsFor(cwd, additionalDirectories);
    const mcpServers = Array.isArray(args.mcpServers) ? args.mcpServers.map(server => sdkValue<acp.McpServer>("McpServer", server)) : [];
    for (const configured of this.deps.resources.configuredMcpServers()) {
      const server = sdkValue<acp.McpServer>("McpServer", configured);
      if (!mcpServers.some(existing => existing.name === server.name)) mcpServers.push(server);
    }
    const mcpInfo = getMcpUiServerInfo();
    const agentCaps = this.deps.init()?.agentCapabilities?.mcpCapabilities;
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
    return { cwd, mcpServers, additionalDirectories, roots, resourceMeta: this.deps.resources.sessionMeta() };
  }

  async newSession(args: { cwd?: string; mcpServers?: unknown[]; additionalDirectories?: string[] }): Promise<unknown> {
    const conn = this.deps.ensureConnection();
    const { cwd, mcpServers, additionalDirectories, roots, resourceMeta } = this.enrichSessionPayload(args);
    const result = await requestAgent(conn, acp.methods.agent.session.new, {
      cwd,
      mcpServers,
      ...(resourceMeta ? { _meta: resourceMeta } : {}),
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
    });
    const newSid = result.sessionId;
    if (typeof newSid === "string") {
      studioSessions.remember(this.agentId, newSid, "created", { cwd });
      this.deps.state.turnCounts.set(newSid, 0);
      this.deps.resources.rememberSession(newSid, result);
    }
    this.deps.fsGuard.rememberSessionRoots(newSid, roots);
    return result;
  }

  async loadSession(args: Record<string, unknown>): Promise<{ result: unknown; replayed: unknown[] }> {
    const conn = this.deps.ensureConnection();
    requireAgentCapability("loadSession", this.deps.init()?.agentCapabilities?.loadSession);
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
    const unsub = sessionId ? this.deps.subscribe(sessionId, (evt) => {
      if ((evt as { type?: string }).type === "update") replayed.push((evt as { update?: unknown }).update);
    }) : () => undefined;
    try {
      const result = await requestAgent(conn, acp.methods.agent.session.load, sdkRequest(acp.methods.agent.session.load, payload));
      if (sessionId) {
        this.deps.state.turnCounts.set(sessionId, 0);
        this.deps.resources.rememberSession(sessionId, result);
      }
      this.deps.fsGuard.rememberSessionRoots(sessionId, roots);
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
        studioSessions.update(this.agentId, sessionId, { title: titleUpdate.title });
      }
      return { result, replayed };
    } finally {
      unsub();
    }
  }

  /** UNSTABLE session/fork (advertised via sessionCapabilities.fork, e.g. codex). */
  async forkSession(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.deps.ensureConnection();
    requireAgentCapability("session.fork", this.deps.init()?.agentCapabilities?.sessionCapabilities?.fork);
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
      studioSessions.remember(this.agentId, newSid, "created", { cwd });
      this.deps.state.turnCounts.set(newSid, 0);
      this.deps.resources.rememberSession(newSid, result);
    }
    this.deps.fsGuard.rememberSessionRoots(newSid, roots);
    return result;
  }

  async resumeSession(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.deps.ensureConnection();
    requireAgentCapability("session.resume", this.deps.init()?.agentCapabilities?.sessionCapabilities?.resume);
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
      this.deps.state.turnCounts.set(sid, 0);
      this.deps.resources.rememberSession(sid, result);
    }
    this.deps.fsGuard.rememberSessionRoots(sid, roots);
    return result;
  }

  async listSessions(args: Record<string, unknown> = {}): Promise<unknown> {
    const conn = this.deps.ensureConnection();
    requireAgentCapability("session.list", this.deps.init()?.agentCapabilities?.sessionCapabilities?.list);
    const firstPage = !args.cursor;
    if (firstPage && this.listedSessionsCache && Date.now() - this.listedSessionsCache.at < 15_000) {
      return this.listedSessionsCache.result;
    }
    const result = await requestAgent(conn, acp.methods.agent.session.list, sdkRequest(acp.methods.agent.session.list, args));
    const rows = Array.isArray(result.sessions) ? result.sessions : [];
    // Pull Agent-provided titles/timestamps into the app's own reference rows.
    // Only existing rows are touched, so opening the sidebar never imports
    // unrelated sessions from the agent's store.
    const known = new Set(studioSessions.list(this.agentId).map(row => row.sessionId));
    studioSessions.updateMany(
      this.agentId,
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
        studioSessions.linkChild(this.agentId, association.parentSessionId, association.sessionId, association.title);
        this.deps.state.childParents.set(association.sessionId, association.parentSessionId);
      }
    }
    if (firstPage) this.listedSessionsCache = { at: Date.now(), result };
    return result;
  }

  /** Child inspection never binds the UI, resumes, prompts or changes its configuration. */
  async viewChild(sessionId: string): Promise<{ replayed: unknown[]; source: "live" | "agent" }> {
    const record = studioSessions.get(this.agentId, sessionId);
    if (record?.kind !== "subagent") throw new Error("该会话不是已识别的子智能体会话");
    const live = this.deps.state.childUpdates.get(sessionId);
    if (live?.length) return { replayed: [...live], source: "live" };
    if (!this.deps.init()?.agentCapabilities?.loadSession) throw new Error("该 Agent 未提供子会话历史回放，当前也没有可查看的运行记录。");
    this.deps.state.childParents.set(sessionId, record.parentSessionId!);
    const replayed: unknown[] = [];
    const unsubscribe = this.deps.subscribe(sessionId, event => {
      if (event.type === "update") replayed.push(event.update);
    });
    try {
      await this.deps.ensureConnection().agent.request(acp.methods.agent.session.load, {
        sessionId, cwd: record.cwd || process.cwd(), mcpServers: [],
      });
      return { replayed, source: "agent" };
    } finally { unsubscribe(); }
  }

  async deleteSession(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.deps.ensureConnection();
    const sid = typeof args.sessionId === "string" ? args.sessionId : "";
    this.listedSessionsCache = null;
    if (sid) this.releaseSessionState(sid);
    requireAgentCapability("session.delete", this.deps.init()?.agentCapabilities?.sessionCapabilities?.delete);
    const result = await requestAgent(conn, acp.methods.agent.session.delete, sdkRequest(acp.methods.agent.session.delete, args));
    studioSessions.forget(this.agentId, sid);
    this.deps.resources.forgetSession(sid);
    return result;
  }

  async closeSession(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.deps.ensureConnection();
    const sid = typeof args.sessionId === "string" ? args.sessionId : "";
    this.listedSessionsCache = null;
    if (sid) this.releaseSessionState(sid);
    const caps = this.deps.init()?.agentCapabilities;
    if (!caps?.sessionCapabilities?.close) {
      // Best-effort: local sinks and caches are already reclaimed above.
      this.deps.resources.forgetSession(sid);
      return {};
    }
    const result = await requestAgent(conn, acp.methods.agent.session.close, sdkRequest(acp.methods.agent.session.close, args));
    this.deps.resources.forgetSession(sid);
    return result;
  }

  /**
   * Reclaim per-session memory when a session is closed or deleted. Subagent
   * sessions are reclaimed with their parent: they are only reachable through
   * the parent transcript, and their update buffers are the largest entries.
   */
  private releaseSessionState(sessionId: string): void {
    if (!sessionId) return;
    this.deps.state.drop(sessionId);
    for (const child of studioSessions.children(this.agentId, sessionId)) {
      this.deps.state.drop(child.sessionId);
    }
  }

  async setMode(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.deps.ensureConnection();
    return requestAgent(conn, acp.methods.agent.session.setMode, sdkRequest(acp.methods.agent.session.setMode, args));
  }

  async setConfigOption(args: Record<string, unknown>): Promise<unknown> {
    const conn = this.deps.ensureConnection();
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

  private requestMeta(value: unknown): Record<string, unknown> {
    if (value == null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw acp.RequestError.invalidParams(undefined, "Invalid ACP _meta");
    return Object.fromEntries(Object.entries(value));
  }
}
