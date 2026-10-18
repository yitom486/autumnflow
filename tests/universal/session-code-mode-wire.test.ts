// @vitest-environment node
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { UniversalAgentConnection } from "../../server/universal/AgentConnection";

const fixturePath = path.resolve(__dirname, "../fixtures/mock-acp-agent.ts");

function connect(env?: Record<string, string>): UniversalAgentConnection {
  return new UniversalAgentConnection({
    id: "mock-code-mode",
    name: "Mock Code Mode",
    command: process.platform === "win32" ? "bun.exe" : "bun",
    args: ["run", fixturePath],
    ...(env ? { env } : {}),
  } as never);
}

async function inspect(conn: UniversalAgentConnection): Promise<Record<string, any>> {
  const session = (await conn.newSession({ cwd: process.cwd(), codeMode: "on" })) as { sessionId: string };
  const updates: any[] = [];
  await conn.prompt(session.sessionId, [{ type: "text", text: "trigger_inspect_session" }], (evt: any) => {
    if (evt.type === "update") updates.push(evt.update);
  });
  const chunk = updates.find((update) => update.sessionUpdate === "agent_message_chunk");
  if (!chunk) throw new Error("mock agent did not return the inspect payload");
  return JSON.parse(chunk.content.text);
}

describe("session-level code mode over the wire", () => {
  it("sends _meta.toolsMode=ptc when the agent declares ptc", async () => {
    const conn = connect();
    await conn.connect();
    try {
      const parsed = await inspect(conn);
      expect(parsed.meta?.toolsMode).toBe("ptc");
    } finally {
      await conn.disconnect().catch(() => undefined);
    }
  });

  it("sends no _meta when the agent does not declare code mode", async () => {
    const conn = connect({ MOCK_TOOLS_MODE: "0" });
    await conn.connect();
    try {
      const parsed = await inspect(conn);
      expect(parsed.meta?.toolsMode).toBeUndefined();
    } finally {
      await conn.disconnect().catch(() => undefined);
    }
  });
});
