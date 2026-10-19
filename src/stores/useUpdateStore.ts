/** 更新状态（全应用共享：右下角 toast 与“设置 → 关于”读同一份）。 */
import { create } from "zustand";
import { initialUpdateState, updateReducer, type UpdateAction, type UpdateState } from "@/lib/update-state";

export interface UpdateInfo {
  version: string;
  enabled: boolean;
  isDev: boolean;
  canAutoInstall: boolean;
  autoCheck: boolean;
  lastChecked: number | null;
  platform: string;
}

interface UpdateStore {
  state: UpdateState;
  info: UpdateInfo | null;
  dispatch: (a: UpdateAction) => void;
  refreshInfo: () => Promise<void>;
  check: () => Promise<void>;
  setAutoCheck: (v: boolean) => Promise<void>;
}

const api = () => (typeof window !== "undefined" ? window.autumnflow?.updates : undefined);

/** 浏览器 / 开发模式（无 Electron）时的占位信息 */
const WEB_INFO: UpdateInfo = {
  version: (import.meta.env.VITE_APP_VERSION as string) || "dev",
  enabled: false,
  isDev: true,
  canAutoInstall: false,
  autoCheck: false,
  lastChecked: null,
  platform: "web",
};

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  state: initialUpdateState,
  info: null,
  dispatch: (a) => {
    set((s) => ({ state: updateReducer(s.state, a) }));
    if (a.type === "not-available" || a.type === "error" || a.type === "available") void get().refreshInfo();
  },
  refreshInfo: async () => {
    const a = api();
    set({ info: a ? await a.getInfo().catch(() => WEB_INFO) : WEB_INFO });
  },
  check: async () => {
    const a = api();
    if (!a) {
      get().dispatch({ type: "disabled", manual: true });
      return;
    }
    get().dispatch({ type: "checking", manual: true });
    await a.check();
  },
  setAutoCheck: async (v) => {
    const a = api();
    if (!a) return;
    set({ info: await a.setAutoCheck(v) });
  },
}));

let started = false;
/** 订阅主进程更新事件（只订一次）。 */
export function startUpdateBridge() {
  if (started) return;
  started = true;
  const s = useUpdateStore.getState();
  void s.refreshInfo();
  api()?.onEvent((e) => useUpdateStore.getState().dispatch(e as UpdateAction));
}

// 开发模式：截图 / 调样式时可在控制台模拟更新事件，例如
// __acpUpdate.getState().dispatch({ type: "not-available", manual: true, version: "0.1.2" })
if (import.meta.env.DEV && typeof window !== "undefined") (window as any).__acpUpdate = useUpdateStore;
