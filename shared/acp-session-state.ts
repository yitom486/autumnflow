import type { CompactionUpdate, ContentBlock, PlanUpdateContent, SessionMessage, SessionUpdate, SubagentUpdate } from "@agentclientprotocol/sdk";

export type SessionArtifact =
  | { kind: "plan"; value: PlanUpdateContent }
  | { kind: "compaction"; value: CompactionUpdate }
  | { kind: "message"; value: SessionMessage }
  | { kind: "subagent"; value: SubagentUpdate };
export type ArtifactUpdate = Extract<SessionUpdate, { sessionUpdate: "plan_update" | "plan_removed" | "compaction_update" | "compaction_summary_chunk" | "session_message" | "session_message_chunk" | "subagent_update" }>;
export function isArtifactUpdate(update: SessionUpdate): update is ArtifactUpdate {
  return ["plan_update", "plan_removed", "compaction_update", "compaction_summary_chunk", "session_message", "session_message_chunk", "subagent_update"].includes(update.sessionUpdate);
}
export function artifactKey(entry: SessionArtifact): string {
  switch (entry.kind) {
    case "plan": return `plan:${entry.value.planId}`;
    case "compaction": return `compaction:${entry.value.compactionId}`;
    case "message": return `message:${entry.value.messageId}`;
    case "subagent": return `subagent:${entry.value.sessionId}`;
  }
}
export function mergeArtifacts(previous: SessionArtifact[], incoming: SessionArtifact[]): SessionArtifact[] {
  const merged = [...previous];
  for (const entry of incoming) {
    const index = merged.findIndex(prior => artifactKey(prior) === artifactKey(entry));
    if (index < 0) merged.push(entry); else merged[index] = entry;
  }
  return merged;
}
export function updateKey(update: ArtifactUpdate): string {
  switch (update.sessionUpdate) {
    case "plan_update": return `plan:${update.plan.planId}`;
    case "plan_removed": return `plan:${update.planId}`;
    case "compaction_update": case "compaction_summary_chunk": return `compaction:${update.compactionId}`;
    case "session_message": case "session_message_chunk": return `message:${update.messageId}`;
    case "subagent_update": return `subagent:${update.sessionId}`;
  }
}
// Omission leaves stored fields unchanged; null is an explicit clearing patch.
function patch<T extends object>(prior: T, update: Partial<T>): T {
  return { ...prior, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)) };
}

/** Retains first-seen entity order for live updates and replay alike. */
export function applyArtifactUpdate(entries: SessionArtifact[], update: ArtifactUpdate): SessionArtifact[] {
  const key = updateKey(update);
  const index = entries.findIndex(entry => artifactKey(entry) === key);
  const prior = entries[index];
  if (update.sessionUpdate === "plan_removed") return entries.filter(entry => artifactKey(entry) !== key);
  let entry: SessionArtifact;
  switch (update.sessionUpdate) {
    case "plan_update": entry = { kind: "plan", value: update.plan }; break;
    case "compaction_update": entry = { kind: "compaction", value: patch(prior?.kind === "compaction" ? prior.value : { compactionId: update.compactionId, status: update.status }, update) }; break;
    case "compaction_summary_chunk": {
      const previous: CompactionUpdate = prior?.kind === "compaction" ? prior.value : { compactionId: update.compactionId, status: "in_progress" };
      entry = { kind: "compaction", value: { ...previous, summary: [...(previous.summary ?? []), update.content] } }; break;
    }
    case "session_message": {
      const { senderSessionId, recipientSessionId, ...message } = update;
      entry = { kind: "message", value: patch(prior?.kind === "message" ? prior.value : { messageId: update.messageId }, {
        ...message, ...(senderSessionId != null ? { senderSessionId } : {}), ...(recipientSessionId != null ? { recipientSessionId } : {}),
      }) }; break;
    }
    case "session_message_chunk": {
      const previous: SessionMessage = prior?.kind === "message" ? prior.value : { messageId: update.messageId };
      entry = { kind: "message", value: { ...previous, ...(update.senderSessionId != null ? { senderSessionId: update.senderSessionId } : {}), ...(update.recipientSessionId != null ? { recipientSessionId: update.recipientSessionId } : {}), content: [...(previous.content ?? []), update.content] } }; break;
    }
    case "subagent_update": entry = { kind: "subagent", value: patch(prior?.kind === "subagent" ? prior.value : { sessionId: update.sessionId }, update) }; break;
  }
  if (index < 0) return [...entries, entry];
  return entries.map((existing, i) => i === index ? entry : existing);
}

export function contentBlocksText(blocks: ContentBlock[]): string {
  return blocks.map(block => block.type === "text" ? block.text : block.type === "resource" && "text" in block.resource ? block.resource.text : "").join("");
}
