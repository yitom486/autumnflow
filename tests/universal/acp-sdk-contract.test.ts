// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { clientCapabilities, requestAgent, requireAgentCapability, sdkRequest, sdkValue } from "../../server/universal/acp-sdk";
import { FsGuard } from "../../server/universal/fs-guard";
import { InteractionManager } from "../../server/universal/interaction";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

describe("official SDK schema boundary", () => {
  it("discovers standard request shapes and strips custom root fields while preserving opaque _meta", () => {
    const request = sdkRequest(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [], privateField: "must not escape", _meta: { "example.org/context": { anything: [1, 2] } } });
    expect(request).toEqual({ cwd: process.cwd(), mcpServers: [], _meta: { "example.org/context": { anything: [1, 2] } } });
    expect(sdkRequest(acp.methods.agent.session.setConfigOption, { sessionId: "s", configId: "confirm", type: "boolean", value: false })).toMatchObject({ type: "boolean", value: false });
    expect(() => sdkRequest(acp.methods.agent.session.setConfigOption, { sessionId: "s", configId: "confirm", value: false })).toThrow();
    expect(() => sdkRequest(acp.methods.agent.session.prompt, { sessionId: "s", prompt: [{ type: "invented", text: "x" }] })).toThrow();
  });

  it("validates every exposed session and authentication request against SDK definitions", () => {
    const session = acp.methods.agent.session;
    for (const [method, params] of [
      [acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities }],
      [acp.methods.agent.authenticate, { methodId: "login" }], [acp.methods.agent.logout, {}],
      [session.new, { cwd: process.cwd(), mcpServers: [] }], [session.load, { sessionId: "s", cwd: process.cwd(), mcpServers: [] }],
      [session.resume, { sessionId: "s", cwd: process.cwd(), mcpServers: [] }], [session.fork, { sessionId: "s", cwd: process.cwd(), mcpServers: [] }],
      [session.list, { cursor: "next" }], [session.delete, { sessionId: "s" }], [session.close, { sessionId: "s" }],
      [session.setMode, { sessionId: "s", modeId: "agent" }], [session.setConfigOption, { sessionId: "s", configId: "model", value: "m" }],
      [session.prompt, { sessionId: "s", prompt: [{ type: "text", text: "hello" }] }],
      [acp.methods.agent.providers.list, {}], [acp.methods.agent.providers.disable, { providerId: "p" }],
    ] as const) expect(() => sdkRequest(method, params)).not.toThrow();
  });

  it("uses the SDK method/response pair over a real SDK connection", async () => {
    const agent = acp.agent().onRequest(acp.methods.agent.session.setConfigOption, ctx => ({ configOptions: [{ id: ctx.params.configId, name: "Confirm", type: "boolean", currentValue: ctx.params.value === false ? false : true }] }));
    const connection = acp.client().connect(agent);
    try {
      const result = await requestAgent(connection, acp.methods.agent.session.setConfigOption, { sessionId: "s", configId: "confirm", type: "boolean", value: false });
      expect(result.configOptions[0].currentValue).toBe(false);
    } finally { connection.close(); }
  });

  it("treats omitted/null/false capabilities as unsupported, and accepts empty capability objects", () => {
    for (const cap of [undefined, null, false]) {
      try { requireAgentCapability("session.list", cap); throw new Error("missing error"); }
      catch (error) { expect((error as acp.RequestError).code).toBe(-32601); }
    }
    expect(() => requireAgentCapability("session.list", {})).not.toThrow();
    expect(sdkValue<acp.ClientCapabilities>("ClientCapabilities", clientCapabilities)).toEqual(clientCapabilities);
    expect(clientCapabilities).not.toHaveProperty("nes");
  });

  it("applies a read limit even when the optional start line is omitted", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "acp-sdk-file-"));
    try {
      const file = path.join(dir, "text.txt"); await fs.writeFile(file, "one\ntwo\nthree");
      const guard = new FsGuard("test", () => {});
      expect(await guard.handleReadFile({ sessionId: "s", path: file, limit: 1 })).toEqual({ content: "one" });
      expect(await guard.handleReadFile({ sessionId: "s", path: file, line: 2, limit: 1 })).toEqual({ content: "two" });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("rejects permission options not supplied by the agent and leaves the request pending", async () => {
    const manager = new InteractionManager("agent", () => {});
    const pending = manager.handlePermissionRequest({ sessionId: "s", toolCall: { toolCallId: "tool" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] });
    const id = manager.listPendingPermissions()[0].permissionId;
    expect(() => manager.resolvePermission(id, { outcome: "selected", optionId: "fabricated" })).toThrow();
    expect(manager.listPendingPermissions()).toHaveLength(1);
    manager.resolvePermission(id, { outcome: "selected", optionId: "yes" });
    await expect(pending).resolves.toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
  });

  it("respects SDK request cancellation for both permission and elicitation", async () => {
    const manager = new InteractionManager("agent", () => {});
    const first = new AbortController(), second = new AbortController();
    const permission = manager.handlePermissionRequest({ sessionId: "s", toolCall: { toolCallId: "tool" }, options: [] }, first.signal);
    const elicitation = manager.handleElicitation({ mode: "form", sessionId: "s", message: "Input", requestedSchema: { type: "object", properties: {} } }, second.signal);
    first.abort(); second.abort();
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(elicitation).resolves.toEqual({ action: "cancel" });
    expect(manager.listPendingPermissions()).toEqual([]); expect(manager.listPendingElicitations()).toEqual([]);
  });
});
