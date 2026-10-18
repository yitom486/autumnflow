/**
 * Runtime-agnostic HTTP gateway (Bun.serve AND Node/Hono compatible).
 * All routes speak WinterCG Request/Response only — no Bun.* / node:http APIs.
 * Entries: server/index.ts (Bun) and server/node.ts (Node, for Electron).
 */
import { Hono } from "hono";
import { handleUniversal } from "./universal/routes";
import { universalRegistry } from "./universal/registry";
import { corsHeaders as secureCorsHeaders, ensureGatewayToken, gatewaySessionCookie, requireAuth } from "./universal/security";
import { resolveRuntimeConfig } from "../shared/runtime-config";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { staticFileResponse } from "./static-files";
import { stopMcpUiServer } from "./universal/mcp-ui-server";

export function setupEnv() {  // 生成/复用网关 token 并注入进程环境，同一机器前后端共享（详见 universal/security.ts）。
  const token = ensureGatewayToken();
  if (!process.env.ACP_GATEWAY_TOKEN) process.env.ACP_GATEWAY_TOKEN = token;

  // 确保在 Linux / WSL 环境下，PATH 始终优先包含 ~/.bun/bin 和 ~/.local/bin，
  // 避免子进程穿透到 Windows 挂载过来的 /mnt/c/... 中的 node.exe / npx 造成极端慢速与跨系统问题。
  if (process.platform === "linux") {
    const home = os.homedir();
    const bunBin = path.join(home, ".bun", "bin");
    const localBin = path.join(home, ".local", "bin");
    const existing = process.env.PATH || "";
    const parts = existing.split(path.delimiter);
    const toAdd = [bunBin, localBin, "/usr/local/bin"].filter((p) => !parts.includes(p) && fs.existsSync(p));
    if (toAdd.length > 0) {
      process.env.PATH = [...toAdd, existing].join(path.delimiter);
    }
  }
}

const runtime = resolveRuntimeConfig();
export const PORT = runtime.gatewayPort;
export const HOST = runtime.host;
export const MCP_PORT = runtime.mcpPort;

process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught exception:", err);
});

console.log("[Server] Initializing Universal ACP Studio Gateway...");

/**
 * 受限 CORS（re-export，唯一实现在 universal/security.ts，避免循环依赖：
 * security.ts 不导入 gateway.ts）。不再返回 `*`，只回显可信本地 Origin。
 * 保留无参调用兼容（无请求时不设 Allow-Origin）。
 */
export function corsHeaders(req?: Request): Record<string, string> {
  return secureCorsHeaders(req);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** Attach the HttpOnly local-desktop session cookie to HTML responses. */
function withDesktopSession(res: Response): Response {
  if (res.status !== 200) return res;
  const headers = new Headers(res.headers);
  headers.append("Set-Cookie", gatewaySessionCookie());
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function buildApp() {
  const app = new Hono();

  // Universal ACP gateway (generic stdio agents: codex, gemini, claude, ...)
  app.all("/api/universal/*", async (c) => {
    // CORS 预检不带凭证、也不执行任何动作：只回 CORS 头（真正的请求照样要 token）。
    if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(c.req.raw) });
    // 先鉴权再进路由：401 直接返回（已带 CORS 头），不触及 handleUniversal。
    const denied = requireAuth(c.req.raw);
    if (denied) return denied;
    try {
      const universal = await handleUniversal(c.req.raw);
      if (universal) return universal;
    } catch (err: any) {
      console.error("[Server] universal gateway error:", err);
      return Response.json({ ok: false, error: err?.message || "universal gateway error" }, { status: 500, headers: corsHeaders(c.req.raw) });
    }
    return c.text("Not Found", 404);
  });

  app.options("*", (c) => new Response(null, { headers: corsHeaders(c.req.raw) }));

  // Static frontend (production/Electron): serve the public dir, SPA fallback.
  // Runtime-agnostic fs read so Bun and Node share this path.
  // ACP_PUBLIC_DIR overrides the default ./dist (Electron sets it to the
  // packaged app dir since cwd is not reliable there).
  const publicDir = () =>
    process.env.ACP_PUBLIC_DIR || path.join(process.cwd(), "dist");
  app.get("*", (c) => {
    const DIST = publicDir();
    const reqPath = new URL(c.req.url).pathname;
    if (reqPath.startsWith("/api/")) {
      return new Response("Not Found", { status: 404, headers: corsHeaders(c.req.raw) });
    }
    const rel = path.normalize(reqPath === "/" ? "/index.html" : reqPath).replace(/^([/\\])+/, "");
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST)) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        const res = staticFileResponse(c.req.raw, file, rel, MIME[ext] || "application/octet-stream");
        return ext === ".html" ? withDesktopSession(res) : res;
      }
    } catch (err) {
      // 静态文件读取失败 → 回落 SPA index.html；此处 console.warn 留痕（loud 失败原则）。
      console.warn(`[Server] 静态文件读取失败，回落 index.html：${file}: ${(err as Error).message}`);
    }
    const index = path.join(DIST, "index.html");
    if (fs.existsSync(index)) {
      return withDesktopSession(staticFileResponse(c.req.raw, index, "index.html", "text/html; charset=utf-8"));
    }
    return new Response("Not Found", { status: 404, headers: corsHeaders(c.req.raw) });
  });

  return app;
}

export async function shutdownBridges() {
  // Let agents release their MCP connections before stopping the shared listener.
  await universalRegistry.shutdown().catch((err) => {
    console.warn(`[Server] 关闭 agent 桥接失败：${(err as Error)?.message || err}`);
  });
  await stopMcpUiServer().catch((err) => {
    console.warn(`[Server] 关闭 MCP UI 服务失败: ${(err as Error)?.message || err}`);
  });
}
