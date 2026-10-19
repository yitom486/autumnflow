import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentProfile, AgentStatus } from "./types";
import { BUILTIN_AGENTS, loadExtraProfilesFromEnv, resolveBuiltin, parseProfilesJson } from "./presets";
import { UniversalAgentConnection } from "./AgentConnection";
import { resolveAppHome } from "./app-paths";

/** User custom profiles live here (override with ACP_AGENTS_FILE). */
export function customAgentsFile(): string {
  return process.env.ACP_AGENTS_FILE || path.join(resolveAppHome(), "agents.json");
}

function loadCustomProfilesFromFile(): AgentProfile[] {
  try {
    const file = customAgentsFile();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return parseProfilesJson(raw);
  } catch (err) {
    // Loud empty: 配置损坏必须可见 (no-silent-fallbacks)。返回 [] 保活网关，
    // 但 warn 带上文件路径 + 原因，调用方 (status/connect) 可继续展示。
    console.warn(`[registry] 自定义 agents 文件解析失败，已按空配置继续: ${customAgentsFile()}:`, err);
    return [];
  }
}

/**
 * Registry of agent profiles + live stdio connections.
 * One connection per agent id (shared across sessions, like Zed).
 * Sources (later wins): builtins → ACP_AGENTS_JSON env → ~/.autumnflow/agents.json.
 */
export class UniversalRegistry {
  private profiles = new Map<string, AgentProfile>();
  private conns = new Map<string, UniversalAgentConnection>();

  constructor() {
    for (const p of BUILTIN_AGENTS) this.profiles.set(p.id, { ...p });
    for (const p of loadExtraProfilesFromEnv()) this.profiles.set(p.id, p);
    for (const p of loadCustomProfilesFromFile()) this.profiles.set(p.id, { ...p, builtin: false });
    // 启动时预热连接实例，让各智能体的本地凭证与配额探针（如 @yitom/acp-client 的 probeCodexQuota）立即异步预热
    for (const p of this.profiles.values()) {
      try {
        this.connFor(p.id);
      } catch {}
    }
  }

  /** Re-read env + file customs (tests / external edits). Drops in-memory customs. */
  reloadCustomProfiles(): void {
    for (const [id, p] of this.profiles) {
      if (!p.builtin) this.profiles.delete(id);
    }
    for (const p of loadExtraProfilesFromEnv()) this.profiles.set(p.id, p);
    for (const p of loadCustomProfilesFromFile()) this.profiles.set(p.id, { ...p, builtin: false });
  }

  listProfiles(): AgentProfile[] {
    return [...this.profiles.values()].map((p) => ({ ...p, env: undefined, args: p.args }));
  }

  /** full profile incl. env for internal use only */
  getProfile(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  private saveCustomProfiles(): void {
    try {
      const customs = [...this.profiles.values()].filter((p) => !p.builtin);
      const file = customAgentsFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(customs, null, 2));
    } catch (err) {
      // persistence is best-effort; in-memory registry keeps working.
      // 可预期写失败 (只读 HOME/配额) 允许忽略，但必须留痕 (error_handling.md)。
      console.warn(`[registry] 自定义 agents 持久化失败 (内存注册表继续工作): ${customAgentsFile()}:`, err);
    }
  }

  upsertProfile(p: AgentProfile): AgentProfile {
    if (!p.id || !p.command) throw new Error("profile id + command required");
    const prev = this.profiles.get(p.id);
    const merged: AgentProfile = {
      id: p.id,
      name: p.name || p.id,
      title: p.title || p.id,
      description: p.description ?? prev?.description,
      homepage: p.homepage ?? prev?.homepage,
      command: p.command,
      args: p.args || [],
      env: p.env || {},
      defaultCwd: p.defaultCwd ?? prev?.defaultCwd,
      authHint: p.authHint ?? prev?.authHint,
      installHint: p.installHint ?? prev?.installHint,
      builtin: prev?.builtin ?? false,
    };
    this.profiles.set(p.id, merged);
    // Drop a stale connection so the next connect() picks up the new profile.
    const c = this.conns.get(p.id);
    if (c) {
      // 可预期清理失败 (连接已死/已关) 允许忽略，但留 debug 痕迹。
      void c.disconnect().catch((err) => console.debug(`[registry] upsert 清理旧连接 ${p.id} 失败 (忽略):`, err));
      this.conns.delete(p.id);
    }
    this.saveCustomProfiles();
    return merged;
  }

  removeProfile(id: string): boolean {
    const p = this.profiles.get(id);
    if (!p || p.builtin) return false;
    this.profiles.delete(id);
    const c = this.conns.get(id);
    if (c) {
      // 同上: 可预期清理失败，debug 留痕后忽略。
      void c.disconnect().catch((err) => console.debug(`[registry] remove 清理旧连接 ${id} 失败 (忽略):`, err));
      this.conns.delete(id);
    }
    this.saveCustomProfiles();
    return true;
  }

  connFor(id: string): UniversalAgentConnection {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error(`Unknown agent '${id}'. Available: ${[...this.profiles.keys()].join(", ")}`);
    // Re-resolve builtin base each time (handles bun/npx path drift),
    // but user customizations of the same id always win.
    const freshBuiltin = resolveBuiltin(id);
    const effective: AgentProfile = freshBuiltin
      ? { ...freshBuiltin, ...profile, env: { ...(freshBuiltin.env || {}), ...(profile.env || {}) } }
      : profile;
    let c = this.conns.get(id);
    if (!c || c.profile.id !== id) {
      c = new UniversalAgentConnection(effective);
      this.conns.set(id, c);
    } else {
      // keep custom env overrides live
      (c as unknown as { profile: AgentProfile }).profile = effective;
    }
    return c;
  }

  /** Live connections only; used by the native quit/update active-work guard. */
  listConnections(): UniversalAgentConnection[] {
    return [...this.conns.values()];
  }

  statuses(): AgentStatus[] {
    return [...this.profiles.keys()].map((id) => {
      const c = this.conns.get(id);
      if (!c) return { id, connected: false, pid: null, protocolVersion: null, agentInfo: null, agentCapabilities: null, authMethods: null, authStatus: null, meta: null, lastError: null, startedAt: null };
      return c.status() as AgentStatus;
    });
  }

  async shutdown(): Promise<void> {
    for (const c of this.conns.values()) {
      // 可预期清理失败 (进程已退/管道已关) 允许忽略，但留 debug 痕迹。
      await c.disconnect().catch((err) => console.debug(`[registry] shutdown 清理连接失败 (忽略):`, err));
    }
    this.conns.clear();
  }
}

export const universalRegistry = new UniversalRegistry();
