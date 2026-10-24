import { activeKey, sessionOf, useStudioStore, type SessionState } from "@/stores/useStudioStore";

const SESSION_FIELDS = new Set<keyof SessionState>([
  "messages",
  "activeTurn",
  "queuedPrompts",
  "draft",
  "attachments",
  "running",
  "usage",
  "sessionInfo",
  "modes",
  "sessionError",
  "sessionLoading",
]);

/**
 * Seed the studio store in one call: store-level fields go to the store,
 * session fields (`messages`, `isStreaming` → `running`, …) go to the session
 * the view is on — after any pointer change in the same patch.
 */
export function setStudio(patch: Record<string, any>): void {
  const top: Record<string, any> = {};
  const session: Record<string, any> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "isStreaming") session.running = v;
    else if (SESSION_FIELDS.has(k as keyof SessionState)) session[k] = v;
    else top[k] = v;
  }
  useStudioStore.setState(top);
  if (Object.keys(session).length === 0) return;
  useStudioStore.setState((s) => ({
    sessions: { ...s.sessions, [activeKey(s)]: { ...sessionOf(s), ...session } },
  }));
}

/** The session the view is on. */
export const view = (): SessionState => sessionOf(useStudioStore.getState());
