// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { InteractionManager } from "../../server/universal/interaction";
import { elicitationCapabilities, supportedElicitation, validateElicitationContent } from "../../shared/elicitation";

const managers: InteractionManager[] = [];
function manager() { const events: Record<string, unknown>[] = []; const m = new InteractionManager("agent", (_sid, event) => events.push(event)); managers.push(m); return { m, events }; }
afterEach(() => { for (const m of managers.splice(0)) m.rejectAllOnExit(0, null); vi.useRealTimers(); });
const form: acp.CreateElicitationRequest = {
  mode: "form", sessionId: "session-1", toolCallId: "tool-1", message: "Choose",
  requestedSchema: { type: "object", properties: { arbitraryName: { type: "string", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] }, count: { type: "integer", minimum: 1, maximum: 8 } }, required: ["arbitraryName", "count"] },
};
const url: acp.CreateElicitationRequest = { mode: "url", requestId: 42, message: "Authorize", elicitationId: "opaque-agent-id", url: "https://example.org/authorize" };

describe("official ACP SDK elicitation round trip", () => {
  it.each(["accept", "decline", "cancel"] as const)("returns %s through a real SDK request", async action => {
    const { m, events } = manager();
    const client = acp.client().onRequest(acp.methods.client.elicitation.create, ctx => m.handleElicitation(ctx.params));
    const response = await acp.agent().connectWith(client, async ctx => {
      const result = ctx.request(acp.methods.client.elicitation.create, form);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      const response: acp.CreateElicitationResponse = action === "accept" ? { action, content: { arbitraryName: "b", count: 3 } } : { action };
      expect(m.resolveElicitation(String(events[0].elicitationId), response)).toBe(true);
      return result;
    });
    expect(response).toEqual(action === "accept" ? { action, content: { arbitraryName: "b", count: 3 } } : { action });
    expect(m.listPendingElicitations()).toEqual([]);
    expect(events[0].schema).toEqual(form);
  });

  it("rejects invalid values without consuming the pending request", async () => {
    const { m } = manager();
    const result = m.handleElicitation(form);
    const id = m.listPendingElicitations()[0].elicitationId;
    for (const content of [{ arbitraryName: "invalid", count: 3 }, { arbitraryName: "a", count: 1.3 }, { arbitraryName: "a", count: 9 }, { count: 3 }]) {
      expect(() => m.resolveElicitation(id, { action: "accept", content })).toThrow();
      expect(m.listPendingElicitations()).toHaveLength(1);
    }
    expect(() => m.resolveElicitation(id, { action: "invented" })).toThrow();
    m.resolveElicitation(id, { action: "cancel" });
    await expect(result).resolves.toEqual({ action: "cancel" });
    expect(m.resolveElicitation(id, { action: "cancel" })).toBe(false);
  });

  it("keeps URL acceptance separate from completion, with original ID and connection ownership", async () => {
    const { m, events } = manager();
    const other = manager().m;
    const client = acp.client()
      .onRequest(acp.methods.client.elicitation.create, ctx => m.handleElicitation(ctx.params))
      .onNotification(acp.methods.client.elicitation.complete, ctx => m.completeElicitation(ctx.params));
    await acp.agent().connectWith(client, async ctx => {
      const result = ctx.request(acp.methods.client.elicitation.create, url);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      const pending = m.listPendingElicitations()[0];
      expect(pending.sessionId).toBe("");
      expect(pending.schema).toEqual(url);
      m.resolveElicitation(pending.elicitationId, { action: "accept", content: { ignored: "URL has no form content" } });
      await expect(result).resolves.toEqual({ action: "accept" });
      expect(m.listPendingElicitations()[0].status).toBe("accepted");
      other.completeElicitation({ elicitationId: "opaque-agent-id" });
      m.completeElicitation({ elicitationId: "unknown" });
      expect(m.listPendingElicitations()).toHaveLength(1);
      await ctx.notify(acp.methods.client.elicitation.complete, { elicitationId: "opaque-agent-id" });
      await vi.waitFor(() => expect(m.listPendingElicitations()).toHaveLength(0));
      m.completeElicitation({ elicitationId: "opaque-agent-id" });
      expect(events.filter(e => e.type === "elicitation_completed")).toHaveLength(1);
    });
  });

  it("rejects duplicate URL IDs and unsupported modes with invalid params", async () => {
    const { m } = manager();
    const result = m.handleElicitation(url);
    for (const request of [url, { ...form, mode: "_private" }, { ...url, url: "javascript:alert(1)" }, { ...form, mode: undefined }]) {
      try { m.handleElicitation(request as acp.CreateElicitationRequest); throw new Error("expected rejection"); }
      catch (err) { expect((err as acp.RequestError).code).toBe(-32602); }
    }
    m.resolveElicitation(m.listPendingElicitations()[0].elicitationId, { action: "decline" });
    await expect(result).resolves.toEqual({ action: "decline" });
  });

  it("cancels on session stop and timeout, and clears accepted URLs on disconnect", async () => {
    vi.useFakeTimers();
    const { m } = manager();
    const result = m.handleElicitation(form);
    m.cancelPendingForSession("session-1");
    await expect(result).resolves.toEqual({ action: "cancel" });
    const timed = m.handleElicitation(form);
    await vi.runAllTimersAsync();
    await expect(timed).resolves.toEqual({ action: "cancel" });
    const external = m.handleElicitation(url);
    m.resolveElicitation(m.listPendingElicitations()[0].elicitationId, { action: "accept" });
    await external;
    m.rejectAllOnExit(0, null);
    expect(m.listPendingElicitations()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports every standard primitive and titled multiselect, without provider field names", () => {
    const schema: acp.ElicitationSchema = { properties: {
      text: { type: "string", minLength: 2, pattern: "^[a-z]+$" }, email: { type: "string", format: "email" },
      decimal: { type: "number", maximum: 2 }, bool: { type: "boolean" },
      array: { type: "array", items: { anyOf: [{ const: "x", title: "X" }, { const: "y", title: "Y" }] }, minItems: 1, maxItems: 2 },
    } };
    expect(supportedElicitation({ ...form, requestedSchema: schema })).toBe(true);
    expect(elicitationCapabilities).toEqual({ form: {}, url: {} });
    expect(validateElicitationContent(schema, { text: "ok", email: "a@b.co", decimal: 1.5, bool: false, array: ["x"] })).toEqual({});
    expect(Object.keys(validateElicitationContent(schema, { text: "1", email: "bad", decimal: 3, bool: "false", array: ["x", "x"], extra: true }))).toHaveLength(6);
  });
});
