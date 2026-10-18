import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, shutdownBridges } from "../../server/gateway";
import { universalRegistry } from "../../server/universal/registry";
import { authedRequest } from "../helpers/gateway-auth";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Mock ACP Black-box Integration Pipeline", () => {
  const app = buildApp();
  const mockAgentId = "mock-blackbox-agent";
  const fixturePath = path.resolve(__dirname, "../fixtures/mock-acp-agent.ts");

  beforeAll(() => {
    // Register the mock stdio ACP agent using bun
    universalRegistry.upsertProfile({
      id: mockAgentId,
      name: "mock-blackbox-acp",
      title: "Mock Blackbox Agent",
      command: process.platform === "win32" ? "bun.exe" : "bun",
      args: ["run", fixturePath],
      env: {},
    });
  });

  afterAll(async () => {
    try {
      await universalRegistry.connFor(mockAgentId).disconnect();
    } catch {
      // ignore
    }
    universalRegistry.removeProfile(mockAgentId);
    await shutdownBridges();
  });

  it("prevents thundering herd / SIGTERM crash when concurrent connect calls are made", async () => {
    // Issue 5 simultaneous connect requests to simulate StrictMode / multi-caller load
    const connectReqs = Array.from({ length: 5 }, () =>
      app.fetch(
        authedRequest(`http://localhost:3004/api/universal/agents/${mockAgentId}/connect`, {
          method: "POST",
        })
      )
    );

    const responses = await Promise.all(connectReqs);
    const bodies = await Promise.all(
      responses.map((r) => r.json() as Promise<{ ok: boolean; status: { connected: boolean; pid?: number } }>)
    );

    for (let i = 0; i < responses.length; i++) {
      expect(responses[i].status).toBe(200);
      expect(bodies[i].ok).toBe(true);
      expect(bodies[i].status.connected).toBe(true);
      expect(typeof bodies[i].status.pid).toBe("number");
    }

    // Verify all 5 callers shared the exact same connected agent process pid
    const firstPid = bodies[0].status.pid;
    for (const b of bodies) {
      expect(b.status.pid).toBe(firstPid);
    }

    const finalStatus = universalRegistry.connFor(mockAgentId).status();
    expect(finalStatus.connected).toBe(true);
    expect(finalStatus.lastError).toBeNull();
  }, 15000);

  it("executes end-to-end event stream with thoughts, text, tool calls, images, and usage", async () => {
    // 1. Create session
    const sessRes = await app.fetch(
      authedRequest(`http://localhost:3004/api/universal/agents/${mockAgentId}/session/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(sessRes.status).toBe(200);
    const sessData = (await sessRes.json()) as { ok: boolean; result: { sessionId: string; models: any } };
    expect(sessData.ok).toBe(true);
    const sessionId = sessData.result.sessionId;
    expect(sessionId).toBeTruthy();

    // 2. Send multi-modal prompt with text and image block
    const promptPayload = {
      agentId: mockAgentId,
      sessionId,
      prompt: [
        { type: "text", text: "Process my code and attached screenshot" },
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    };

    const chatRes = await app.fetch(
      authedRequest("http://localhost:3004/api/universal/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promptPayload),
      })
    );
    expect(chatRes.status).toBe(200);
    expect(chatRes.headers.get("Content-Type")).toContain("text/event-stream");

    // Read and parse SSE stream
    const reader = chatRes.body!.getReader();
    const decoder = new TextDecoder();
    const events: Array<Record<string, any>> = [];
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          try {
            events.push(JSON.parse(trimmed.slice(6)));
          } catch {
            // ignore partial json
          }
        }
      }
    }
    if (buffer.trim().startsWith("data: ")) {
      try {
        events.push(JSON.parse(buffer.trim().slice(6)));
      } catch {
        // ignore
      }
    }

    // Verify presence and order of event stream
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("start");
    expect(eventTypes).toContain("update");
    expect(eventTypes).toContain("done");

    // Extract updates
    const updates = events.filter((e) => e.type === "update").map((e) => e.update);
    const updateKinds = updates.map((u) => u.sessionUpdate);

    // Verify thoughts
    expect(updateKinds).toContain("agent_thought_chunk");
    const thoughtEvt = updates.find((u) => u.sessionUpdate === "agent_thought_chunk");
    expect(thoughtEvt.content.text).toContain("Thought:");

    // Verify text stream and image acknowledgment
    expect(updateKinds).toContain("agent_message_chunk");
    const textChunks = updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content.text)
      .join("");
    expect(textChunks).toContain("Hello from Mock ACP Agent!");
    expect(textChunks).toContain("[Verified image mime=image/png");
    expect(textChunks).toContain("All stream segments delivered successfully.");

    // Verify plan
    expect(updateKinds).toContain("plan");
    const planEvt = updates.find((u) => u.sessionUpdate === "plan");
    expect(planEvt.entries.length).toBe(2);

    // Verify tool call lifecycle (pending -> completed)
    expect(updateKinds).toContain("tool_call");
    expect(updateKinds).toContain("tool_call_update");
    const toolCall = updates.find((u) => u.sessionUpdate === "tool_call");
    expect(toolCall.toolCallId).toBe("tool-call-blackbox-1");
    expect(toolCall.status).toBe("pending");

    const toolUpdate = updates.find((u) => u.sessionUpdate === "tool_call_update");
    expect(toolUpdate.toolCallId).toBe("tool-call-blackbox-1");
    expect(toolUpdate.status).toBe("completed");
    expect(JSON.stringify(toolUpdate.content)).toContain("passed");

    // Verify usage
    expect(updateKinds).toContain("usage_update");
    const usageEvt = updates.find((u) => u.sessionUpdate === "usage_update");
    expect(usageEvt.used).toBe(256);
    expect(usageEvt.size).toBe(8192);

    // Verify done
    const doneEvt = events.find((e) => e.type === "done");
    expect(doneEvt.stopReason).toBe("end_turn");
  });

  it("handles interactive permission requests via gateway respond endpoint", async () => {
    // 1. Create fresh session
    const sessRes = await app.fetch(
      authedRequest(`http://localhost:3004/api/universal/agents/${mockAgentId}/session/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    const sessData = (await sessRes.json()) as any;
    const sessionId = sessData.result.sessionId;

    // 2. Send prompt that triggers permission request
    const chatRes = await app.fetch(
      authedRequest("http://localhost:3004/api/universal/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: mockAgentId,
          sessionId,
          prompt: "trigger_permission on sensitive file",
        }),
      })
    );

    const reader = chatRes.body!.getReader();
    const decoder = new TextDecoder();
    let permId: string | null = null;
    let textReceived = "";
    let buffer = "";

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            try {
              const evt = JSON.parse(trimmed.slice(6));
              if (evt.type === "permission_request") {
                permId = evt.permissionId;
              }
              if (evt.type === "update" && evt.update?.sessionUpdate === "agent_message_chunk") {
                textReceived += evt.update.content.text;
              }
            } catch {
              // ignore
            }
          }
        }
      }
    })();

    // Poll until permissionId is detected
    for (let i = 0; i < 50; i++) {
      if (permId) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(permId).toBeTruthy();

    // Respond to permission via Gateway HTTP API
    const respondRes = await app.fetch(
      authedRequest(`http://localhost:3004/api/universal/permission/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: mockAgentId,
          permissionId: permId,
          outcome: { outcome: "allow" },
        }),
      })
    );
    expect(respondRes.status).toBe(200);
    const respondData = (await respondRes.json()) as { ok: boolean };
    expect(respondData.ok).toBe(true);

    // Await stream completion
    await readPromise;
    expect(textReceived).toContain("Permission resolved with");
  });

  it("handles interactive user elicitation via gateway respond endpoint", async () => {
    // 1. Create fresh session
    const sessRes = await app.fetch(
      authedRequest(`http://localhost:3004/api/universal/agents/${mockAgentId}/session/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    const sessData = (await sessRes.json()) as any;
    const sessionId = sessData.result.sessionId;

    // 2. Send prompt that triggers elicitation
    const chatRes = await app.fetch(
      authedRequest("http://localhost:3004/api/universal/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: mockAgentId,
          sessionId,
          prompt: "trigger_elicitation for target environment",
        }),
      })
    );

    const reader = chatRes.body!.getReader();
    const decoder = new TextDecoder();
    let elicId: string | null = null;
    let textReceived = "";
    let buffer = "";

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            try {
              const evt = JSON.parse(trimmed.slice(6));
              if (evt.type === "elicitation_request") {
                elicId = evt.elicitationId;
              }
              if (evt.type === "update" && evt.update?.sessionUpdate === "agent_message_chunk") {
                textReceived += evt.update.content.text;
              }
            } catch {
              // ignore
            }
          }
        }
      }
    })();

    // Poll until elicitation request arrives or check pending elicitations
    for (let i = 0; i < 50; i++) {
      if (elicId) break;
      const elics = universalRegistry.connFor(mockAgentId).listPendingElicitations(sessionId);
      if (elics.length > 0) {
        elicId = elics[0].elicitationId;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(elicId).toBeTruthy();

    // Invalid/untyped answers must not consume the pending SDK request.
    const invalidRes = await app.fetch(authedRequest("http://localhost:3004/api/universal/elicitation/respond", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: mockAgentId, elicitationId: elicId, result: { targetEnv: "staging-cluster-1" } }),
    }));
    expect(invalidRes.status).toBe(400);

    // Respond to elicitation via Gateway HTTP API
    const respondRes = await app.fetch(
      authedRequest(`http://localhost:3004/api/universal/elicitation/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: mockAgentId,
          elicitationId: elicId,
          result: { action: "accept", content: { targetEnv: "staging-cluster-1" } },
        }),
      })
    );
    expect(respondRes.status).toBe(200);

    // Await stream completion
    await readPromise;
    expect(textReceived).toContain("Elicitation resolved");
    expect(textReceived).toContain('"action":"accept"');
    expect(textReceived).toContain('"targetEnv":"staging-cluster-1"');
  });

  it("handles prompt turn cancellation cleanly without process crash", async () => {
    // 1. Create fresh session
    const sessRes = await app.fetch(
      authedRequest(`http://localhost:3004/api/universal/agents/${mockAgentId}/session/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    const sessData = (await sessRes.json()) as any;
    const sessionId = sessData.result.sessionId;

    // 2. Start prompt turn that waits for cancellation
    const chatRes = await app.fetch(
      authedRequest("http://localhost:3004/api/universal/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: mockAgentId,
          sessionId,
          prompt: "trigger_cancel on long task",
        }),
      })
    );

    const reader = chatRes.body!.getReader();
    const decoder = new TextDecoder();
    let doneEvt: any = null;
    let started = false;
    let buffer = "";

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            try {
              const evt = JSON.parse(trimmed.slice(6));
              if (evt.type === "start") started = true;
              if (evt.type === "done") doneEvt = evt;
            } catch {
              // ignore
            }
          }
        }
      }
    })();

    // Wait until stream has started
    for (let i = 0; i < 50; i++) {
      if (started) break;
      await new Promise((r) => setTimeout(r, 30));
    }

    // Issue session/cancel RPC
    const cancelRes = await app.fetch(
      authedRequest(`http://localhost:3004/api/universal/agents/${mockAgentId}/session/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
    );
    expect(cancelRes.status).toBe(200);

    await readPromise;
    expect(doneEvt).toBeTruthy();
    expect(doneEvt.stopReason).toBe("cancelled");

    // Verify agent is still alive and healthy after cancel
    const status = universalRegistry.connFor(mockAgentId).status();
    expect(status.connected).toBe(true);
  });
});
