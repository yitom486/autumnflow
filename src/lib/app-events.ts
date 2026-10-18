/**
 * Closed union for the top-level SSE frames the gateway sends to the client.
 * Update kinds stay forward-compatible inside `update` (ACP evolves them), but
 * transport-level events are finite: adding one forces this normalizer and its
 * consumers to make an explicit decision instead of falling through silently.
 */
export type AppEvent =
  | { type: "start"; sessionId: string; agentId?: string; turnId?: string }
  | { type: "update"; update: Record<string, unknown> }
  | { type: "done"; stopReason?: string; response?: unknown }
  | { type: "error"; message: string; code?: number }
  | {
      type: "permission_request";
      permissionId: string;
      agentId: string;
      sessionId: string;
      toolCall: unknown;
      options: unknown[];
    }
  | {
      type: "elicitation_request";
      elicitationId: string;
      agentId: string;
      sessionId: string;
      message: string;
      schema: unknown;
      status?: "pending" | "accepted";
    }
  | { type: "elicitation_closed"; elicitationId: string }
  | { type: "activity"; kind: string; detail?: unknown }
  | { type: "unknown"; rawType: string; raw: Record<string, unknown> };

export function assertNever(value: never): never {
  throw new Error(`Unhandled AppEvent: ${JSON.stringify(value)}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Normalize an untrusted wire payload; unknown event types are preserved. */
export function normalizeAppEvent(payload: unknown): AppEvent {
  const raw = asRecord(payload);
  if (!raw) return { type: "unknown", rawType: "", raw: {} };
  const rawType = text(raw.type);
  switch (rawType) {
    case "start": {
      const sessionId = text(raw.sessionId);
      if (!sessionId) return { type: "unknown", rawType, raw };
      return {
        type: "start",
        sessionId,
        ...(text(raw.agentId) ? { agentId: text(raw.agentId) } : {}),
        ...(text(raw.turnId) ? { turnId: text(raw.turnId) } : {}),
      };
    }
    case "update": {
      const update = asRecord(raw.update);
      if (!update) return { type: "unknown", rawType, raw };
      return { type: "update", update };
    }
    case "done":
      return {
        type: "done",
        ...(text(raw.stopReason) ? { stopReason: text(raw.stopReason) } : {}),
        response: raw.response,
      };
    case "error":
      return {
        type: "error",
        message: text(raw.message) || "prompt failed",
        ...(typeof raw.code === "number" ? { code: raw.code } : {}),
      };
    case "permission_request":
      return {
        type: "permission_request",
        permissionId: text(raw.permissionId),
        agentId: text(raw.agentId),
        sessionId: text(raw.sessionId),
        toolCall: raw.toolCall,
        options: Array.isArray(raw.options) ? raw.options : [],
      };
    case "elicitation_request":
      return {
        type: "elicitation_request",
        elicitationId: text(raw.elicitationId),
        agentId: text(raw.agentId),
        sessionId: text(raw.sessionId),
        message: text(raw.message),
        schema: raw.schema,
        ...(raw.status === "pending" || raw.status === "accepted" ? { status: raw.status } : {}),
      };
    case "elicitation_completed":
    case "elicitation_closed":
      return { type: "elicitation_closed", elicitationId: text(raw.elicitationId) };
    case "activity":
      return {
        type: "activity",
        kind: text(raw.kind) || "activity",
        detail: raw.detail,
      };
    default:
      return { type: "unknown", rawType, raw };
  }
}
