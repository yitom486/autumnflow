import { useEffect } from "react";
import { fetchPendingElicitations } from "@/lib/universal-api";
import { useStudioStore } from "@/stores/useStudioStore";

/** Auth/config questions and URL completion can arrive outside a chat SSE stream. */
export function useElicitationSync() {
  const agentId = useStudioStore(s => s.activeAgentId);
  useEffect(() => {
    if (!agentId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const before = useStudioStore.getState().pendingElic;
        const pending = await fetchPendingElicitations(agentId, controller.signal);
        if (controller.signal.aborted) return;
        // Live events/responses take precedence over an older in-flight snapshot.
        if (useStudioStore.getState().pendingElic === before) {
          useStudioStore.setState(s => {
            const mine = s.pendingElic.filter(p => p.agentId === agentId);
            // Only touch the store when the set really changed. Replacing the
            // entries every 1.5s re-created the card mid-interaction and threw
            // away the answer the user was typing.
            const unchanged =
              mine.length === pending.length &&
              mine.every((item, index) => {
                const next = pending[index];
                return next && item.elicitationId === next.elicitationId && item.status === next.status;
              });
            if (unchanged) return s;
            return { pendingElic: [...s.pendingElic.filter(p => p.agentId !== agentId), ...pending] };
          });
        }
      } catch (err) {
        if (!controller.signal.aborted) console.debug("[ACP] Pending elicitation refresh failed", err);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [agentId]);
}
