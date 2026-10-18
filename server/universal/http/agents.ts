/**
 * /api/universal/agents/* — agent profiles and per-agent connection lifecycle
 * (connect / disconnect / status / authenticate / logout / providers /
 * empty-session cleanup). Session RPCs live in ./sessions.ts.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { TerminalOutputRequest } from "@agentclientprotocol/sdk";
import { sdkValue } from "../acp-sdk";
import { universalRegistry } from "../registry";
import { anyBody, gatewayError, json, jsonBody, optStr } from "./shared";
import { probeLiveAgyQuota } from "../runtimes/agy-quota";
import { studioSessions } from "../session-index";

export const agentsRouter = new Hono();

agentsRouter.get("/:agentId/terminal/:terminalId", (c) => {
  try {
    const params = sdkValue<TerminalOutputRequest>("TerminalOutputRequest", { terminalId: c.req.param("terminalId"), sessionId: c.req.query("sessionId") });
    const result = universalRegistry.connFor(c.req.param("agentId")).terminalDisplayOutput(params);
    return json({ ok: true, result });
  } catch (err) { return gatewayError(err); }
});

agentsRouter.post("/:agentId/authenticate/terminal/:ptyId/finish", async (c) => {
  try { await universalRegistry.connFor(c.req.param("agentId")).finishTerminalAuth(c.req.param("ptyId")); return json({ ok: true }); }
  catch (err) { return gatewayError(err); }
});
agentsRouter.delete("/:agentId/authenticate/terminal/:ptyId", (c) => {
  try { universalRegistry.connFor(c.req.param("agentId")).cancelTerminalAuth(c.req.param("ptyId")); return json({ ok: true }); }
  catch (err) { return gatewayError(err); }
});

agentsRouter.get("/", () => {
  const profiles = universalRegistry.listProfiles();
  const statuses = universalRegistry.statuses();
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return json({
    ok: true,
    agents: profiles.map((pr) => ({ ...pr, status: byId.get(pr.id) || { connected: false } })),
  });
});

const profileBody = z.looseObject({
  id: optStr,
  name: optStr,
  title: optStr,
  description: optStr,
  homepage: optStr,
  command: optStr,
  args: z.array(z.unknown()).nullish(),
  env: z.record(z.string(), z.string()).nullish(),
  defaultCwd: optStr,
  authHint: optStr,
  installHint: optStr,
});

agentsRouter.post("/", jsonBody(profileBody), (c) => {
  const body = c.get("body");
  try {
    const saved = universalRegistry.upsertProfile({
      id: String(body.id || ""),
      name: String(body.name || body.id || ""),
      title: String(body.title || body.id || ""),
      description: body.description ?? undefined,
      homepage: body.homepage ?? undefined,
      command: String(body.command || ""),
      args: Array.isArray(body.args) ? body.args.map(String) : [],
      env: body.env || {},
      defaultCwd: body.defaultCwd ?? undefined,
      authHint: body.authHint ?? undefined,
      installHint: body.installHint ?? undefined,
    });
    return json({ ok: true, agent: saved });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 400);
  }
});

agentsRouter.delete("/:agentId", (c) => {
  const agentId = c.req.param("agentId");
  const ok = universalRegistry.removeProfile(agentId);
  if (!ok) return json({ ok: false, error: "cannot remove built-in agent or unknown id" }, 400);
  return json({ ok: true, removed: agentId });
});

agentsRouter.post("/:agentId/connect", async (c) => {
  const agentId = c.req.param("agentId");
  try {
    const conn = universalRegistry.connFor(agentId);
    const init = await conn.connect();
    return json({ ok: true, status: conn.status(), init });
  } catch (err) {
    const st = universalRegistry.connFor(agentId).status();
    const rawMsg = err instanceof Error ? err.message : String(err ?? "");
    const error = (rawMsg && rawMsg !== "null" && rawMsg !== "undefined") ? rawMsg : (st.lastError || "Agent connection failed");
    return json({ ok: false, error, status: st }, 500);
  }
});

agentsRouter.post("/:agentId/disconnect", async (c) => {
  const agentId = c.req.param("agentId");
  try {
    await universalRegistry.connFor(agentId).disconnect();
  } catch (err) {
    console.error(`[Universal] disconnect failed ${agentId}: ${(err as Error).message}`);
  }
  return json({ ok: true, status: universalRegistry.connFor(agentId).status() });
});

agentsRouter.get("/:agentId/status", (c) => {
  try {
    const conn = universalRegistry.connFor(c.req.param("agentId"));
    return json({ ok: true, status: conn.status(), init: conn.getInitResult() });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 404);
  }
});

agentsRouter.get("/:agentId/quota", async (c) => {
  const agentId = c.req.param("agentId");
  try {
    if (agentId === "antigravity-stdio" || agentId === "agy") {
      const live = await probeLiveAgyQuota(agentId);
      if (live) {
        try {
          const conn = universalRegistry.connFor(agentId);
          (conn as any).lastQuota = live;
        } catch {}
        return json({ ok: true, quota: live });
      }
    }
    const conn = universalRegistry.connFor(agentId);
    const quota = await conn.probeQuotaBackground();
    return json({ ok: true, quota: quota || conn.status().quota });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 404);
  }
});

const authenticateBody = z.looseObject({ methodId: optStr, method: optStr });

agentsRouter.post("/:agentId/authenticate", jsonBody(authenticateBody), async (c) => {
  const body = c.get("body");
  const methodId = String(body.methodId || body.method || "");
  if (!methodId) return json({ ok: false, error: "methodId is required" }, 400);
  try {
    const { methodId: _m, method: _mm, ...extra } = body as Record<string, unknown>;
    const res = await universalRegistry.connFor(c.req.param("agentId")).authenticate(methodId, extra);
    return json({ ok: true, result: res });
  } catch (err) {
    return gatewayError(err);
  }
});

agentsRouter.post("/:agentId/logout", async (c) => {
  try {
    const res = await universalRegistry.connFor(c.req.param("agentId")).logout();
    return json({ ok: true, result: res });
  } catch (err) {
    return gatewayError(err);
  }
});

// UNSTABLE providers/* (e.g. codex): list / set / disable
agentsRouter.post("/:agentId/providers/:action{list|set|disable}", jsonBody(anyBody), async (c) => {
  const body = c.get("body");
  try {
    const conn = universalRegistry.connFor(c.req.param("agentId"));
    // Connect on demand; a real connect failure resurfaces from providersRpc below.
    await conn.connect().catch((err: Error) => {
      console.warn(`[Universal] providers connect failed (request will report it): ${err?.message || err}`);
    });
    const result = await conn.providersRpc(c.req.param("action") as "list" | "set" | "disable", body);
    return json({ ok: true, result });
  } catch (err) {
    return gatewayError(err);
  }
});

const emptySessionsBody = z.looseObject({
  exceptIds: z.array(z.unknown()).nullish(),
  maxAgeMs: z.number().nullish(),
});

agentsRouter.delete("/:agentId/sessions/empty", jsonBody(emptySessionsBody), async (c) => {
  // One-click cleanup of abandoned empty sessions across any connected agent.
  // Strict and loud: only rows marked as turn-less AND old AND unbound are
  // deleted; every skip/failure is reported, never silently swallowed.
  const agentId = c.req.param("agentId");
  try {
    const body = c.get("body");
    const exceptIds = Array.isArray(body.exceptIds) ? body.exceptIds.map(String) : [];
    const maxAgeMs = typeof body.maxAgeMs === "number" ? body.maxAgeMs : undefined;
    const { selectEmptySessions } = await import("../agent-installer");
    const conn = universalRegistry.connFor(agentId);
    // One-click must work even when disconnected: connect on demand
    // (idempotent — returns the live connection when already connected).
    await conn.connect();
    // Walk every page: session/list is keyset-paginated (50/page), and
    // the oldest abandoned rows live on the last pages.
    const sessions: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const listed: any = await conn.listSessions(cursor ? { cursor } : {});
      if (Array.isArray(listed?.sessions)) sessions.push(...listed.sessions);
      if (typeof listed?.nextCursor === "string" && listed.nextCursor) {
        cursor = listed.nextCursor;
      } else {
        break;
      }
    }
    const managed = new Set(studioSessions.list(agentId).filter(row => row.kind === "main").map(row => row.sessionId));
    const { deletable, kept } = selectEmptySessions(sessions.filter(row => managed.has(row.sessionId)), {
      exceptIds,
      ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
    });
    const deleted: string[] = [];
    const errors: Array<{ sessionId: string; error: string }> = [];
    for (const d of deletable) {
      try {
        await conn.deleteSession({ sessionId: d.sessionId });
        deleted.push(d.sessionId);
      } catch (err) {
        // Fall back to closeSession if agent does not implement delete
        try {
          await conn.closeSession({ sessionId: d.sessionId });
          deleted.push(d.sessionId);
        } catch (closeErr) {
          errors.push({ sessionId: d.sessionId, error: (err as Error).message });
        }
      }
    }
    return json({ ok: errors.length === 0, deleted, kept, errors });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
