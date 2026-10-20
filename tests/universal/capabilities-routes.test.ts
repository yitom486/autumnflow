// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "autumnflow-caps-route-"));
process.env.AUTUMNFLOW_HOME = home;

const { capabilitiesRouter } = await import("../../server/universal/http/capabilities");
const { universalRegistry } = await import("../../server/universal/registry");

// The router is mounted at /api/universal/capabilities in routes.ts, so the
// sub-router sees the paths relative to that mount point.
function get(query = "") {
  return capabilitiesRouter.request(`http://localhost/${query}`);
}

function post(path: string, body: unknown) {
  return capabilitiesRouter.request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  const file = path.join(home, "capabilities.json");
  if (fs.existsSync(file)) fs.rmSync(file);
});

afterEach(() => {
  vi.restoreAllMocks();
  const file = path.join(home, "capabilities.json");
  if (fs.existsSync(file)) fs.rmSync(file);
});

describe("capabilities route", () => {
  it("reports the tool catalogue and the skill list", async () => {
    vi.spyOn(universalRegistry, "connFor").mockReturnValue({
      status: () => ({ agentCapabilities: { mcpCapabilities: { http: true, stdio: false } } }),
    } as any);
    const body = await (await get("?agentId=codex")).json();
    expect(body.ok).toBe(true);
    expect(body.mcp.tools.map((tool: { name: string }) => tool.name)).toContain("show_interactive_card");
    expect(body.mcp.tools.every((tool: { enabled: boolean }) => tool.enabled)).toBe(true);
    expect(body.mcp.agentSupports).toEqual({ http: true, stdio: false });
    expect(Array.isArray(body.skills)).toBe(true);
  });

  it("survives an unknown agent instead of failing the whole report", async () => {
    vi.spyOn(universalRegistry, "connFor").mockImplementation(() => {
      throw new Error("agent not connected");
    });
    const response = await get("?agentId=ghost");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.mcp.agentSupports).toEqual({ http: false, stdio: false });
  });

  it("turns a tool off and reports the new state", async () => {
    const response = await post("/tool", { name: "show_interactive_card", enabled: false });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    const after = await (await get()).json();
    const tool = after.mcp.tools.find((entry: { name: string }) => entry.name === "show_interactive_card");
    expect(tool.enabled).toBe(false);
  });

  it("refuses an unknown tool or skill instead of writing it to the state file", async () => {
    const tool = await post("/tool", { name: "not-a-tool", enabled: false });
    expect(tool.status).toBe(404);
    const skill = await post("/skill", { name: "not-a-skill", enabled: false });
    expect(skill.status).toBe(404);
    expect(fs.existsSync(path.join(home, "capabilities.json"))).toBe(false);
  });

  it("rejects a malformed body with a reason", async () => {
    const response = await post("/tool", { enabled: false });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("invalid request body");
  });
});
