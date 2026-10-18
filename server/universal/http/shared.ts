/**
 * Shared helpers for the universal gateway sub-routers (server/universal/http/*).
 *
 * - `json()`: plain JSON Response. CORS headers are added once at the
 *   handleUniversal exit (server/universal/routes.ts), per request.
 * - `jsonBody(schema)`: request-body middleware. Empty body → `{}` (several
 *   POST endpoints are called without a body); malformed JSON or a body that
 *   fails the schema → 400 with the reason. Replaces the old `readJson` that
 *   swallowed parse errors and continued with `{}` (no-silent-fallbacks.md).
 * - Schemas are deliberately loose (`z.looseObject`): known fields are type
 *   checked, unknown fields pass through untouched because several routes
 *   forward the whole body to the agent (session/load, resume, providers …).
 */
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { isAuthRequiredError, acpErrorCode } from "../errors";

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export type BodyEnv<T> = { Variables: { body: T } };

export function jsonBody<S extends z.ZodType>(schema: S) {
  return createMiddleware<BodyEnv<z.infer<S>>>(async (c, next) => {
    let raw: string;
    try {
      raw = await c.req.text();
    } catch (err) {
      return json({ ok: false, error: `failed to read request body: ${(err as Error).message}` }, 400);
    }
    let data: unknown = {};
    if (raw.trim()) {
      try {
        data = JSON.parse(raw);
      } catch (err) {
        return json({ ok: false, error: `invalid JSON body: ${(err as Error).message}` }, 400);
      }
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      return json({ ok: false, error: `invalid request body: ${z.prettifyError(parsed.error)}` }, 400);
    }
    c.set("body", parsed.data);
    await next();
  });
}

/** Optional string that tolerates `null` (frontend sometimes sends null for "unset"). */
export const optStr = z.string().nullish();
/** Optional id: pending permission / elicitation ids may be JSON-RPC numbers. */
export const optId = z.union([z.string(), z.number()]).nullish();
/** Loose JSON object body. */
export const anyBody = z.looseObject({});

/**
 * Normalize an ACP/agent failure into a gateway error response.
 * Auth failures become 401 + authRequired so the UI can open the
 * auth flow without sniffing message text.
 */
export function gatewayErrorBody(err: unknown): { status: number; body: Record<string, unknown> } {
  const rawMsg = err instanceof Error ? err.message : String(err ?? "request failed");
  const message = (rawMsg && rawMsg !== "null" && rawMsg !== "undefined") ? rawMsg : "request failed";
  const code = acpErrorCode(err);
  const authRequired = isAuthRequiredError(err);
  return {
    status: authRequired ? 401 : code === -32602 ? 400 : code === -32601 ? 501 : 500,
    body: { ok: false, error: message, authRequired, ...(code !== null ? { code } : {}) },
  };
}

export function gatewayError(err: unknown, prefix?: string): Response {
  const { status, body } = gatewayErrorBody(err);
  if (prefix) body.error = `${prefix}: ${body.error}`;
  return json(body, status);
}
