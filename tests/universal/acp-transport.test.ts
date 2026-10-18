// @vitest-environment node
/**
 * Transport invariants that do not need a child process. Anything involving a
 * real agent process is covered by mcp-integration-mock-agent.test.ts.
 */
import { describe, it, expect } from "vitest";
import { AcpTransport } from "../../server/universal/acp-transport";
import type { AgentProfile } from "../../server/universal/types";

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  id: "transport-test",
  name: "Transport Test",
  command: "true",
  args: [],
  ...overrides,
});

describe("AcpTransport (no process)", () => {
  it("starts disconnected and refuses to hand out a connection", () => {
    const transport = new AcpTransport(() => profile());
    expect(transport.connected).toBe(false);
    expect(transport.pid).toBeNull();
    expect(transport.init).toBeNull();
    expect(transport.connectionOrNull()).toBeNull();
    expect(() => transport.ensureConnection()).toThrow(/not connected/);
  });

  it("resolves the profile per use so registry env overrides stay live", () => {
    let current = profile();
    const transport = new AcpTransport(() => current);
    expect(transport.profile.id).toBe("transport-test");

    current = profile({ id: "renamed", env: { ACP_TENANT: "b" } });
    expect(transport.profile.id).toBe("renamed");
    expect(transport.profile.env).toEqual({ ACP_TENANT: "b" });
  });

  it("treats stopping a never-started transport as clean", async () => {
    const transport = new AcpTransport(() => profile());
    await expect(transport.stop()).resolves.toBe(true);
    expect(transport.connected).toBe(false);
  });

  it("remembers the last error for status reporting", () => {
    const transport = new AcpTransport(() => profile());
    transport.setError("initialize failed: boom");
    expect(transport.lastError).toBe("initialize failed: boom");
    transport.setError(null);
    expect(transport.lastError).toBeNull();
  });
});
