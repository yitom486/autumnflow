import type { QueryClient } from "@tanstack/react-query";
import type { ActivityEvent, AgentSummary } from "@/lib/universal-api";
import { useSessionActions } from "./useSessionActions";
import { useSessionResolution } from "./useSessionResolution";

export interface UseSessionLifecycleOptions {
  qc: QueryClient;
  agents: AgentSummary[];
  agentsRef: React.RefObject<AgentSummary[]>;
  applyDefaultConfigOptions: (agentId: string, sessionId: string) => Promise<void>;
  appendActivity?: (a: ActivityEvent) => void;
  now?: () => string;
}

const defaultNow = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Session Lifecycle & Agent Management Controller Hook.
 *
 * Two halves: useSessionResolution keeps the view bound to a live ACP session
 * (resume-first, create only when needed); useSessionActions carries out what
 * the user does with sessions and agents.
 */
export function useSessionLifecycle({ now = defaultNow, ...options }: UseSessionLifecycleOptions) {
  const resolution = useSessionResolution({ ...options, now });
  const actions = useSessionActions({ ...options, now, ...resolution });
  return { ...resolution, ...actions };
}
