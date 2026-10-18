// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { activeWorkRouter } from "../../server/universal/http/active-work";
import { turnRegistry } from "../../server/universal/turn-registry";

afterEach(() => turnRegistry.resetForTest());

describe("active work inspection", () => {
  it("reports nothing when idle", async () => {
    const res = await activeWorkRouter.request("http://localhost/");
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.count).toBe(0);
    expect(body.active.turns).toEqual([]);
  });

  it("reports a running turn without exposing its payload", async () => {
    turnRegistry.create("turn-active", { agentId: "opencode", sessionId: "ses_1" });
    turnRegistry.append("turn-active", { type: "start", prompt: "secret prompt" });
    const res = await activeWorkRouter.request("http://localhost/");
    const body: any = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.active.turns[0]).toMatchObject({
      turnId: "turn-active",
      agentId: "opencode",
      sessionId: "ses_1",
    });
    expect(JSON.stringify(body)).not.toContain("secret prompt");
    expect(body.summary).toContain("对话轮次");
  });
});
