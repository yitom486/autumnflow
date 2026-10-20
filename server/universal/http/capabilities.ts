/**
 * /api/universal/capabilities — what the agent can currently reach.
 *
 * Reports the studio-ui MCP server, the tools it exposes, the skills it
 * ships and the switches the user set. Toggling a tool takes effect at once
 * (the MCP server hides it from tools/list); toggling a skill applies to the
 * catalogue immediately and to the agent's own resource snapshot on the next
 * connect.
 */
import { Hono } from "hono";
import { z } from "zod";
import { universalRegistry } from "../registry";
import { json, jsonBody } from "./shared";
import { getMcpUiServerInfo, setStudioToolEnabled } from "../mcp-ui-server";
import { STUDIO_UI_TOOLS, getStudioToolDescriptor } from "../studio-tools";
import { listStudioSkills } from "../studio-skills";
import { readCapabilityState, setSkillEnabled, setToolEnabled } from "../capability-registry";

export const capabilitiesRouter = new Hono();

interface McpAgentCapabilities {
  http?: boolean;
  stdio?: boolean;
}

function agentMcpCapabilities(agentId: string | undefined): McpAgentCapabilities {
  if (!agentId) return {};
  try {
    const caps = universalRegistry.connFor(agentId).status().agentCapabilities as
      | { mcpCapabilities?: McpAgentCapabilities }
      | null;
    return caps?.mcpCapabilities ?? {};
  } catch {
    // An unknown or disconnected agent simply has no capabilities yet.
    return {};
  }
}

capabilitiesRouter.get("/", (c) => {
  const agentId = c.req.query("agentId") || undefined;
  const state = readCapabilityState();
  const server = getMcpUiServerInfo();
  const mcpCaps = agentMcpCapabilities(agentId);

  const tools = STUDIO_UI_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    summary: tool.summary,
    enabled: !state.disabledTools.includes(tool.name),
  }));

  const skills = listStudioSkills().map((skill) => ({
    name: skill.name,
    title: skill.title,
    description: skill.description,
    enabled: !state.disabledSkills.includes(skill.name),
  }));

  return json({
    ok: true,
    mcp: {
      server: server ? { name: server.name, url: server.url, port: server.port, running: true } : null,
      // What the connected agent says it can mount.
      agentSupports: { http: mcpCaps.http === true, stdio: mcpCaps.stdio === true },
      tools,
    },
    skills,
  });
});

const toolBody = z.looseObject({ name: z.string().min(1), enabled: z.boolean() });

capabilitiesRouter.post("/tool", jsonBody(toolBody), (c) => {
  const body = c.get("body");
  const name = body.name.trim();
  if (!getStudioToolDescriptor(name)) {
    return json({ ok: false, error: `Unknown studio-ui tool: ${name}` }, 404);
  }
  setToolEnabled(name, body.enabled);
  // Hide or show it for every live MCP session right away.
  setStudioToolEnabled(name, body.enabled);
  return json({ ok: true, name, enabled: body.enabled });
});

const skillBody = z.looseObject({ name: z.string().min(1), enabled: z.boolean() });

capabilitiesRouter.post("/skill", jsonBody(skillBody), (c) => {
  const body = c.get("body");
  const name = body.name.trim();
  if (!listStudioSkills().some((skill) => skill.name === name)) {
    return json({ ok: false, error: `Unknown studio skill: ${name}` }, 404);
  }
  setSkillEnabled(name, body.enabled);
  return json({ ok: true, name, enabled: body.enabled });
});
