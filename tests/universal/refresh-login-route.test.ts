// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "autumnflow-refresh-login-"));
process.env.AUTUMNFLOW_HOME = home;

const { agentsRouter } = await import("../../server/universal/http/agents");
const { universalRegistry } = await import("../../server/universal/registry");
const { turnRegistry } = await import("../../server/universal/turn-registry");

function post(path: string) {
  return agentsRouter.request(`http://localhost${path}`, { method: "POST" });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  turnRegistry.resetForTest();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("refresh local login", () => {
  it("refuses an agent that already reuses the machine login", async () => {
    vi.spyOn(universalRegistry, "listProfiles").mockReturnValue([
      { id: "claude", name: "claude", title: "Claude", command: "claude", args: [] },
    ] as any);
    const response = await post("/claude/refresh-login");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("直接复用本机登录态");
  });

  it("refuses an unknown agent", async () => {
    vi.spyOn(universalRegistry, "listProfiles").mockReturnValue([] as any);
    const response = await post("/ghost/refresh-login");
    expect(response.status).toBe(404);
  });

  it("refuses while a turn is running", async () => {
    vi.spyOn(universalRegistry, "listProfiles").mockReturnValue([
      { id: "codex", name: "codex", title: "Codex", command: "bunx", args: ["@agentclientprotocol/codex-acp@latest"] },
    ] as any);
    turnRegistry.create("t1", { agentId: "codex", sessionId: "s1" });
    const response = await post("/codex/refresh-login");
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("运行中的对话");
  });

  it("refreshes the app-owned Codex home and reconnects", async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "codex-src-"));
    const target = path.join(home, "codex-home");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(source, "auth.json"), '{"token":"fresh"}');
    fs.writeFileSync(path.join(target, "auth.json"), '{"token":"stale"}');
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    fs.utimesSync(path.join(target, "auth.json"), older, older);
    fs.utimesSync(path.join(source, "auth.json"), newer, newer);

    vi.spyOn(universalRegistry, "listProfiles").mockReturnValue([
      { id: "codex", name: "codex", title: "Codex", command: "bunx", args: ["@agentclientprotocol/codex-acp@latest"] },
    ] as any);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue({});
    const status = vi.fn().mockReturnValue({ connected: true });
    vi.spyOn(universalRegistry, "connFor").mockReturnValue({ disconnect, connect, status } as any);
    vi.stubEnv("CODEX_HOME", source);

    try {
      const response = await post("/codex/refresh-login");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.refreshed.auth).toBe(true);
      expect(fs.readFileSync(path.join(target, "auth.json"), "utf8")).toBe('{"token":"fresh"}');
      expect(disconnect).toHaveBeenCalled();
      expect(connect).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(source, { recursive: true, force: true });
    }
  });
});
