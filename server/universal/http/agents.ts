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
import { readDeepseekCredentialState, saveDeepseekApiKey } from "../runtimes/deepseek-credentials";
import { isCodexProfile, provisionCodexCodeModeHome } from "../codex-code-mode-home";
import { turnRegistry } from "../turn-registry";
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

/**
 * DeepSeek 凭据：ACP 没有“写凭据”的方法（DSH 的 authMethods 为空），所以这里
 * 补一个受网关鉴权保护的入口，写入 DSH 自己的 user-env 层（`$DSH_HOME/.env`），
 * 由 DSH 在下次 spawn 时读取。托管凭据仓库优先级更高，不会被这里覆盖。
 */
agentsRouter.get("/:agentId/credentials", (c) => {
  const agentId = c.req.param("agentId");
  if (agentId !== "deepseek") return json({ ok: false, error: "该智能体不支持在客户端配置凭据" }, 400);
  try {
    return json({ ok: true, ...readDeepseekCredentialState() });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});

const credentialsBody = z.looseObject({ apiKey: z.string().min(1).max(512) });
agentsRouter.post("/:agentId/credentials", jsonBody(credentialsBody), (c) => {
  const agentId = c.req.param("agentId");
  if (agentId !== "deepseek") return json({ ok: false, error: "该智能体不支持在客户端配置凭据" }, 400);
  const body = c.get("body") as { apiKey: string };
  try {
    const state = saveDeepseekApiKey(body.apiKey);
    return json({ ok: true, ...state, restartRequired: true });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 400);
  }
});

/** 让新写入的环境变量生效：先断开再重连；有运行中的轮次时拒绝。 */
agentsRouter.post("/:agentId/reconnect", async (c) => {
  const agentId = c.req.param("agentId");
  try {
    const running = turnRegistry.listRunning().filter((turn) => turn.agentId === agentId);
    if (running.length > 0) {
      return json({ ok: false, error: `该智能体还有 ${running.length} 个运行中的对话，结束或取消后再重连` }, 409);
    }
    const conn = universalRegistry.connFor(agentId);
    await conn.disconnect().catch((err: Error) => console.debug(`[agents] reconnect disconnect failed ${agentId}:`, err));
    await conn.connect();
    return json({ ok: true, status: conn.status() });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});

/**
 * 把本机的登录态重新同步给应用，然后重连。
 *
 * Codex 跑在应用独占的 CODEX_HOME 上；用户在 Codex CLI 里重新登录后，应用
 * 里的那份副本可能还是旧的。刷新会按 mtime 重新复制本机的 auth.json /
 * config.toml，再重连让 Agent 用上新登录态。
 */
agentsRouter.post("/:agentId/refresh-login", async (c) => {
  const agentId = c.req.param("agentId");
  const profile = universalRegistry.listProfiles().find((item) => item.id === agentId);
  if (!profile) return json({ ok: false, error: `未知智能体 ${agentId}` }, 404);
  if (!isCodexProfile(profile)) {
    return json({ ok: false, error: "该智能体直接复用本机登录态，无需刷新" }, 400);
  }
  try {
    const running = turnRegistry.listRunning().filter((turn) => turn.agentId === agentId);
    if (running.length > 0) {
      return json({ ok: false, error: `该智能体还有 ${running.length} 个运行中的对话，结束或取消后再刷新` }, 409);
    }
    const home = await provisionCodexCodeModeHome();
    for (const warning of home.warnings) console.warn(`[agents] codex home: ${warning}`);
    const conn = universalRegistry.connFor(agentId);
    await conn.disconnect().catch((err: Error) => console.debug(`[agents] refresh-login disconnect failed ${agentId}:`, err));
    await conn.connect();
    return json({
      ok: true,
      status: conn.status(),
      refreshed: { auth: home.authCopied, config: home.configCopied },
      home: home.home,
    });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
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
