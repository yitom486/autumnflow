import type { StateCreator } from "zustand";
import { loadAgentPrefs, persistAgentPrefs } from "./persistence";
import type { AgentPrefs, StudioState } from "./types";

/** Per-agent last-used model/config memory (persisted to localStorage). */
export interface PrefsSlice {
  agentPrefs: Record<string, AgentPrefs>;
  /** Remember last-used config for an agent (persisted). */
  saveAgentPref: (agentId: string, patch: Partial<Omit<AgentPrefs, "updatedAt">>) => void;
  /** Remember a single configId value for an agent. */
  rememberAgentConfig: (agentId: string, configId: string, value: unknown) => void;
  clearAgentPref: (agentId: string) => void;
}

export const createPrefsSlice: StateCreator<StudioState, [], [], PrefsSlice> = (set, get) => ({
  agentPrefs: loadAgentPrefs(),
  saveAgentPref: (agentId, patch) =>
    set((s) => {
      const prev = s.agentPrefs?.[agentId];
      const nextEntry: AgentPrefs = {
        ...(prev || { updatedAt: 0 }),
        ...patch,
        configValues: { ...(prev?.configValues || {}), ...(patch.configValues || {}) },
        updatedAt: Date.now(),
      };
      // patch without configValues should keep old configValues (avoid wipe)
      if (!patch.configValues && prev?.configValues) {
        nextEntry.configValues = prev.configValues;
      }
      const nextPrefs = { ...(s.agentPrefs || {}), [agentId]: nextEntry };
      persistAgentPrefs(nextPrefs);
      return { agentPrefs: nextPrefs };
    }),
  rememberAgentConfig: (agentId, configId, value) =>
    set((s) => {
      const prev = s.agentPrefs?.[agentId];
      const nextEntry: AgentPrefs = {
        ...(prev || { updatedAt: 0 }),
        configValues: { ...(prev?.configValues || {}), [configId]: value },
        updatedAt: Date.now(),
      };
      const nextPrefs = { ...(s.agentPrefs || {}), [agentId]: nextEntry };
      persistAgentPrefs(nextPrefs);
      return { agentPrefs: nextPrefs };
    }),
  clearAgentPref: (agentId) =>
    set((s) => {
      const nextPrefs = { ...(s.agentPrefs || {}) };
      delete nextPrefs[agentId];
      persistAgentPrefs(nextPrefs);
      return { agentPrefs: nextPrefs };
    }),
});
