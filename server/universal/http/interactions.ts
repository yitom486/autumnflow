/**
 * /api/universal/permission/* and /api/universal/elicitation/* — pending
 * agent → client requests (permission prompts, form/url elicitations) and
 * the user's responses.
 */
import { Hono } from "hono";
import { z } from "zod";
import { RequestError } from "@agentclientprotocol/sdk";
import { universalRegistry } from "../registry";
import { json, jsonBody, optId, optStr } from "./shared";

export const interactionsRouter = new Hono();

/** Collect pending items across one agent (agentId=) or all known agents. */
function collectPending(agentId: string | undefined, pick: (id: string) => unknown[]): unknown[] {
  const out: unknown[] = [];
  const ids = agentId ? [agentId] : universalRegistry.listProfiles().map((a) => a.id);
  for (const id of ids) {
    try {
      out.push(...pick(id));
    } catch (err) {
      // Unknown agent id: nothing pending for it (listing must not fail as a whole).
      console.debug(`[Universal] pending lookup skipped ${id}: ${(err as Error).message}`);
    }
  }
  return out;
}

interactionsRouter.get("/permission/pending", (c) => {
  const sessionId = c.req.query("sessionId") || undefined;
  const pending = collectPending(c.req.query("agentId") || undefined, (id) =>
    universalRegistry.connFor(id).listPendingPermissions(sessionId)
  );
  return json({ ok: true, pending });
});

const permissionRespondBody = z.looseObject({ agentId: optStr, permissionId: optId, outcome: z.unknown().optional() });

interactionsRouter.post("/permission/respond", jsonBody(permissionRespondBody), (c) => {
  const body = c.get("body");
  const agentId = String(body.agentId || "");
  const permissionId = String(body.permissionId || "");
  if (!agentId || !permissionId) return json({ ok: false, error: "agentId + permissionId required" }, 400);
  try {
    const ok = universalRegistry.connFor(agentId).resolvePermission(permissionId, body.outcome ?? body);
    if (!ok) return json({ ok: false, error: "permission not found or expired" }, 404);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, err instanceof RequestError ? 400 : 500);
  }
});

interactionsRouter.get("/elicitation/pending", (c) => {
  const sessionId = c.req.query("sessionId") || undefined;
  const pending = collectPending(c.req.query("agentId") || undefined, (id) =>
    universalRegistry.connFor(id).listPendingElicitations(sessionId)
  );
  return json({ ok: true, pending });
});

const elicitationRespondBody = z.looseObject({
  agentId: optStr,
  elicitationId: optId,
  result: z.unknown().optional(),
  response: z.unknown().optional(),
});

interactionsRouter.post("/elicitation/respond", jsonBody(elicitationRespondBody), (c) => {
  const body = c.get("body");
  const agentId = String(body.agentId || "");
  const elicitationId = String(body.elicitationId || "");
  if (!agentId || !elicitationId) return json({ ok: false, error: "agentId + elicitationId required" }, 400);
  try {
    const ok = universalRegistry.connFor(agentId).resolveElicitation(elicitationId, body.result ?? body.response ?? body);
    if (!ok) return json({ ok: false, error: "elicitation not found or expired" }, 404);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, err instanceof RequestError ? 400 : 500);
  }
});
