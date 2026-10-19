/**
 * Universal ACP gateway types (v1).
 * Covers generic stdio agents: codex-acp, gemini/claude/opencode/copilot, + legacy antigravity.
 */

export interface AgentCommand {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentProfile extends AgentCommand {
  id: string;
  name: string;
  title: string;
  description?: string;
  homepage?: string;
  /** default cwd for sessions when frontend omits it */
  defaultCwd?: string;
  /** whether this profile is built-in (shipped) vs user custom */
  builtin?: boolean;
  /**
   * Shell principle: how to log in ONCE with the official CLI so that
   * credentials stay in the vendor's own store (we never keep secrets).
   * Shown in the UI; never contains secrets.
   */
  authHint?: string;
  /** Shown when the command binary is missing from PATH. */
  installHint?: string;
}

export interface AgentStatus {
  id: string;
  connected: boolean;
  pid?: number | null;
  protocolVersion?: number | null;
  agentInfo?: import("@agentclientprotocol/sdk").Implementation | null;
  agentCapabilities?: import("@agentclientprotocol/sdk").AgentCapabilities | null;
  authMethods?: import("@agentclientprotocol/sdk").AuthMethod[] | null;
  /** `initialize._meta.authStatus` passthrough (e.g. codex), null when unknown. */
  authStatus?: unknown;
  /** `initialize._meta` passthrough, null when unknown. */
  meta?: Record<string, unknown> | null;
  quota?: unknown;
  lastError?: string | null;
  startedAt?: string | null;
}

export type UniversalSseEvent =
  | { type: "start"; agentId: string; sessionId: string }
  | { type: "update"; agentId: string; sessionId: string; update: Record<string, unknown>; quota?: unknown }
  | { type: "quota_update"; agentId: string; sessionId?: string; quota: unknown }
  | {
      type: "permission_request";
      agentId: string;
      sessionId: string;
      permissionId: string;
      toolCall?: unknown;
      options?: unknown;
    }
  | {
      type: "elicitation_request";
      agentId: string;
      sessionId: string;
      elicitationId: string;
      message?: string;
      schema?: unknown;
    }
  | { type: "permission_closed"; agentId: string; sessionId: string; permissionId: string }
  | { type: "activity"; agentId: string; sessionId: string; kind: string; detail?: unknown }
  | { type: "done"; agentId: string; sessionId: string; stopReason?: string; response?: unknown }
  | { type: "error"; agentId: string; sessionId?: string; message: string };

export interface PendingPermission {
  permissionId: string;
  agentId: string;
  sessionId: string;
  toolCall: import("@agentclientprotocol/sdk").RequestPermissionRequest["toolCall"];
  options: import("@agentclientprotocol/sdk").PermissionOption[];
  createdAt: number;
  resolve: (outcome: unknown) => void;
  reject: (err: Error) => void;
}

export type PendingElicitation = import("../../shared/elicitation").ElicitationItem & {
  createdAt: number;
  resolve: (result: import("@agentclientprotocol/sdk").CreateElicitationResponse) => void;
  reject: (err: Error) => void;
}
