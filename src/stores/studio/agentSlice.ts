import type { StateCreator } from "zustand";
import { normalizeAgentCommands, type SlashCommand } from "@/lib/slash-commands";
import type { ConfigOptionLike, ModelCatalog } from "@/lib/universal-api";
import { cmdKey, cmdsFor, DRAFT_KEY, emptySession, patchSessionIn } from "./session-state";
import { loadInitialActiveAgentId, persistActiveAgentId, readCachedCatalog, saveCachedCatalog } from "./persistence";
import type { ModeState, QuotaState, StudioState } from "./types";

/** The part of a session/new | resume | load | fork result the view takes over. */
export interface SessionResult {
  sessionId?: string | null;
  modes?: ModeState | null;
  models?: ModelCatalog | null;
  configOptions?: ConfigOptionLike[] | null;
  availableCommands?: unknown;
}

const initialCatalog = readCachedCatalog(loadInitialActiveAgentId());

/** Which agent is active, its connection/auth, and the catalog the view shows (models, config, commands, quota). */
export interface AgentSlice {
  activeAgentId: string;
  connectingId: string | null;
  authOk: Record<string, boolean | null>;
  /** 当前在看的会话的 ACP sessionId。 */
  sessionId: string | null;
  /** Commands per ACP session (agentId:sessionId) — survives thread/session switches. */
  commandsBySession: Record<string, SlashCommand[]>;
  models: ModelCatalog | null;
  configOptions: ConfigOptionLike[] | null;
  availableCommands: SlashCommand[];
  quota: QuotaState | null;
  setActiveAgentId: (id: string) => void;
  setConnectingId: (id: string | null) => void;
  setAuthOk: (agentId: string, ok: boolean | null) => void;
  setSessionId: (id: string | null) => void;
  applySessionResult: (res: SessionResult | null | undefined, expectedAgentId?: string) => void;
  setModels: (m: ModelCatalog | null) => void;
  setConfigOptions: (c: ConfigOptionLike[] | null) => void;
  /** Replace one option by id (an option the agent has not listed yet is appended as given). */
  patchConfigOption: (opt: Pick<ConfigOptionLike, "id"> & Partial<ConfigOptionLike>) => void;
  /** Store commands for a session (defaults to the current one); updates the view when it is current. */
  setAvailableCommands: (c: unknown, sessionId?: string | null) => void;
  setQuota: (q: QuotaState | null) => void;
}

export const createAgentSlice: StateCreator<StudioState, [], [], AgentSlice> = (set, get) => ({
  activeAgentId: loadInitialActiveAgentId(),
  connectingId: null,
  authOk: {},
  sessionId: null,
  commandsBySession: {} as Record<string, SlashCommand[]>,
  models: initialCatalog?.models ?? null,
  configOptions: initialCatalog?.configOptions ?? null,
  availableCommands: [] as SlashCommand[],
  quota: null,
  setActiveAgentId: (id) => {
    persistActiveAgentId(id);
    const cached = readCachedCatalog(id);
    set((s) =>
      s.activeAgentId === id
        ? { activeAgentId: id }
        : {
            activeAgentId: id,
            // Agent switch is a hard isolation boundary: another agent's live
            // session/models must never remain visible under this id. The
            // caller restores the target agent's own thread immediately
            // afterwards (or starts a fresh one). The other agent's sessions
            // keep their own state — a turn running there keeps running.
            models: cached?.models ?? null,
            configOptions: cached?.configOptions ?? null,
            availableCommands: [],
            quota: null,
            sessionId: null,
            activeThreadId: null,
            sessions: { ...s.sessions, [DRAFT_KEY]: emptySession() },
            busy: false,
          }
    );
  },
  setConnectingId: (id) => set({ connectingId: id }),
  setAuthOk: (agentId, ok) => set((s) => ({ authOk: { ...s.authOk, [agentId]: ok } })),
  setSessionId: (id) =>
    set((s) => (id === s.sessionId ? { sessionId: id } : { sessionId: id, availableCommands: cmdsFor(s, s.activeAgentId, id) })),
  applySessionResult: (res, expectedAgentId) =>
    set((s) => {
      // Late async result from an agent the user already switched away from:
      // never let it overwrite the new agent's session/config/models.
      if (expectedAgentId && s.activeAgentId !== expectedAgentId) return {};
      const sid = res?.sessionId ?? s.sessionId;
      const fromRes = Array.isArray(res?.availableCommands) ? normalizeAgentCommands(res.availableCommands) : null;
      const map = fromRes && sid ? { ...s.commandsBySession, [cmdKey(s.activeAgentId, sid)]: fromRes } : s.commandsBySession;
      const nextModels = res?.models ?? s.models;
      const nextConfigOptions = res?.configOptions ?? s.configOptions;
      if (res?.models || res?.configOptions) {
        saveCachedCatalog(s.activeAgentId, nextModels, nextConfigOptions);
      }
      return {
        sessionId: sid,
        commandsBySession: map,
        models: nextModels,
        configOptions: nextConfigOptions,
        availableCommands: fromRes ?? (sid === s.sessionId && s.availableCommands.length ? s.availableCommands : cmdsFor({ commandsBySession: map }, s.activeAgentId, sid)),
        ...(res?.modes ? patchSessionIn(s, null, { modes: res.modes }) : {}),
      };
    }),
  setModels: (m) =>
    set((s) => {
      saveCachedCatalog(s.activeAgentId, m, s.configOptions);
      return { models: m };
    }),
  setConfigOptions: (c) =>
    set((s) => {
      saveCachedCatalog(s.activeAgentId, s.models, c);
      return { configOptions: c };
    }),
  patchConfigOption: (opt) =>
    set((s) => {
      const option = opt as ConfigOptionLike;
      let next: ConfigOptionLike[];
      if (!s.configOptions) {
        next = [option];
      } else {
        const i = s.configOptions.findIndex((x) => x.id === opt.id);
        next = [...s.configOptions];
        if (i >= 0) next[i] = option;
        else next.push(option);
      }
      saveCachedCatalog(s.activeAgentId, s.models, next);
      return { configOptions: next };
    }),
  setAvailableCommands: (c, sessionId) =>
    set((s) => {
      const sid = sessionId ?? s.sessionId;
      const list = normalizeAgentCommands(c);
      if (!sid) return { availableCommands: list };
      const map = { ...s.commandsBySession, [cmdKey(s.activeAgentId, sid)]: list };
      return sid === s.sessionId ? { commandsBySession: map, availableCommands: list } : { commandsBySession: map };
    }),
  setQuota: (q) => set({ quota: q }),
});
