import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import { dangerousRootReason, getWorkspaceRoots, isPathAllowed } from "./security";

export type ActivityEmitter = (sessionId: string, kind: string, detail?: unknown) => void;

/**
 * Enforces file system boundaries for agent requests:
 * - Always blocks system roots (/etc, C:\Windows, Program Files, etc.)
 * - Confines write operations to session roots + workspace roots
 * - Reads files with line/limit slicing
 * - Writes files with recursive directory creation
 */
export class FsGuard {
  private readonly agentId: string;
  private readonly emitActivity: ActivityEmitter;
  private sessionRoots = new Map<string, string[]>();

  constructor(agentId: string, emitActivity: ActivityEmitter) {
    this.agentId = agentId;
    this.emitActivity = emitActivity;
  }

  /** 校验并整理会话根（cwd + additionalDirectories），拒绝文件系统根 / 系统目录。 */
  sessionRootsFor(cwd: string, extra: unknown): string[] {
    const dirs = [cwd, ...(Array.isArray(extra) ? extra.map(String) : [])].filter(Boolean);
    const roots: string[] = [];
    for (const d of dirs) {
      const bad = dangerousRootReason(d);
      if (bad) throw new Error(`session workspace rejected: ${bad}`);
      let abs: string;
      if (process.platform === "win32" && (d.startsWith("/home/") || d.startsWith("/root/"))) {
        // 纯 Linux 路径在 Windows 宿主机下绝不能盲目拼上盘符 (如 D:\home\...)
        abs = d.replace(/\\/g, "/");
      } else {
        abs = path.resolve(d);
      }
      if (!roots.includes(abs)) roots.push(abs);
    }
    return roots;
  }

  rememberSessionRoots(sessionId: unknown, roots: string[]): void {
    if (typeof sessionId === "string" && sessionId) {
      this.sessionRoots.set(sessionId, roots);
    }
  }

  /** 会话允许写入的根（未知会话 → 只剩全局根）。供测试与诊断。 */
  allowedRootsFor(sessionId: string): string[] {
    return [...(this.sessionRoots.get(sessionId) || []), ...getWorkspaceRoots()];
  }

  getSessionCwd(sessionId: string): string | undefined {
    return (this.sessionRoots.get(sessionId) || [])[0];
  }

  /**
   * fs guard for agent-initiated fs/* requests.
   * - Always: reject empty paths and system locations (/etc /proc /sys, Windows system dirs).
   * - Writes: must stay inside the session's allowed roots (session cwd +
   *   additionalDirectories + ACP_WORKSPACE_ROOTS + gateway cwd), symlinks
   *   resolved. Anything else is denied loudly (activity event + JSON-RPC error),
   *   e.g. an agent writing ~/.ssh/authorized_keys.
   * - Reads: not confined to the roots yet (agents legitimately read docs /
   *   toolchains outside the repo); only the system-path block applies.
   */
  checkFsPath(raw: string, sessionId: string, op: string, mode: "read" | "write"): string {
    const session = sessionId || "";
    if (!raw || !String(raw).trim()) throw new Error(`fs/${op} failed: path is required`);
    let resolved: string;
    try {
      resolved = path.resolve(String(raw));
    } catch (err) {
      console.error(`[UniversalACP:${this.agentId}] fs/${op} resolve failed ${raw}: ${(err as Error).message}`);
      throw new Error(`fs/${op} failed: invalid path`);
    }
    const lower = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const blockedPrefixes =
      process.platform === "win32"
        ? ["c:\\windows", "c:\\program files", "c:\\program files (x86)"]
        : ["/etc", "/proc", "/sys"];
    for (const b of blockedPrefixes) {
      if (lower === b || lower.startsWith(b + path.sep)) {
        this.emitActivity(session, `fs_${op}_blocked`, { path: raw, resolved });
        throw new Error(`fs/${op} denied: system path not writable/readable (${resolved})`);
      }
    }
    if (mode === "write") {
      const roots = this.sessionRoots.get(session) || [];
      if (!isPathAllowed(resolved, roots)) {
        const allowed = this.allowedRootsFor(session);
        this.emitActivity(session, `fs_${op}_blocked`, { path: raw, resolved, allowedRoots: allowed });
        console.warn(`[UniversalACP:${this.agentId}] fs/${op} denied outside workspace: ${resolved}`);
        // RequestError（-32602）让消息原样回到智能体，而不是被 SDK 压成 "Internal error"。
        throw new acp.RequestError(
          -32602,
          `fs/${op} denied: ${resolved} is outside the allowed workspace roots (${allowed.join(", ") || "none"}). ` +
            `Open that folder as the workspace, pass it in additionalDirectories, or add it to ACP_WORKSPACE_ROOTS.`,
          { path: raw, resolved, allowedRoots: allowed }
        );
      }
    }
    return resolved;
  }

  async handleReadFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const sid = params.sessionId || "";
    this.emitActivity(sid, "fs_read", { path: params.path, line: params.line, limit: params.limit });
    const resolved = this.checkFsPath(params.path, sid, "read_text_file", "read");
    try {
      const content = await fsp.readFile(resolved, "utf8");
      const lines = content.split("\n");
      if (params.line != null || params.limit != null) {
        const start = Math.max(0, (params.line ?? 1) - 1);
        const end = params.limit != null ? start + params.limit : undefined;
        return { content: lines.slice(start, end).join("\n") };
      }
      return { content };
    } catch (err) {
      throw new Error(`fs/read_text_file failed for ${params.path}: ${(err as Error).message}`);
    }
  }

  async handleWriteFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const sid = params.sessionId || "";
    this.emitActivity(sid, "fs_write", { path: params.path, bytes: Buffer.byteLength(params.content || "") });
    const resolved = this.checkFsPath(params.path, sid, "write_text_file", "write");
    try {
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, params.content, "utf8");
      return {};
    } catch (err) {
      throw new Error(`fs/write_text_file failed for ${params.path}: ${(err as Error).message}`);
    }
  }
}
