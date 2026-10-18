import * as fs from "node:fs";
import * as path from "node:path";
import { getStudioResourcesDir } from "./studio-resource-path";
import { resolveRuntimeConfig } from "../../shared/runtime-config";

export interface StudioSession {
  agentId: string;
  sessionId: string;
  kind: "main" | "subagent";
  origin: "created" | "imported" | "subagent";
  parentSessionId?: string;
  cwd?: string;
  title?: string;
  updatedAt: string;
}

/** Durable references only. Native agent transcripts remain in the agent's storage. */
export class SessionIndex {
  constructor(private file: () => string) {}
  private read(): StudioSession[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.file(), "utf8"));
      if (value.version !== 1 || !Array.isArray(value.sessions)) throw new Error("Unsupported session index format");
      return value.sessions;
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  private save(sessions: StudioSession[]) {
    const file = this.file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessions }, null, 2), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); break; }
      catch (error: any) {
        // Windows scanners can briefly hold either file during an atomic replace.
        // Retry the same operation; never truncate or delete the previous index.
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
        console.warn(`[StudioHistory] 索引文件暂被占用，重试保存 (${attempt + 1}/5): ${file}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  }
  list(agentId: string): StudioSession[] {
    return this.read().filter(row => row.agentId === agentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(agentId: string, sessionId: string) {
    return this.list(agentId).find(row => row.sessionId === sessionId);
  }
  remember(agentId: string, sessionId: string, origin: "created" | "imported", metadata: { cwd?: string; title?: string } = {}) {
    if (!sessionId) throw new Error("sessionId is required");
    const rows = this.read();
    const row = rows.find(row => row.agentId === agentId && row.sessionId === sessionId);
    // Opening a child must never promote it into the main conversation list.
    if (row?.kind === "subagent") return;
    const next: StudioSession = { agentId, sessionId, kind: "main", origin: row?.origin ?? origin,
      updatedAt: new Date().toISOString(), ...row, ...metadata };
    if (row) rows[rows.indexOf(row)] = next; else rows.push(next);
    this.save(rows);
  }
  linkChild(agentId: string, parentSessionId: string, sessionId: string, title?: string) {
    if (!parentSessionId || !sessionId || parentSessionId === sessionId) throw new Error("Invalid child session association");
    const rows = this.read();
    const existing = rows.find(row => row.agentId === agentId && row.sessionId === sessionId);
    if (existing?.parentSessionId && existing.parentSessionId !== parentSessionId) throw new Error("Child session ownership cannot change");
    const seen = new Set([sessionId]);
    let parent: string | undefined = parentSessionId;
    while (parent) {
      if (seen.has(parent)) throw new Error("Cyclic child session association");
      seen.add(parent);
      parent = rows.find(row => row.agentId === agentId && row.sessionId === parent)?.parentSessionId;
    }
    const next: StudioSession = { agentId, sessionId, origin: "subagent", kind: "subagent", parentSessionId,
      cwd: rows.find(row => row.agentId === agentId && row.sessionId === parentSessionId)?.cwd,
      updatedAt: new Date().toISOString(), ...(existing || {}), ...(title ? { title } : {}) };
    if (existing && existing.kind === "subagent" && existing.title === next.title) return;
    // Explicit subagent evidence overrides an old main-session classification.
    next.kind = "subagent"; next.origin = "subagent"; next.parentSessionId = parentSessionId;
    if (existing) rows[rows.indexOf(existing)] = next; else rows.push(next);
    this.save(rows);
  }
  update(agentId: string, sessionId: string, metadata: { title?: string; updatedAt?: string }) {
    const rows = this.read();
    const row = rows.find(row => row.agentId === agentId && row.sessionId === sessionId);
    if (!row) return;
    Object.assign(row, metadata);
    this.save(rows);
  }
  /**
   * Batch variant for session/list pages: one read + one atomic save, and only
   * rows already referenced by this app are updated (never auto-imports).
   */
  updateMany(
    agentId: string,
    updates: Array<{ sessionId: string; title?: string; updatedAt?: string; cwd?: string }>,
  ) {
    if (updates.length === 0) return;
    const rows = this.read();
    const byId = new Map(rows.filter(row => row.agentId === agentId).map(row => [row.sessionId, row]));
    let changed = false;
    for (const update of updates) {
      const row = byId.get(update.sessionId);
      if (!row) continue;
      if (typeof update.title === "string" && update.title.trim()) {
        const title = update.title.trim();
        if (row.title !== title) {
          row.title = title;
          changed = true;
        }
      }
      if (typeof update.updatedAt === "string" && update.updatedAt) {
        if (row.updatedAt !== update.updatedAt) {
          row.updatedAt = update.updatedAt;
          changed = true;
        }
      }
      if (typeof update.cwd === "string" && update.cwd && row.cwd !== update.cwd) {
        row.cwd = update.cwd;
        changed = true;
      }
    }
    if (changed) this.save(rows);
  }
  children(agentId: string, sessionId: string): StudioSession[] {
    const rows = this.list(agentId);
    const parents = new Set([sessionId]);
    const result: StudioSession[] = [];
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) {
        if (row.parentSessionId && parents.has(row.parentSessionId) && !parents.has(row.sessionId)) {
          parents.add(row.sessionId); result.push(row); changed = true;
        }
      }
    }
    return result;
  }
  forget(agentId: string, sessionId: string) {
    const ids = new Set([sessionId, ...this.children(agentId, sessionId).map(row => row.sessionId)]);
    this.save(this.read().filter(row => row.agentId !== agentId || !ids.has(row.sessionId)));
  }
}

export const studioSessions = new SessionIndex(() => process.env.ACP_SESSION_INDEX_FILE ||
  path.join(getStudioResourcesDir(), "history", `${resolveRuntimeConfig().mode}.json`));

/** parentID alone can also mean a user-created fork; only explicit delegation is evidence. */
export function childAssociation(parentSessionId: string, update: Record<string, any>) {
  const child = update._meta?.["opencode/child-session"];
  if (typeof child?.id === "string" && typeof child?.parentID === "string") {
    return { sessionId: child.id, parentSessionId: child.parentID, title: typeof child.title === "string" ? child.title : undefined };
  }
  if (update.sessionUpdate === "subagent_update" && typeof update.sessionId === "string") {
    return { sessionId: update.sessionId, parentSessionId, title: typeof update.title === "string" ? update.title : undefined };
  }
  return null;
}
