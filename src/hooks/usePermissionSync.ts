import { useEffect } from "react";
import { fetchPendingPermissions } from "@/lib/universal-api";
import { useStudioStore } from "@/stores/useStudioStore";

/** Recover approvals after reconnect and retire expired requests even without a live chat stream. */
export function usePermissionSync() {
  const agentId = useStudioStore(s => s.activeAgentId);
  useEffect(() => {
    if (!agentId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const before = useStudioStore.getState().pendingPerms;
        const pending = await fetchPendingPermissions(agentId, controller.signal);
        if (controller.signal.aborted) return;
        // Live events/responses take precedence over an older in-flight snapshot.
        if (useStudioStore.getState().pendingPerms === before) {
          useStudioStore.setState(s => ({ pendingPerms: [...s.pendingPerms.filter(p => p.agentId !== agentId), ...pending] }));
        }
      } catch (err) {
        if (!controller.signal.aborted) console.debug("[ACP] Pending permission refresh failed", err);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [agentId]);
}
