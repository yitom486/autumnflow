import { useEffect } from "react";
import { fetchPendingPermissions } from "@/lib/universal-api";
import { useStudioStore } from "@/stores/useStudioStore";

/**
 * Fast cadence while something is pending or was just pending: a request can
 * expire or be answered elsewhere, so the card must not sit stale.
 */
const ACTIVE_POLL_MS = 1500;
/**
 * Slow cadence once the app has been idle for a while. The live SSE channel
 * already delivers permission_request and permission_closed, so the poll is
 * only the recovery path after a reconnect — polling it every 1.5s all day is
 * pure overhead.
 */
const IDLE_POLL_MS = 6000;
/** How long the app must be idle before the poll slows down. */
const IDLE_AFTER_MS = 30_000;

/** Recover approvals after reconnect and retire expired requests even without a live chat stream. */
export function usePermissionSync() {
  const agentId = useStudioStore(s => s.activeAgentId);
  useEffect(() => {
    if (!agentId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let idleSince: number | null = null;
    const poll = async () => {
      let found = false;
      try {
        const before = useStudioStore.getState().pendingPerms;
        const pending = await fetchPendingPermissions(agentId, controller.signal);
        if (controller.signal.aborted) return;
        found = pending.length > 0;
        // Live events/responses take precedence over an older in-flight snapshot.
        if (useStudioStore.getState().pendingPerms === before) {
          useStudioStore.setState(s => ({ pendingPerms: [...s.pendingPerms.filter(p => p.agentId !== agentId), ...pending] }));
        }
      } catch (err) {
        if (!controller.signal.aborted) console.debug("[ACP] Pending permission refresh failed", err);
      } finally {
        if (controller.signal.aborted) return;
        const now = Date.now();
        if (found) idleSince = null;
        else if (idleSince === null) idleSince = now;
        const idle = idleSince !== null && now - idleSince > IDLE_AFTER_MS;
        timer = setTimeout(poll, idle ? IDLE_POLL_MS : ACTIVE_POLL_MS);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [agentId]);
}
