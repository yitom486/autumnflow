/**
 * Universal ACP gateway routes (/api/universal/*), composed from Hono
 * sub-routers by feature (server/universal/http/*):
 *
 *   /agents/*                 agents.ts       profiles + connection lifecycle
 *   /agents/:id/session/*     sessions.ts     ACP session RPCs
 *   /permission/*, /elicitation/*  interactions.ts
 *   /chat                     chat.ts         prompt turn as SSE
 *   /workspace/*              workspace.ts    default / validate / files / read
 *   /terminal/*               terminal.ts     pty status/resize, one-shot exec
 *   /git/*                    git.ts          status / file / stage / restore
 *
 * Request bodies are schema-validated (zod, see http/shared.ts::jsonBody);
 * malformed JSON → 400 instead of silently continuing with `{}`.
 *
 * Auth and CORS come from a *static* import of ./security: if it fails to load
 * the gateway does not start (fail closed). Every request needs the gateway
 * token — handleUniversal enforces it itself (defense in depth), in addition
 * to the check in server/gateway.ts.
 */
import { Hono } from "hono";
import { corsHeaders, requireAuth } from "./security";
import { json } from "./http/shared";
import { agentsRouter } from "./http/agents";
import { sessionsRouter } from "./http/sessions";
import { interactionsRouter } from "./http/interactions";
import { chatRouter } from "./http/chat";
import { activeWorkRouter } from "./http/active-work";
import { workspaceRouter } from "./http/workspace";
import { terminalRouter } from "./http/terminal";
import { filesRouter } from "./http/files";
import { gitRouter } from "./http/git";
import { searchRouter } from "./http/search";
import { getMcpUiServerInfo } from "./mcp-ui-server";

export { gatewayErrorBody } from "./http/shared";
export type { GitFileChange } from "./http/git";

const universal = new Hono().basePath("/api/universal");

universal.use("*", async (c, next) => {
  // CORS preflight carries no credentials and performs no action.
  if (c.req.method === "OPTIONS") return new Response(null, { status: 204 });
  const denied = requireAuth(c.req.raw);
  if (denied) return denied;
  await next();
});

universal.route("/agents", agentsRouter);
universal.route("/agents", sessionsRouter);
universal.route("/", interactionsRouter);
universal.route("/chat", chatRouter);
universal.route("/active-work", activeWorkRouter);
universal.route("/workspace", workspaceRouter);
universal.route("/terminal", terminalRouter);
universal.route("/git", gitRouter);
universal.route("/search", searchRouter);
universal.route("/fs", filesRouter);
universal.get("/mcp-info", () => json({ ok: true, info: getMcpUiServerInfo() }));

universal.notFound((c) => json({ ok: false, error: `Unknown universal route ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));

universal.onError((err) => {
  console.error("[Universal] route error:", err);
  return json({ ok: false, error: err?.message || "universal gateway error" }, 500);
});

/** Echo trusted local Origin per request (never `*`). */
function withCors(res: Response, req: Request): Response {
  for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
  return res;
}

/**
 * Universal ACP gateway entry. Returns null when the path is not universal
 * (lets server/gateway.ts fall through to static files).
 */
export async function handleUniversal(req: Request): Promise<Response | null> {
  if (!new URL(req.url).pathname.startsWith("/api/universal")) return null;
  const res = await universal.fetch(req);
  return withCors(res, req);
}
