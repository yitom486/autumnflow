// @vitest-environment node
/**
 * Session-level code mode: the gateway forwards the client's request as
 * `_meta.toolsMode` on session/new, but only when the agent advertises (or is a
 * legacy) PTC presentation. The agent then builds its code-mode SDK from every
 * visible tool, including the MCP servers mounted for that session.
 */
import { describe, it, expect } from "vitest";
import { SessionService } from "../../server/universal/session-service";

interface Harness {
  service: SessionService;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
}

function harness(capabilities: Record<string, unknown>, agentId = "deepseek"): Harness {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const connection = {
    agent: {
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        return { sessionId: "session-1", configOptions: [] };
      },
    },
  };
  const service = new SessionService({
    profile: () => ({ id: agentId, name: agentId, command: "true", args: [] }) as never,
    ensureConnection: () => connection as never,
    init: () => ({ agentCapabilities: capabilities }) as never,
    state: {
      turnCounts: new Map(),
      childParents: new Map(),
      childUpdates: new Map(),
      childStates: new Map(),
      sinks: new Map(),
      commands: new Map(),
      terminalOwners: new Map(),
      releasedTerminals: new Map(),
      drop: () => {},
    } as never,
    resources: {
      configuredMcpServers: () => [],
      sessionMeta: () => undefined,
      rememberSession: () => {},
      forgetSession: () => {},
    } as never,
    fsGuard: {
      sessionRootsFor: () => [],
      rememberSessionRoots: () => {},
    } as never,
    subscribe: () => () => {},
  });
  return { service, requests };
}

describe("session code mode", () => {
  it("declared ptc: requests _meta.toolsMode on session/new", async () => {
    const { service, requests } = harness({ _meta: { toolsMode: { values: ["native", "ptc"] } } });
    await service.newSession({ cwd: "/tmp", codeMode: "on" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("session/new");
    expect((requests[0]!.params as { _meta?: Record<string, unknown> })._meta?.toolsMode).toBe("ptc");
  });

  it("declared native-only is never upgraded", async () => {
    const { service, requests } = harness({ _meta: { toolsMode: { values: ["native"] } } });
    await service.newSession({ cwd: "/tmp", codeMode: "on" });
    expect((requests[0]!.params as { _meta?: Record<string, unknown> })._meta).toBeUndefined();
  });

  it("an agent without the declaration gets no _meta", async () => {
    const { service, requests } = harness({}, "codex-acp");
    await service.newSession({ cwd: "/tmp", codeMode: "on" });
    expect((requests[0]!.params as { _meta?: Record<string, unknown> })._meta).toBeUndefined();
  });

  it("codeMode off sends no _meta extension", async () => {
    const { service, requests } = harness({ _meta: { toolsMode: { values: ["native", "ptc"] } } });
    await service.newSession({ cwd: "/tmp" });
    expect((requests[0]!.params as { _meta?: Record<string, unknown> })._meta).toBeUndefined();
  });
});
