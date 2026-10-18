/**
 * POST /api/universal/chat — one prompt turn streamed back as SSE.
 *
 * A turn is accepted at most once. The HTTP stream is only a subscriber to the
 * turn ledger: a dropped SSE can reconnect with the same turnId (and
 * Last-Event-ID) while the ACP prompt keeps running, and a late retry replays
 * the final answer instead of prompting the agent again.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { sdkValue } from "../acp-sdk";
import { universalRegistry } from "../registry";
import { getSessionJournal } from "../session-journal";
import { turnRegistry, type TurnRecord } from "../turn-registry";
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
  turnId: optStr,
  afterSeq: z.union([z.number(), z.string()]).nullish(),
});

export const chatRouter = new Hono();

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function parseAfterSeq(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Stream a turn from `afterSeq`, then follow it until terminal status. */
function streamTurn(record: TurnRecord, afterSeq: number): Response {
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let ping: ReturnType<typeof setInterval> | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        ping = null;
        try {
          controller.close();
        } catch (err) {
          console.error(`[chat.ts] SSE close failed turn=${record.id}: ${(err as Error).message}`);
        }
      };
      const send = (event: { seq: number; data: Record<string, unknown> }) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event.data)}\n\n`)
          );
        } catch (err) {
          // Client disconnected; the turn keeps running and remains replayable.
          closed = true;
          if (ping) clearInterval(ping);
          ping = null;
          console.debug(`[chat.ts] SSE client gone turn=${record.id}: ${(err as Error).message}`);
        }
      };
      const sendData = (data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
          if (ping) clearInterval(ping);
          ping = null;
        }
      };
      const plan = turnRegistry.replayPlan(record.id, afterSeq);
      if (plan.resetRequired) {
        sendData({
          type: "reset",
          turnId: record.id,
          reason: plan.reason || "gap",
          firstSeq: plan.firstSeq,
          lastSeq: plan.lastSeq,
        });
      }
      ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          closed = true;
          if (ping) clearInterval(ping);
          ping = null;
        }
      }, 2000);
      const unsubscribe = turnRegistry.subscribe(record.id, plan.from, send, close);
      cleanup = () => {
        unsubscribe();
        if (ping) clearInterval(ping);
        ping = null;
      };
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

chatRouter.post("/", jsonBody(chatBody), async (c) => {
  const body = c.get("body") as Record<string, unknown>;
  const agentId = String(body.agentId || "codex");
  const turnId = String(body.turnId || "").trim() || `turn-${randomUUID()}`;
  const afterSeq = parseAfterSeq(body.afterSeq ?? c.req.header("last-event-id"));

  let conn;
  try {
    conn = universalRegistry.connFor(agentId);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 404);
  }

  // Idempotent reconnect: the ledger owns the prompt, this request only reads.
  const existing = turnRegistry.get(turnId);
  if (existing) {
    if (existing.agentId !== agentId) {
      return json({ ok: false, error: `turn ${turnId} belongs to agent ${existing.agentId}` }, 409);
    }
    const requestedSession = String(body.sessionId || "");
    if (requestedSession && existing.sessionId && requestedSession !== existing.sessionId) {
      return json({ ok: false, error: `turn ${turnId} belongs to another session` }, 409);
    }
    return streamTurn(existing, afterSeq);
  }

  // The host may have restarted since this turn was accepted. Rebuild it from
  // the journal before touching the agent; a completed turn must replay, not
  // prompt again.
  if (body.turnId) {
    const journal = getSessionJournal();
    const loaded = journal ? await journal.loadTurn(agentId, turnId) : null;
    if (loaded) {
      const restored = turnRegistry.restore(loaded);
      return streamTurn(restored, afterSeq);
    }
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
  try {
    promptBlocks = normalizePrompt(body.prompt);
  } catch (err) {
    return gatewayError(err);
  }

  const raced = turnRegistry.get(turnId);
  if (raced) return streamTurn(raced, afterSeq);
  const record = turnRegistry.create(turnId, { agentId, sessionId });
  // A concurrent request may have created the same turn between connect and
  // here; attach instead of prompting twice.
  if (record.events.length > 0 || record.status !== "running") {
    return streamTurn(record, afterSeq);
  }

  void (async () => {
    try {
      turnRegistry.append(turnId, { type: "start", turnId, agentId, sessionId });
      const res = (await conn.prompt(
        sessionId,
        promptBlocks,
        (evt) => {
          turnRegistry.append(turnId, {
            ...evt,
            turnId,
            agentId,
            sessionId: (evt.sessionId as string) || sessionId,
          });
        }
      )) as { stopReason?: string } | undefined;
      turnRegistry.append(turnId, {
        type: "done",
        turnId,
        agentId,
        sessionId,
        stopReason: res?.stopReason || "end_turn",
        response: res,
        quota: conn.status().quota,
      });
      turnRegistry.finish(turnId, "done");
    } catch (err) {
      const msg = (err as Error).message || "prompt failed";
      const busy = /session busy.*\(409\)/i.test(msg);
      if (busy) {
        console.warn(`[Universal] chat rejected busy session=${sessionId}`);
      } else {
        console.error(`[Universal] chat prompt failed session=${sessionId}: ${msg}`);
      }
      turnRegistry.append(turnId, {
        type: "error",
        turnId,
        agentId,
        sessionId,
        message: msg,
        ...(busy ? { code: 409 } : {}),
      });
      turnRegistry.finish(turnId, "error");
    }
  })();

  return streamTurn(record, afterSeq);
});

/** JSON snapshot for reconnect/recovery, followed by the live SSE stream. */
chatRouter.get("/:turnId/snapshot", async (c) => {
  const turnId = c.req.param("turnId");
  let turn = turnRegistry.get(turnId);
  if (!turn) {
    const journal = getSessionJournal();
    const loaded = journal ? await journal.loadTurnById(turnId) : null;
    if (!loaded) return json({ ok: false, error: "unknown or expired turn" }, 404);
    turn = turnRegistry.restore(loaded);
  }
  const afterSeq = parseAfterSeq(c.req.query("after"));
  const plan = turnRegistry.replayPlan(turn.id, afterSeq);
  const events = turn.events.filter((event) => event.seq > plan.from);
  return json({
    ok: true,
    turnId: turn.id,
    agentId: turn.agentId,
    sessionId: turn.sessionId,
    status: turn.status,
    firstSeq: plan.firstSeq,
    lastSeq: plan.lastSeq,
    fromSeq: plan.from,
    resetRequired: plan.resetRequired,
    ...(plan.reason ? { resetReason: plan.reason } : {}),
    events,
  });
});

/** Explicit reconnect endpoint (GET /chat/:turnId/follow?after=N). */
chatRouter.get("/:turnId/follow", async (c) => {
  const turnId = c.req.param("turnId");
  let turn = turnRegistry.get(turnId);
  if (!turn) {
    const journal = getSessionJournal();
    const loaded = journal ? await journal.loadTurnById(turnId) : null;
    if (!loaded) return json({ ok: false, error: "unknown or expired turn" }, 404);
    turn = turnRegistry.restore(loaded);
  }
  return streamTurn(turn, parseAfterSeq(c.req.query("after") ?? c.req.header("last-event-id")));
});
