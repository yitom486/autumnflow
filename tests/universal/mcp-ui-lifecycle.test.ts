// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { startMcpUiServer, stopMcpUiServer, getMcpUiServerInfo } from "../../server/universal/mcp-ui-server";

const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Connection: "close" };
const version = "2025-03-26";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function rpc(url: string, method: string, params: unknown = {}, sessionId?: string, id = 1) {
  return fetch(url, {
    method: "POST",
    headers: { ...headers, ...(sessionId ? { "Mcp-Session-Id": sessionId, "Mcp-Protocol-Version": version } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function initialize(url: string, name: string) {
  const response = await rpc(url, "initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name, version: "1" } });
  expect(response.status).toBe(200);
  await response.json();
  const id = response.headers.get("mcp-session-id")!;
  expect(id).toBeTruthy();
  const notified = await fetch(url, {
    method: "POST", headers: { ...headers, "Mcp-Session-Id": id },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  expect(notified.status).toBe(202);
  return id;
}

async function count(url: string) {
  return (await (await fetch(new URL("/health", url), { headers: { Connection: "close" } })).json()).activeSessions;
}

afterEach(async () => { await stopMcpUiServer(); });

describe("Studio MCP connection lifecycle", () => {
  it("advertises discovery instructions with the mounted tools in the MCP handshake", async () => {
    const { url } = await startMcpUiServer(0);
    const response = await rpc(url, "initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "opencode", version: "2" } });
    const result = (await response.json()).result;
    const session = response.headers.get("mcp-session-id")!;
    expect(result.instructions).toContain('tools["studio-ui"]');
    expect(result.instructions).toContain("execute");
    expect(result.instructions).toContain("search");
    const initialized = await fetch(url, {
      method: "POST", headers: { ...headers, "Mcp-Session-Id": session },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initialized.status).toBe(202);
    const listed = await rpc(url, "tools/list", {}, session);
    for (const tool of (await listed.json()).result.tools) {
      expect(result.instructions).toContain(tool.name);
    }
  });
  it("isolates concurrent clients and overlapping JSON-RPC request IDs", async () => {
    const { url } = await startMcpUiServer(0);
    const ids = await Promise.all([initialize(url, "agy"), initialize(url, "opencode")]);
    expect(new Set(ids).size).toBe(2);
    expect(await count(url)).toBe(2);
    const results = await Promise.all(ids.map(async (session, index) => {
      const listed = await rpc(url, "tools/list", {}, session);
      expect((await listed.json()).result.tools.map((tool: { name: string }) => tool.name)).toContain("show_interactive_card");
      const response = await rpc(url, "tools/call", {
        name: "show_interactive_card", arguments: { title: `client-${index}`, cardType: "checklist", data: { items: [] } },
      }, session);
      expect(response.status).toBe(200);
      return (await response.json()).result.structuredContent;
    }));
    expect(results.map(result => result.title)).toEqual(["client-0", "client-1"]);
  });

  it("deletes only the requested session and accepts a fresh client afterward", async () => {
    const { url } = await startMcpUiServer(0);
    const first = await initialize(url, "first");
    const second = await initialize(url, "second");
    const deleted = await fetch(url, { method: "DELETE", headers: { "Mcp-Session-Id": first } });
    expect(deleted.status).toBe(200);
    await deleted.text();
    expect(await count(url)).toBe(1);
    expect((await rpc(url, "tools/list", {}, first)).status).toBe(404);
    const listed = await rpc(url, "tools/list", {}, second);
    expect(listed.status).toBe(200);
    await listed.json();
    await initialize(url, "replacement");
    expect(await count(url)).toBe(2);
  });

  it("does not allocate sessions for malformed requests or rejected handshakes", async () => {
    const { url } = await startMcpUiServer(0);
    const invalid = await fetch(url, { method: "POST", headers, body: "{" });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe(-32700);
    const missing = await rpc(url, "tools/list");
    expect(missing.status).toBe(400);
    await missing.json();
    const unknown = await rpc(url, "tools/list", {}, "unknown");
    expect(unknown.status).toBe(404);
    await unknown.json();
    const rejected = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "invalid", version: "1" } } }) });
    expect(rejected.status).toBe(406);
    await rejected.text();
    expect(await count(url)).toBe(0);
    await initialize(url, "valid");
    expect(await count(url)).toBe(1);
  });

  it("serializes concurrent starts, closes live SSE streams, and starts cleanly again", async () => {
    const [first, same] = await Promise.all([startMcpUiServer(0), startMcpUiServer(0)]);
    expect(first).toEqual(same);
    const session = await initialize(first.url, "streaming");
    const stream = fetch(first.url, { headers: { Accept: "text/event-stream", "Mcp-Session-Id": session } })
      .then(response => response.text()).catch(() => "closed");
    await delay(40);
    const stopping = stopMcpUiServer();
    const restarting = startMcpUiServer(0);
    await stopping;
    await stream;
    const fresh = await restarting;
    expect(getMcpUiServerInfo()).toEqual(fresh);
    expect(await count(fresh.url)).toBe(0);
    const stale = await rpc(fresh.url, "tools/list", {}, session);
    expect(stale.status).toBe(404);
    await stale.json();
    await initialize(fresh.url, "after-restart");
    await Promise.all([stopMcpUiServer(), stopMcpUiServer()]);
    expect(getMcpUiServerInfo()).toBeNull();
  });

  it("reclaims abandoned sessions without expiring an active SSE connection", async () => {
    const { url } = await startMcpUiServer(0, { sessionIdleTimeoutMs: 150, sessionSweepIntervalMs: 20 });
    const abandoned = await initialize(url, "abandoned");
    await expect.poll(() => count(url), { timeout: 2000 }).toBe(0);
    const stale = await rpc(url, "tools/list", {}, abandoned);
    expect(stale.status).toBe(404);
    await stale.json();
    const session = await initialize(url, "active");
    const controller = new AbortController();
    const stream = fetch(url, { signal: controller.signal, headers: { Accept: "text/event-stream", "Mcp-Session-Id": session } })
      .then(response => response.text()).catch(() => "closed");
    try {
      await delay(300);
      expect(await count(url)).toBe(1);
    } finally { controller.abort(); await stream; }
    await expect.poll(() => count(url), { timeout: 2000 }).toBe(0);
  });

  it("recovers from a failed startup and releases the listening port on shutdown", async () => {
    await expect(startMcpUiServer(-1)).rejects.toThrow();
    expect(getMcpUiServerInfo()).toBeNull();
    const first = await startMcpUiServer(0);
    await initialize(first.url, "before-shutdown");
    await stopMcpUiServer();
    await delay(50);
    const restarted = await startMcpUiServer(first.port);
    expect(restarted.port).toBe(first.port);
    expect(await count(restarted.url)).toBe(0);
  });

  it("keeps a session alive while an HTTP request body is still arriving", async () => {
    const { url } = await startMcpUiServer(0, { sessionIdleTimeoutMs: 150, sessionSweepIntervalMs: 20 });
    const session = await initialize(url, "uploading");
    const request = http.request(url, { method: "POST", headers: { ...headers, "Mcp-Session-Id": session } });
    const response = new Promise<number>((resolve, reject) => {
      request.on("error", reject);
      request.on("response", res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    });
    try {
      request.write('{"jsonrpc":"2.0",');
      await delay(300);
      expect(await count(url)).toBe(1);
      request.end('"id":1,"method":"tools/list","params":{}}');
      expect(await response).toBe(200);
    } finally { request.destroy(); await response.catch(() => undefined); }
  });
});
