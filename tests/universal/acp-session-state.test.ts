import { describe, expect, it, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { applyArtifactUpdate, type SessionArtifact } from "../../shared/acp-session-state";
import { buildTranscriptFromReplay, dispatchStandardUpdate } from "../../src/lib/universal-api";
import { freezeMessage, mergeAssistantTurns } from "../../src/lib/threads";

describe("official session update semantics", () => {
  it("replaces the full configuration list, including an empty list", () => {
    const onConfigOptions = vi.fn(), onConfigUpdate = vi.fn();
    dispatchStandardUpdate({ sessionUpdate: "config_option_update", configOptions: [] }, { onConfigOptions, onConfigUpdate });
    expect(onConfigOptions).toHaveBeenCalledExactlyOnceWith([]); expect(onConfigUpdate).not.toHaveBeenCalled();
  });
  it("shows standard notice title/description and keeps user echoes out of assistant output", () => {
    const onNotice = vi.fn(), onTextChunk = vi.fn();
    dispatchStandardUpdate({ sessionUpdate: "notice", title: "Heads up", description: "Details", severity: "warning" }, { onNotice });
    expect(onNotice).toHaveBeenCalledWith({ message: "Heads up\nDetails", severity: "warning" });
    dispatchStandardUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "my prompt" } }, { onTextChunk });
    expect(onTextChunk).not.toHaveBeenCalled();
  });
  it("does not reset tool state when a metadata-only update arrives", () => {
    const onToolCallUpdate = vi.fn();
    dispatchStandardUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t", title: "renamed" }, { onToolCallUpdate });
    expect(onToolCallUpdate).toHaveBeenCalledWith({ id: "t", title: "renamed" });
    const transcript = buildTranscriptFromReplay([{ sessionUpdate: "tool_call", toolCallId: "t", title: "tool", status: "completed" }, { sessionUpdate: "tool_call_update", toolCallId: "t", title: "renamed" }]);
    expect(transcript.messages[0].toolCalls?.[0].status).toBe("completed");
  });
  it("retains first-seen compaction placement, replacement, omission and explicit null clearing", () => {
    let entries: SessionArtifact[] = [];
    entries = applyArtifactUpdate(entries, { sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: { type: "text", text: "old" } });
    entries = applyArtifactUpdate(entries, { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "p", content: "plan" } });
    entries = applyArtifactUpdate(entries, { sessionUpdate: "compaction_update", compactionId: "c", status: "completed", summary: [{ type: "text", text: "replacement" }], error: "error" });
    entries = applyArtifactUpdate(entries, { sessionUpdate: "compaction_update", compactionId: "c", status: "completed", error: null });
    expect(entries[0]).toMatchObject({ kind: "compaction", value: { status: "completed", summary: [{ text: "replacement" }], error: null } });
    entries = applyArtifactUpdate(entries, { sessionUpdate: "compaction_update", compactionId: "c", status: "completed", summary: null });
    expect(entries[0]).toMatchObject({ value: { summary: null } }); expect(entries[1].kind).toBe("plan");
    expect(applyArtifactUpdate(entries, { sessionUpdate: "plan_removed", planId: "p" })).toHaveLength(1);
  });
  it("handles session-message upserts/chunks and retains known identities on null", () => {
    let entries = applyArtifactUpdate([], { sessionUpdate: "session_message", messageId: "m", senderSessionId: "child", recipientSessionId: "parent", content: [{ type: "text", text: "old" }] });
    entries = applyArtifactUpdate(entries, { sessionUpdate: "session_message_chunk", messageId: "m", content: { type: "text", text: "append" } });
    entries = applyArtifactUpdate(entries, { sessionUpdate: "session_message", messageId: "m", senderSessionId: null, content: [] });
    expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ value: { senderSessionId: "child", recipientSessionId: "parent", content: [] } });
  });
  it("updates subagent snapshots and clears child mutation permissions on null", () => {
    let entries = applyArtifactUpdate([], { sessionUpdate: "subagent_update", sessionId: "child", title: "Task", state: { state: "running" }, capabilities: { cancel: {} } });
    entries = applyArtifactUpdate(entries, { sessionUpdate: "subagent_update", sessionId: "child", state: { state: "idle" } });
    expect(entries[0]).toMatchObject({ value: { title: "Task", state: { state: "idle" }, capabilities: { cancel: {} } } });
    entries = applyArtifactUpdate(entries, { sessionUpdate: "subagent_update", sessionId: "child", capabilities: null, title: null });
    expect(entries[0]).toMatchObject({ value: { title: null, capabilities: null } });
  });
  it("uses the same entity reducer for live display and historical replay", () => {
    const updates: SessionUpdate[] = [ { sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: { type: "text", text: "summary" } }, { sessionUpdate: "compaction_update", compactionId: "c", status: "completed" } ];
    let live: SessionArtifact[] = [];
    for (const update of updates) dispatchStandardUpdate(update, { onArtifactUpdate: value => { live = applyArtifactUpdate(live, value); } });
    const replay = buildTranscriptFromReplay(updates);
    expect(replay.messages).toHaveLength(1); expect(replay.messages[0].artifacts).toEqual(live);
  });
  it("preserves non-text content and artifacts across turn merges without persisting binary payloads", () => {
    const resource = { type: "resource_link" as const, uri: "https://example.org/docs", name: "Docs" };
    const artifact: SessionArtifact = { kind: "plan", value: { type: "markdown", planId: "p", content: "Plan" } };
    const merged = mergeAssistantTurns([{ id: "a", role: "assistant" as const, content: "", contentBlocks: [resource] }, { id: "b", role: "assistant" as const, content: "", artifacts: [artifact] }]);
    expect(merged[0]).toMatchObject({ contentBlocks: [resource], artifacts: [artifact] });
    const frozen = freezeMessage({ ...merged[0], timestamp: "now", contentBlocks: [resource, { type: "audio", data: "AA==", mimeType: "audio/wav" }] });
    expect(frozen.contentBlocks).toEqual([resource]);
  });
});
