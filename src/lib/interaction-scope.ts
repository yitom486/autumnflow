type InteractionScope = { agentId: string; sessionId?: string | null };

/** Session approvals must never appear in a different or not-yet-created chat. */
export function permissionInScope(request: InteractionScope, agentId: string, sessionId: string | null | undefined): boolean {
  return request.agentId === agentId && !!sessionId && request.sessionId === sessionId;
}

/** Requests without a session belong to agent-level setup/authentication. */
export function elicitationInScope(request: InteractionScope, agentId: string, sessionId: string | null | undefined): boolean {
  return request.agentId === agentId && (!request.sessionId || (!!sessionId && request.sessionId === sessionId));
}
