/**
 * Read-only active-work inspection for the native quit/update guard.
 * Counts running prompt turns, live terminal PTYs, pending permissions /
 * elicitations and active subagents. Never returns tool output or file bodies.
 */
import { Hono } from "hono";
import { json } from "./shared";
import { turnRegistry } from "../turn-registry";
import { universalRegistry } from "../registry";
import { listPtySessions } from "../pty";

export const activeWorkRouter = new Hono();

activeWorkRouter.get("/", (c) => {
  const turns = turnRegistry.listRunning().map((turn) => ({
    turnId: turn.id,
    agentId: turn.agentId,
    sessionId: turn.sessionId,
    ageMs: Date.now() - turn.createdAt,
  }));
  const connections = universalRegistry.listConnections().map((conn) => conn.inspectActiveWork());
  const permissions = connections.flatMap((work) =>
    work.permissions.map((permission) => ({
      agentId: work.agentId,
      sessionId: permission.sessionId,
      permissionId: permission.permissionId,
      title: String((permission.toolCall as any)?.title || (permission.toolCall as any)?.name || ""),
    }))
  );
  const elicitations = connections.flatMap((work) =>
    work.elicitations.map((elicitation) => ({
      agentId: work.agentId,
      sessionId: elicitation.sessionId,
      elicitationId: elicitation.elicitationId,
      message: elicitation.message,
    }))
  );
  const subagents = connections.flatMap((work) =>
    work.subagents.map((subagent) => ({ agentId: work.agentId, ...subagent }))
  );
  const ptys = listPtySessions()
    .filter((pty) => !pty.exited)
    .map((pty) => ({ id: pty.id, cwd: pty.cwd, attached: pty.attached, grace: pty.grace }));

  const count = turns.length + ptys.length + permissions.length + elicitations.length + subagents.length;
  const summary = [
    turns.length ? `${turns.length} 个运行中的对话轮次` : "",
    ptys.length ? `${ptys.length} 个终端` : "",
    permissions.length ? `${permissions.length} 个待确认权限` : "",
    elicitations.length ? `${elicitations.length} 个待填写请求` : "",
    subagents.length ? `${subagents.length} 个子任务` : "",
  ].filter(Boolean).join("、");

  return json({
    ok: true,
    count,
    summary,
    active: { turns, ptys, permissions, elicitations, subagents },
  });
});
