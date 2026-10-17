import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { PendingElicitation, PendingPermission } from "./types";

export type SseBroadcaster = (sessionId: string, evt: Record<string, unknown>) => void;

const INTERACTION_TIMEOUT_MS = process.env.ACP_PERMISSION_TIMEOUT_MS
  ? parseInt(process.env.ACP_PERMISSION_TIMEOUT_MS, 10)
  : 300_000;

/**
 * Manages pending user interactions requested by the Agent:
 * 1. Permissions (Allow/Deny tool calls)
 * 2. Elicitations (Forms / questions / user inputs)
 * 
 * Handles timeouts, cancellation upon prompt turn abort, and process exit rejection.
 */
export class InteractionManager {
  private readonly agentId: string;
  private readonly broadcast: SseBroadcaster;
  private permSeq = 1;
  private elicSeq = 1;

  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingElicitations = new Map<string, PendingElicitation>();

  constructor(agentId: string, broadcast: SseBroadcaster) {
    this.agentId = agentId;
    this.broadcast = broadcast;
  }

  listPendingPermissions(sessionId?: string) {
    return [...this.pendingPermissions.values()]
      .filter((p) => !sessionId || p.sessionId === sessionId)
      .map((p) => ({
        permissionId: p.permissionId,
        agentId: p.agentId,
        sessionId: p.sessionId,
        toolCall: p.toolCall,
        options: p.options,
        createdAt: p.createdAt,
      }));
  }

  listPendingElicitations(sessionId?: string) {
    return [...this.pendingElicitations.values()]
      .filter((p) => !sessionId || p.sessionId === sessionId)
      .map((p) => ({
        elicitationId: p.elicitationId,
        agentId: p.agentId,
        sessionId: p.sessionId,
        message: p.message,
        schema: p.schema,
        createdAt: p.createdAt,
      }));
  }

  resolvePermission(permissionId: string, outcome: unknown): boolean {
    const p = this.pendingPermissions.get(permissionId);
    if (!p) return false;
    this.pendingPermissions.delete(permissionId);
    p.resolve(outcome);
    return true;
  }

  resolveElicitation(elicitationId: string, result: unknown): boolean {
    const p = this.pendingElicitations.get(elicitationId);
    if (!p) return false;
    this.pendingElicitations.delete(elicitationId);
    p.resolve(result);
    return true;
  }

  cancelPendingForSession(sessionId: string): void {
    for (const [id, p] of [...this.pendingPermissions]) {
      if (p.sessionId === sessionId) {
        this.pendingPermissions.delete(id);
        try {
          p.resolve({ outcome: "cancelled" });
        } catch (err) {
          console.error(`[UniversalACP:${this.agentId}] permission resolve after cancel failed ${id}: ${(err as Error).message}`);
        }
      }
    }
    for (const [id, e] of [...this.pendingElicitations]) {
      if (e.sessionId === sessionId) {
        this.pendingElicitations.delete(id);
        try {
          e.resolve({ action: "cancel" });
        } catch (err) {
          console.error(`[UniversalACP:${this.agentId}] elicitation resolve after cancel failed ${id}: ${(err as Error).message}`);
        }
      }
    }
  }

  rejectAllOnExit(code: number | null, signal: string | null): void {
    for (const [id, p] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      p.reject(new Error(`Agent exited (code ${code}, signal ${signal}) while permission ${id} pending`));
    }
    for (const [id, p] of this.pendingElicitations) {
      this.pendingElicitations.delete(id);
      p.reject(new Error(`Agent exited (code ${code}, signal ${signal}) while elicitation ${id} pending`));
    }
  }

  handlePermissionRequest(params: { sessionId: string; toolCall: unknown; options: unknown }): Promise<RequestPermissionResponse> {
    const permissionId = `perm-${Date.now()}-${this.permSeq++}`;
    console.log(`[UniversalACP:${this.agentId}] permission request ${permissionId} session=${params.sessionId}`);
    
    // Notify any active prompt SSE streams immediately
    this.broadcast(params.sessionId, {
      type: "permission_request",
      agentId: this.agentId,
      sessionId: params.sessionId,
      permissionId,
      toolCall: params.toolCall,
      options: params.options,
    });

    return new Promise<RequestPermissionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingPermissions.has(permissionId)) {
          this.pendingPermissions.delete(permissionId);
          reject(new Error(`Permission request timed out after ${Math.round(INTERACTION_TIMEOUT_MS / 1000)}s`));
        }
      }, INTERACTION_TIMEOUT_MS);

      const wrappedResolve = (outcome: unknown) => {
        clearTimeout(timer);
        resolve(this.normalizePermissionOutcome(outcome));
      };

      this.pendingPermissions.set(permissionId, {
        permissionId,
        agentId: this.agentId,
        sessionId: params.sessionId,
        toolCall: params.toolCall,
        options: params.options,
        createdAt: Date.now(),
        resolve: wrappedResolve,
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  normalizePermissionOutcome(outcome: unknown): RequestPermissionResponse {
    if (outcome && typeof outcome === "object") {
      const o = outcome as Record<string, unknown>;
      // Case 1: Already fully conforming RequestPermissionResponse with nested outcome
      if (o.outcome && typeof o.outcome === "object") {
        const nested = o.outcome as Record<string, unknown>;
        if (nested.outcome === "selected" && typeof nested.optionId === "string") {
          return { outcome: { outcome: "selected", optionId: nested.optionId } };
        }
        if (nested.outcome === "cancelled") {
          return { outcome: { outcome: "cancelled" } };
        }
      }
      // Case 2: Flat outcome object { outcome: "selected" | "cancelled", optionId?: string }
      if (o.outcome === "selected" || o.outcome === "cancelled") {
        if (o.outcome === "selected" && typeof o.optionId === "string") {
          return { outcome: { outcome: "selected", optionId: o.optionId } };
        }
        return { outcome: { outcome: "cancelled" } };
      }
      // Case 3: Flat object with optionId
      if (typeof o.optionId === "string") {
        return { outcome: { outcome: "selected", optionId: o.optionId } };
      }
    }
    // Case 4: Plain string (optionId or explicit cancel)
    if (typeof outcome === "string") {
      if (outcome === "cancelled" || outcome === "reject" || outcome === "deny") {
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: outcome } };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  handleElicitation(params: Record<string, unknown>): Promise<unknown> {
    const elicitationId = `elic-${Date.now()}-${this.elicSeq++}`;
    const sessionId = String((params as { sessionId?: string }).sessionId || "");
    const message = String((params as { message?: string }).message || "Input requested");
    console.log(`[UniversalACP:${this.agentId}] elicitation ${elicitationId} session=${sessionId}`);

    this.broadcast(sessionId || "*", {
      type: "elicitation_request",
      agentId: this.agentId,
      sessionId,
      elicitationId,
      message,
      schema: params,
    });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingElicitations.has(elicitationId)) {
          this.pendingElicitations.delete(elicitationId);
          reject(new Error(`Elicitation timed out after ${Math.round(INTERACTION_TIMEOUT_MS / 1000)}s`));
        }
      }, INTERACTION_TIMEOUT_MS);

      this.pendingElicitations.set(elicitationId, {
        elicitationId,
        agentId: this.agentId,
        sessionId,
        message,
        schema: params,
        createdAt: Date.now(),
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
}
