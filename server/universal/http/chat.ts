/**
 * POST /api/universal/chat — one prompt turn streamed back as SSE.
 * Creates a session on demand (no sessionId), forwards client disconnects
 * into the agent turn (cancel), and maps same-session concurrency to an
 * `error` event with code 409 (HTTP status is already sent once SSE starts).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { sdkValue } from "../acp-sdk";
import { universalRegistry } from "../registry";
import { gatewayError, json, jsonBody, optStr } from "./shared";

/** Normalize frontend prompt into ACP ContentBlock[] */
function normalizePrompt(input: unknown): ContentBlock[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (Array.isArray(input)) {
    return input.map((b) => {
      if (typeof b === "string") return { type: "text", text: b };
      return sdkValue<ContentBlock>("ContentBlock", b);
    });
  }
  if (input && typeof input === "object") return [sdkValue<ContentBlock>("ContentBlock", input)];
  return [{ type: "text", text: String(input ?? "") }];
}

const chatBody = z.looseObject({
  agentId: optStr,
  sessionId: optStr,
  prompt: z.unknown().optional(),
  cwd: optStr,
  mcpServers: z.array(z.unknown()).nullish(),
  additionalDirectories: z.array(z.string()).nullish(),
});

export const chatRouter = new Hono();

chatRouter.post("/", jsonBody(chatBody), async (c) => {
  const body = c.get("body") as Record<string, unknown>;
  const agentId = String(body.agentId || "codex");
  let conn;
  try {
    conn = universalRegistry.connFor(agentId);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 404);
  }

  try {
    await conn.connect();
  } catch (err) {
    return gatewayError(err, `Agent '${agentId}' connect failed`);
  }

  let sessionId = (body.sessionId as string) || "";
  if (!sessionId) {
    try {
      const fresh = (await conn.newSession({
        cwd: body.cwd as string | undefined,
        mcpServers: (body.mcpServers as unknown[]) || [],
        additionalDirectories: body.additionalDirectories as string[] | undefined,
      })) as { sessionId?: string };
      sessionId = fresh.sessionId || "";
    } catch (err) {
      console.error("[chat.ts session/new failed]", err);
      return gatewayError(err, "session/new failed");
    }
  }
  if (!sessionId) {
    console.error("[chat.ts sessionId missing]", body);
    return json({ ok: false, error: "sessionId missing and session/new returned none" }, 500);
  }

  let promptBlocks: ContentBlock[];
  try { promptBlocks = normalizePrompt(body.prompt); } catch (err) { return gatewayError(err); }

  // Client-disconnect propagation: forward req.signal into conn.prompt()
  // so a closed SSE stream cancels the in-flight turn server-side.
  const aborter = new AbortController();
  const reqSignal = c.req.raw.signal as AbortSignal | undefined;
  let onReqAbort: (() => void) | undefined;
  try {
    if (reqSignal) {
      if (reqSignal.aborted) {
        aborter.abort();
      } else {
        onReqAbort = () => {
          try {
            aborter.abort();
          } catch (err) {
            console.error(`[Universal] chat abort forward failed: ${(err as Error).message}`);
          }
        };
        reqSignal.addEventListener("abort", onReqAbort, { once: true });
      }
    }
  } catch (err) {
    console.error(`[Universal] chat signal wiring failed: ${(err as Error).message}`);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch (err) {
          console.error(`[Universal] SSE enqueue failed (closed?): ${(err as Error).message}`);
        }
      };
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          // controller closed mid-keepalive: stop silently, close handled below
        }
      }, 2000);

      send({ type: "start", agentId, sessionId });
      try {
        const res = (await conn.prompt(
          sessionId,
          promptBlocks,
          (evt) => {
            send({ ...evt, agentId, sessionId: (evt.sessionId as string) || sessionId });
          },
          { signal: aborter.signal }
        )) as { stopReason?: string } | undefined;
        send({ type: "done", agentId, sessionId, stopReason: res?.stopReason || "end_turn", response: res, quota: conn.status().quota });
      } catch (err) {
        const msg = (err as Error).message || "prompt failed";
        // Mutex: same-session concurrent prompt() throws `... (409)` in
        // AgentConnection; surface as error event with code 409 so the
        // frontend can serialize (routes can't return HTTP 409 once SSE
        // headers are sent).
        const busy = /session busy.*\(409\)/i.test(msg);
        if (busy) {
          console.warn(`[Universal] chat rejected busy session=${sessionId}`);
        } else {
          console.error(`[Universal] chat prompt failed session=${sessionId}: ${msg}`);
        }
        send({ type: "error", agentId, sessionId, message: msg, ...(busy ? { code: 409 } : {}) });
      } finally {
        clearInterval(ping);
        try {
          if (onReqAbort && reqSignal) reqSignal.removeEventListener("abort", onReqAbort);
        } catch (err) {
          console.error(`[Universal] chat signal cleanup failed: ${(err as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 50));
        try {
          controller.close();
        } catch (err) {
          console.error(`[Universal] SSE close failed: ${(err as Error).message}`);
        }
      }
    },
    cancel() {
      try {
        aborter.abort();
      } catch (err) {
        console.error(`[Universal] SSE cancel abort failed: ${(err as Error).message}`);
      }
      try {
        conn.cancel(sessionId).catch((err: Error) => {
          console.error(`[Universal] SSE cancel session=${sessionId} failed: ${err.message}`);
        });
      } catch (err) {
        console.error(`[Universal] SSE cancel threw: ${(err as Error).message}`);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
