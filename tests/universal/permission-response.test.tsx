import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { useChatSend } from "../../src/hooks/useChatSend";
import { useStudioStore } from "../../src/stores/useStudioStore";
import { clearErrors, subscribeErrors } from "../../src/lib/error-bus";
import type { PendingPermission } from "../../src/lib/universal-api";
import { setStudio } from "../helpers/studio";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; clearErrors(); useStudioStore.getState().resetStudio(); });

it("releases the matching response lock on close without clearing another interaction's lock", () => {
  setStudio({ respondingId: "closed" });
  useStudioStore.getState().removePermission("closed");
  expect(useStudioStore.getState().respondingId).toBeNull();
  setStudio({ respondingId: "new-request" });
  useStudioStore.getState().removePermission("closed");
  expect(useStudioStore.getState().respondingId).toBe("new-request");
});

it.each([404, 503])("recovers from HTTP %s without a blocking dialog or stuck busy flag", async status => {
  const permission: PendingPermission = { agentId: "opencode", sessionId: "s1", permissionId: "p1", toolCall: {}, options: [{ optionId: "once", name: "Allow", kind: "allow_once" }] };
  setStudio({ pendingPerms: [permission] });
  let respond!: ReturnType<typeof useChatSend>["handlePermRespond"];
  function Harness() {
    respond = useChatSend({ qc: new QueryClient(), agentsRef: { current: [] }, resolveSession: async () => "s1" }).handlePermRespond;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: status === 404 ? "permission not found or expired" : "temporarily unavailable" }), { status })) as typeof fetch;
  const originalAlert = window.alert;
  const alert = vi.fn(); window.alert = alert;
  let messages: string[] = [];
  const unsubscribe = subscribeErrors(errors => { messages = errors.map(error => error.message); });
  try {
    await act(async () => root.render(<Harness />));
    await respond(permission, "once");
    expect(useStudioStore.getState().respondingId).toBeNull();
    expect(useStudioStore.getState().pendingPerms).toHaveLength(status === 404 ? 0 : 1);
    expect(messages.join(" ")).toContain(status === 404 ? "已结束或过期" : "temporarily unavailable");
    expect(alert).not.toHaveBeenCalled();
  } finally { window.alert = originalAlert; unsubscribe(); await act(async () => root.unmount()); }
});
