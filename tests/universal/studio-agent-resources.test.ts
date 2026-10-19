// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { StudioAgentResources, ensureStudioResources } from "../../server/universal/studio-agent-resources";

let root: string;
const owners: StudioAgentResources[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "studio-resources-test-"));
  vi.stubEnv("AUTUMNFLOW_RESOURCES_DIR", root);
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()));
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
function owner() { const resource = new StudioAgentResources("Default application rules"); owners.push(resource); return resource; }

describe("application-owned configuration", () => {
  it("seeds defaults once and preserves editable rules, system instructions and skills", async () => {
    await ensureStudioResources("Defaults");
    await fs.writeFile(path.join(root, "AGENTS.md"), "Custom rules");
    await fs.writeFile(path.join(root, "SYSTEM.md"), "Custom system addition");
    await ensureStudioResources("New defaults must not overwrite edits");
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("Custom rules");
    const resource = owner();
    await resource.prepare("agy", root, "agy", {});
    resource.handshake("0.1.24");
    const snapshot = (resource.sessionMeta()!.appResources as { directory: string }).directory;
    const text = await fs.readFile(path.join(snapshot, "AGENTS.md"), "utf8");
    expect(text).toContain("Custom rules");
    expect(text).toContain("Custom system addition");
    expect(resource.report().skillsFound).toContain("diagram-design");
    expect(snapshot).not.toBe(root);
  });

  it("uses the SDK agy session extension only for a verified bridge and confirmation", async () => {
    const resource = owner();
    const env = await resource.prepare("antigravity-stdio", root, "agy", {});
    expect(env).toEqual({ AGY_ACP_MCP_SCOPE: "session" });
    expect(resource.sessionMeta()).toBeUndefined();
    resource.handshake("0.1.24");
    expect(resource.sessionMeta()).toHaveProperty("appResources.directory");
    resource.rememberSession("native", { _meta: { appResources: { prepared: true } } });
    expect(resource.compatibilityText("native")).toBeNull();
    resource.rememberSession("unconfirmed", {});
    expect(resource.compatibilityText("unconfirmed")).toContain("mode=\"compatibility\"");
  });

  it("delivers honest compatibility context once and renews it on restoration", async () => {
    const resource = owner();
    await resource.prepare("agy", root, "agy", {});
    resource.handshake("99.0.0");
    expect(resource.sessionMeta()).toBeUndefined();
    resource.rememberSession("s", {});
    expect(resource.compatibilityText("s")).toContain("Default application rules");
    expect(resource.compatibilityText("s")).toBeNull();
    resource.rememberSession("s", {});
    expect(resource.compatibilityText("s")).toContain("not system/developer");
  });

  it("owns independent snapshots and removes only generated configuration", async () => {
    const first = owner(), second = owner();
    await first.prepare("agy", root, "agy", {});
    await second.prepare("agy", root, "agy", {});
    const a = first.report().snapshotDirectory!, b = second.report().snapshotDirectory!;
    expect(a).not.toBe(b);
    await first.dispose();
    await expect(fs.stat(a)).rejects.toThrow();
    expect((await fs.stat(b)).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(root, "AGENTS.md"))).isFile()).toBe(true);
  });

  it("loads only application MCP descriptors and rejects global agy registration", async () => {
    await ensureStudioResources("rules");
    const servers = [{ type: "http", name: "private", url: "http://127.0.0.1:12345/mcp", headers: [] }];
    await fs.writeFile(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    const resource = owner();
    await resource.prepare("agy", root, "agy", {});
    expect(resource.configuredMcpServers()).toEqual(servers);
    await expect(owner().prepare("agy", root, "agy", { AGY_ACP_MCP_SCOPE: "global" })).rejects.toThrow("Global MCP registration is forbidden");
  });

  it("cleans up a failed preparation instead of leaking snapshots", async () => {
    await ensureStudioResources("rules");
    await fs.writeFile(path.join(root, "mcp.json"), "{}");
    const resource = owner();
    await expect(resource.prepare("agy", root, "agy", {})).rejects.toThrow("mcpServers array");
    expect(await fs.readdir(path.join(root, "sessions"))).toEqual([]);
    expect(resource.report().snapshotDirectory).toBeNull();
  });
});
