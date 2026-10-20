// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "autumnflow-caps-mcp-"));
process.env.AUTUMNFLOW_HOME = home;

const { startMcpUiServer, stopMcpUiServer, setStudioToolEnabled } = await import(
  "../../server/universal/mcp-ui-server"
);
const { setToolEnabled, setSkillEnabled } = await import("../../server/universal/capability-registry");

const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Connection: "close" };
const version = "2025-03-26";

async function rpc(url: string, method: string, params: unknown = {}, sessionId?: string, id = 1) {
  return fetch(url, {
    method: "POST",
    headers: { ...headers, ...(sessionId ? { "Mcp-Session-Id": sessionId, "Mcp-Protocol-Version": version } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function initialize(url: string) {
  const response = await rpc(url, "initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const id = response.headers.get("mcp-session-id")!;
  await response.json();
  await fetch(url, {
    method: "POST", headers: { ...headers, "Mcp-Session-Id": id },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return id;
}

async function toolNames(url: string, session: string): Promise<string[]> {
  const listed = await rpc(url, "tools/list", {}, session);
  return (await listed.json()).result.tools.map((tool: { name: string }) => tool.name);
}

beforeEach(() => {
  const file = path.join(home, "capabilities.json");
  if (fs.existsSync(file)) fs.rmSync(file);
});

afterEach(async () => {
  await stopMcpUiServer();
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("studio-ui tool switches reach the agent", () => {
  it("hides a disabled tool from tools/list and refuses to call it", async () => {
    const { url } = await startMcpUiServer(0);
    const session = await initialize(url);
    expect(await toolNames(url, session)).toContain("render_editorial_diagram");

    setToolEnabled("render_editorial_diagram", false);
    setStudioToolEnabled("render_editorial_diagram", false);

    // The agent no longer sees the tool at all.
    const names = await toolNames(url, session);
    expect(names).not.toContain("render_editorial_diagram");
    expect(names).toContain("show_interactive_card");

    // And a direct call is rejected instead of silently doing the work.
    const called = await rpc(url, "tools/call", {
      name: "render_editorial_diagram",
      arguments: { title: "x", diagramType: "architecture" },
    }, session);
    const body = await called.json();
    expect(body.result?.isError).toBe(true);
    expect(String(body.result?.content?.[0]?.text ?? "")).toContain("disabled");
  });

  it("shows the tool again when it is switched back on", async () => {
    const { url } = await startMcpUiServer(0);
    const session = await initialize(url);
    setToolEnabled("prompt_form", false);
    setStudioToolEnabled("prompt_form", false);
    expect(await toolNames(url, session)).not.toContain("prompt_form");

    setToolEnabled("prompt_form", true);
    setStudioToolEnabled("prompt_form", true);
    expect(await toolNames(url, session)).toContain("prompt_form");
  });

  it("applies the stored switch to a session that connects later", async () => {
    setToolEnabled("show_interactive_card", false);
    const { url } = await startMcpUiServer(0);
    const session = await initialize(url);
    expect(await toolNames(url, session)).not.toContain("show_interactive_card");
  });

  it("keeps disabled skills out of the catalogue the agent reads", async () => {
    setSkillEnabled("diagram-design", false);
    const { url } = await startMcpUiServer(0);
    const session = await initialize(url);
    const called = await rpc(url, "tools/call", { name: "list_studio_skills", arguments: {} }, session);
    const body = await called.json();
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).not.toContain("diagram-design");
  });
});
