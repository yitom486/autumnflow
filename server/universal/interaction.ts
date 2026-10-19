import { CreateElicitationRequest, CreateElicitationResponse, RequestError, type CompleteElicitationNotification, type RequestPermissionRequest, type RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { sdkValue } from "./acp-sdk";
import { supportedElicitation, validateElicitationContent, isElicitationResponse } from "../../shared/elicitation";
import type { PendingElicitation, PendingPermission } from "./types";
import { randomUUID } from "node:crypto";

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

  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingElicitations = new Map<string, PendingElicitation>();
  // Owned by this ACP connection, keyed by the agent's opaque URL ID.
  private urlElicitations = new Map<string, PendingElicitation>();
  private elicitationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private requestAborts = new Map<string, () => void>();

  private clearRequestAbort(id: string): void { this.requestAborts.get(id)?.(); this.requestAborts.delete(id); }
  private bindRequestAbort(id: string, signal: AbortSignal | undefined, cancel: () => void): void {
    if (!signal) return;
    signal.addEventListener("abort", cancel, { once: true });
    this.requestAborts.set(id, () => signal.removeEventListener("abort", cancel));
    if (signal.aborted) cancel();
  }

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
    return [...new Map([...this.pendingElicitations.values(), ...this.urlElicitations.values()].map(p => [p.elicitationId, p])).values()]
      .filter((p) => !sessionId || !p.sessionId || p.sessionId === sessionId)
      .map((p) => ({
        elicitationId: p.elicitationId,
        agentId: p.agentId,
        sessionId: p.sessionId,
        message: p.message,
        schema: p.schema,
        status: p.status,
        createdAt: p.createdAt,
      }));
  }

  resolvePermission(permissionId: string, outcome: unknown): boolean {
    const p = this.pendingPermissions.get(permissionId);
    if (!p) return false;
    const response = sdkValue<RequestPermissionResponse>("RequestPermissionResponse", this.normalizePermissionOutcome(outcome));
    const selected = response.outcome;
    if (selected.outcome === "selected" && !p.options.some(option => option.optionId === selected.optionId)) {
      throw RequestError.invalidParams(undefined, "Permission option was not offered by this agent");
    }
    this.closePermission(p);
    p.resolve(response);
    return true;
  }

  private closePermission(p: PendingPermission): void {
    this.pendingPermissions.delete(p.permissionId);
    this.clearRequestAbort(p.permissionId);
    this.broadcast(p.sessionId, { type: "permission_closed", agentId: this.agentId, sessionId: p.sessionId, permissionId: p.permissionId });
  }

  resolveElicitation(elicitationId: string, result: unknown): boolean {
    const p = this.pendingElicitations.get(elicitationId) ?? [...this.urlElicitations.values()].find(p => p.elicitationId === elicitationId);
    if (!p) return false;
    if (!isElicitationResponse(result)) throw RequestError.invalidParams(undefined, "Invalid elicitation response");
    if (p.status === "accepted") {
      // Dismiss local waiting state only; never send a second ACP response.
      if (!CreateElicitationResponse.isCancel(result)) throw RequestError.invalidParams(undefined, "URL interaction already accepted");
      this.closeElicitation(p);
      return true;
    }
    if (CreateElicitationResponse.isAccept(result) && CreateElicitationRequest.isForm(p.schema)) {
      const errors = validateElicitationContent(p.schema.requestedSchema, result.content ?? {});
      if (Object.keys(errors).length) throw RequestError.invalidParams(undefined, JSON.stringify(errors));
    }
    this.pendingElicitations.delete(elicitationId);
    if (CreateElicitationResponse.isAccept(result) && CreateElicitationRequest.isUrl(p.schema)) {
      p.status = "accepted";
      this.clearRequestAbort(p.elicitationId);
      p.resolve({ action: "accept" });
    } else {
      this.closeElicitation(p);
      p.resolve(CreateElicitationResponse.isAccept(result) ? result : { action: result.action });
    }
    return true;
  }

  private closeElicitation(p: PendingElicitation, completed = false): void {
    this.clearRequestAbort(p.elicitationId);
    this.pendingElicitations.delete(p.elicitationId);
    if (CreateElicitationRequest.isUrl(p.schema)) this.urlElicitations.delete(p.schema.elicitationId);
    clearTimeout(this.elicitationTimers.get(p.elicitationId));
    this.elicitationTimers.delete(p.elicitationId);
    this.broadcast(p.sessionId || "*", { type: completed ? "elicitation_completed" : "elicitation_closed", agentId: this.agentId, sessionId: p.sessionId, elicitationId: p.elicitationId });
  }

  completeElicitation(params: CompleteElicitationNotification): void {
    const p = this.urlElicitations.get(params.elicitationId);
    if (!p || p.status !== "accepted") return;
    this.closeElicitation(p, true);
  }

  cancelPendingForSession(sessionId: string): void {
    for (const [id, p] of [...this.pendingPermissions]) {
      if (p.sessionId === sessionId) {
        this.closePermission(p);
        try {
          p.resolve({ outcome: "cancelled" });
        } catch (err) {
          console.error(`[UniversalACP:${this.agentId}] permission resolve after cancel failed ${id}: ${(err as Error).message}`);
        }
      }
    }
    for (const [id, e] of [...this.pendingElicitations]) {
      if (e.sessionId === sessionId) {
        this.closeElicitation(e);
        try {
          e.resolve({ action: "cancel" });
        } catch (err) {
          console.error(`[UniversalACP:${this.agentId}] elicitation resolve after cancel failed ${id}: ${(err as Error).message}`);
        }
      }
    }
    for (const p of [...this.urlElicitations.values()]) if (p.sessionId === sessionId) this.closeElicitation(p);
  }

  rejectAllOnExit(code: number | null, signal: string | null): void {
    for (const [id, p] of this.pendingPermissions) {
      this.closePermission(p);
      p.reject(new Error(`Agent exited (code ${code}, signal ${signal}) while permission ${id} pending`));
    }
    for (const [id, p] of this.pendingElicitations) {
      this.closeElicitation(p);
      p.reject(new Error(`Agent exited (code ${code}, signal ${signal}) while elicitation ${id} pending`));
    }
    for (const p of [...this.urlElicitations.values()]) this.closeElicitation(p);
  }

  handlePermissionRequest(params: RequestPermissionRequest, signal?: AbortSignal): Promise<RequestPermissionResponse> {
    if (signal?.aborted) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const permissionId = `perm-${randomUUID()}`;
    console.log(`[UniversalACP:${this.agentId}] permission request ${permissionId} session=${params.sessionId}`);
    
    return new Promise<RequestPermissionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingPermissions.has(permissionId)) {
          this.closePermission(this.pendingPermissions.get(permissionId)!);
          resolve({ outcome: { outcome: "cancelled" } });
        }
      }, INTERACTION_TIMEOUT_MS);

      const wrappedResolve = (outcome: unknown) => {
        clearTimeout(timer);
        this.clearRequestAbort(permissionId);
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
          this.clearRequestAbort(permissionId);
          reject(e);
        },
      });
      // Establish the pending entry before notifying a potentially synchronous sink.
      this.broadcast(params.sessionId, { type: "permission_request", agentId: this.agentId, sessionId: params.sessionId, permissionId, toolCall: params.toolCall, options: params.options });
      if (this.pendingPermissions.has(permissionId)) this.bindRequestAbort(permissionId, signal, () => this.resolvePermission(permissionId, { outcome: "cancelled" }));
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

  handleElicitation(params: CreateElicitationRequest, signal?: AbortSignal): Promise<CreateElicitationResponse> {
    if (!supportedElicitation(params)) throw RequestError.invalidParams(undefined, "Unsupported or malformed elicitation mode/schema/URL");
    if (signal?.aborted) return Promise.resolve({ action: "cancel" });
    if (CreateElicitationRequest.isUrl(params) && this.urlElicitations.has(params.elicitationId)) {
      throw RequestError.invalidParams(undefined, "Duplicate outstanding URL elicitation ID");
    }
    const elicitationId = `elic-${randomUUID()}`;
    const sessionId = "sessionId" in params && typeof params.sessionId === "string" ? params.sessionId : "";
    const message = params.message;
    console.log(`[UniversalACP:${this.agentId}] elicitation ${elicitationId} session=${sessionId}`);

    return new Promise<CreateElicitationResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pendingElicitations.get(elicitationId) ?? [...this.urlElicitations.values()].find(p => p.elicitationId === elicitationId);
        if (!p) return;
        this.closeElicitation(p);
        if (p.status !== "accepted") resolve({ action: "cancel" });
      }, INTERACTION_TIMEOUT_MS);
      this.elicitationTimers.set(elicitationId, timer);
      const pending: PendingElicitation = {
        elicitationId,
        agentId: this.agentId,
        sessionId,
        message,
        schema: params,
        status: "pending",
        createdAt: Date.now(),
        resolve,
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.pendingElicitations.set(elicitationId, pending);
      if (CreateElicitationRequest.isUrl(params)) this.urlElicitations.set(params.elicitationId, pending);
      this.broadcast(sessionId || "*", { type: "elicitation_request", agentId: this.agentId, sessionId, elicitationId, message, schema: params, status: "pending" });
      if (this.pendingElicitations.has(elicitationId)) this.bindRequestAbort(elicitationId, signal, () => this.resolveElicitation(elicitationId, { action: "cancel" }));
    });
  }
}
