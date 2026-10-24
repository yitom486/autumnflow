import type { StateCreator } from "zustand";
import type { PendingElicitation, PendingPermission } from "@/lib/universal-api";
import type { StudioState } from "./types";

/** Overlays, busy flags and the agent requests waiting on the user (each carries its own agentId/sessionId). */
export interface UiSlice {
  busy: boolean;
  discovering: boolean;
  authOpen: boolean;
  settingsOpen: boolean;
  providersOpen: boolean;
  modelsOpen: boolean;
  pendingPerms: PendingPermission[];
  pendingElic: PendingElicitation[];
  respondingId: string | null;
  setBusy: (v: boolean) => void;
  setDiscovering: (v: boolean) => void;
  setAuthOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setProvidersOpen: (v: boolean) => void;
  setModelsOpen: (v: boolean) => void;
  addPermission: (p: PendingPermission) => void;
  removePermission: (id: string) => void;
  addElicitation: (e: PendingElicitation) => void;
  removeElicitation: (id: string) => void;
  setRespondingId: (id: string | null) => void;
}

export const createUiSlice: StateCreator<StudioState, [], [], UiSlice> = (set, get) => ({
  busy: false,
  discovering: false,
  authOpen: false,
  settingsOpen: false,
  providersOpen: false,
  modelsOpen: false,
  pendingPerms: [] as PendingPermission[],
  pendingElic: [] as PendingElicitation[],
  respondingId: null,
  setBusy: (v) => set({ busy: v }),
  setDiscovering: (v) => set({ discovering: v }),
  setAuthOpen: (v) => set({ authOpen: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setProvidersOpen: (v) => set({ providersOpen: v }),
  setModelsOpen: (v) => set({ modelsOpen: v }),
  addPermission: (p) => set((s) => ({ pendingPerms: [...s.pendingPerms.filter(item => item.permissionId !== p.permissionId), p] })),
  removePermission: (id) => set((s) => ({ pendingPerms: s.pendingPerms.filter((x) => x.permissionId !== id), respondingId: s.respondingId === id ? null : s.respondingId })),
  addElicitation: (e) => set((s) => ({ pendingElic: [...s.pendingElic.filter(p => p.agentId !== e.agentId || p.elicitationId !== e.elicitationId), e] })),
  removeElicitation: (id) => set((s) => ({ pendingElic: s.pendingElic.filter((x) => x.elicitationId !== id) })),
  setRespondingId: (id) => set({ respondingId: id }),
});
