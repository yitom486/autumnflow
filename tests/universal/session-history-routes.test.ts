// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionsRouter } from "../../server/universal/http/sessions";
import { universalRegistry } from "../../server/universal/registry";
import { studioSessions } from "../../server/universal/session-index";

afterEach(() => vi.restoreAllMocks());
function request(action: string, body = {}) {
  return sessionsRouter.request(`http://localhost/opencode/session/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
describe("managed conversation routes", () => {
  it("lists owned main sessions offline without requesting all agent history", async () => {
    studioSessions.remember("opencode", "ours", "created", { title: "Owned" });
    studioSessions.linkChild("opencode", "ours", "child", "Explore");
    const connect = vi.fn(); const listSessions = vi.fn();
    vi.spyOn(universalRegistry, "connFor").mockReturnValue({ connect, listSessions } as any);
    const response = await request("history");
    expect((await response.json()).result.sessions.map((row: any) => row.sessionId)).toEqual(["ours"]);
    expect(connect).not.toHaveBeenCalled(); expect(listSessions).not.toHaveBeenCalled();
  });
  it("refreshes Agent-provided titles for an already-connected agent", async () => {
    studioSessions.remember("opencode", "titled", "created", { cwd: "D:/app" });
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    vi.spyOn(universalRegistry, "connFor").mockReturnValue({ connected: true, listSessions } as any);
    await request("history");
    expect(listSessions).toHaveBeenCalledWith({});
  });
  it("imports a selected reference and refuses to promote or resume a known child", async () => {
    const connect = vi.fn();
    vi.spyOn(universalRegistry, "connFor").mockReturnValue({ connect } as any);
    const imported = await request("import", { sessionId: "selected-external", cwd: "D:/app", title: "External" });
    expect((await imported.json()).result.origin).toBe("imported");
    studioSessions.linkChild("opencode", "selected-external", "delegated");
    expect((await (await request("import", { sessionId: "delegated" })).json()).ok).toBe(false);
    expect((await (await request("resume", { sessionId: "delegated" })).json()).error).toContain("只读");
    expect(connect).not.toHaveBeenCalled();
  });
  it("inspects children separately without loading or resuming the parent", async () => {
    const connect = vi.fn().mockResolvedValue({});
    const loadSession = vi.fn(); const resumeSession = vi.fn();
    const viewChild = vi.fn().mockResolvedValue({ replayed: [], source: "live" });
    vi.spyOn(universalRegistry, "connFor").mockReturnValue({ connect, loadSession, resumeSession, viewChild } as any);
    const result = await request("view-child", { sessionId: "delegated" });
    expect((await result.json()).result.source).toBe("live");
    expect(viewChild).toHaveBeenCalledWith("delegated");
    expect(loadSession).not.toHaveBeenCalled(); expect(resumeSession).not.toHaveBeenCalled();
  });
});
