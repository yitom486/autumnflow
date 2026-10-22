import { normalizeAgentCommands, type SlashCommand } from "@/lib/slash-commands";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Message } from "@/lib/message-types";
import type {
  Attachment,
  ModelCatalog,
  PendingElicitation,
  PendingPermission,
} from "@/lib/universal-api";
import {
  findThreadBySessionId,
  loadThreads,
  mergeAssistantTurns,
  newThreadId,
  pruneThreads,
  saveThreads,
  threadForAgent,
  titleForThread,
  toEnvironmentNativeCwd,
  type ActiveTurn,
  type ChatThread,
  type QueuedPrompt,
} from "@/lib/threads";

export type { QueuedPrompt };

export interface ModeState {
  currentModeId?: string;
  availableModes?: Array<{ id: string; name?: string }>;
}

export interface UsageState {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
  costScope?: "session";
  /**
   * Prompt-cache counters (agent 透传、有则显示，绝不编造）。
   * used/size 为上下文快照；结束响应的本轮累计计数独立保留，不能覆盖 used。
   */
  cachedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
  cachedWriteTokens?: number;
  /** 提示词总量（新增输入 + 缓存命中）；缓存命中率的分母 */
  promptTokens?: number;
  /** 缓存命中率 0~1（agent 侧口径优先，UI 仅在缺失时自行折算） */
  cacheHitRate?: number;
}

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: number;
}

export interface AgentPrefs {
  /** configId -> value (model / thinking / permission / 其他透传项) */
  configValues?: Record<string, unknown>;
  /** 无 model config 时的 fallback: models.currentModelId / catalog modelId */
  fallbackModelId?: string;
  /** modes.currentModeId */
  modeId?: string;
  updatedAt: number;
}

interface StudioState {
  // connection (client)
  activeAgentId: string;
  connectingId: string | null;
  authOk: Record<string, boolean | null>;
  // session (client view of server state)
  sessionId: string | null;
  /** Last ensureSession failure (non-auth), surfaced in the welcome banner. */
  sessionError: string | null;
  /** session/new in flight (drives the composer's loading shimmer). */
  sessionLoading: boolean;
  modes: ModeState | null;
  models: ModelCatalog | null;
  configOptions: any[] | null;
  availableCommands: SlashCommand[];
  /** Commands per ACP session (agentId:sessionId) — survives thread/session switches. */
  commandsBySession: Record<string, SlashCommand[]>;
  usage: UsageState | null;
  quota: any | null;
  sessionInfo: any;
  // thread
  messages: Message[];
  /** Durable pointer used by refresh/window recovery to follow a live turn. */
  activeTurn: ActiveTurn | null;
  // composer
  attachments: Attachment[];
  /** 正在生成的那一轮属于哪个会话（最近一次开始的那轮）。 */
  streamingSessionId: string | null;
  /** 正在跑的会话：按会话记，多个会话可以同时跑，互不影响。 */
  runningSessions: Record<string, boolean>;
  /** 消息 id → 它属于哪个会话（后台那轮的输出要写回自己的会话）。 */
  messageOwner: Record<string, string>;
  /** 每个会话的输入框草稿：切来切去不丢自己打的字。 */
  drafts: Record<string, string>;
  /** 当前视图是否在跑（= runningSessions[当前会话]）。 */
  isStreaming: boolean;
  busy: boolean;
  discovering: boolean;
  // overlays
  authOpen: boolean;
  settingsOpen: boolean;
  providersOpen: boolean;
  modelsOpen: boolean;
  // pending agent requests
  pendingPerms: PendingPermission[];
  pendingElic: PendingElicitation[];
  respondingId: string | null;
  /**
   * Prompts typed while the agent is still working. They are shown to the
   * user (and can be withdrawn) and are sent one by one once the current turn
   * ends. A prompt is never dropped silently.
   */
  queuedPrompts: QueuedPrompt[];

  // workspace & desktop tools
  currentWorkspace: string | null;
  recentWorkspaces: RecentWorkspace[];
  terminalOpen: boolean;
  /** 聊天卡片“在终端中打开”预填的命令：只填行、不执行，由抽屉消费后清零。 */
  terminalPrefill: string | null;
  /** 同卡片携带的工具执行 cwd（可空：空即回落工作区）；抽屉消费后清零。 */
  terminalCwd: string | null;
  gitChangesOpen: boolean;
  gitDiffFile: string | null;

  // per-agent last-used model/config memory (persisted to localStorage)
  agentPrefs: Record<string, AgentPrefs>;
  // @deprecated Runner era: no managed installs left, so nothing reads this.
  // Kept for localStorage persist compat only (do not add new readers).
  autoUpdate: Record<string, boolean>;
  // persisted chat threads, keyed by thread id (per-agent isolation enforced
  // by threads.ts lookups; live view stays in messages/sessionId)
  threads: Record<string, ChatThread>;
  activeThreadId: string | null;

  // actions
  setWorkspace: (path: string, name?: string) => void;
  setTerminalOpen: (v: boolean) => void;
  setTerminalPrefill: (cmd: string | null) => void;
  setTerminalCwd: (cwd: string | null) => void;
  setGitChangesOpen: (v: boolean, file?: string | null) => void;
  setActiveAgentId: (id: string) => void;
  setConnectingId: (id: string | null) => void;
  setAuthOk: (agentId: string, ok: boolean | null) => void;
  setSessionId: (id: string | null) => void;
  setSessionError: (e: string | null) => void;
  setSessionLoading: (v: boolean) => void;
  applySessionResult: (res: any, expectedAgentId?: string) => void;
  setModes: (m: ModeState | null) => void;
  setModels: (m: ModelCatalog | null) => void;
  setConfigOptions: (c: any[] | null) => void;
  patchConfigOption: (opt: any) => void;
  /** Store commands for a session (defaults to the current one); updates the view when it is current. */
  setAvailableCommands: (c: unknown, sessionId?: string | null) => void;
  setUsage: (u: UsageState | null) => void;
  setQuota: (q: any | null) => void;
  setSessionInfo: (info: any) => void;
  setMessages: (m: Message[]) => void;
  appendMessage: (m: Message) => void;
  patchMessage: (id: string, patch: Partial<Message> | ((m: Message) => Message)) => void;
  /** Queue a prompt typed while the agent is still working. */
  enqueuePrompt: (text: string) => string;
  /** Withdraw a queued prompt before it is sent. */
  removeQueuedPrompt: (id: string) => void;
  /** Drop every queued prompt (the user stopped the run). */
  clearQueuedPrompts: () => void;
  setActiveTurn: (turn: ActiveTurn | null) => void;
  patchActiveTurn: (patch: Partial<ActiveTurn>) => void;
  /** 记下这个会话的输入框内容（按会话存，切会话不丢）。 */
  setDraft: (sessionId: string | null | undefined, text: string) => void;
  setAttachments: (a: Attachment[]) => void;
  setStreaming: (v: boolean) => void;
  /** 标记某个会话在跑/跑完：会话之间互不影响。 */
  setSessionRunning: (sessionId: string | null | undefined, running: boolean) => void;
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
  /** Remember last-used config for an agent (persisted). */
  saveAgentPref: (agentId: string, patch: Partial<Omit<AgentPrefs, "updatedAt">>) => void;
  /** Remember a single configId value for an agent. */
  rememberAgentConfig: (agentId: string, configId: string, value: unknown) => void;
  clearAgentPref: (agentId: string) => void;
  /** Opt-in/out of auto-update-to-latest on connect (persisted, default off). */
  setAutoUpdate: (agentId: string, on: boolean) => void;
  /** Clear thread + session-scoped view state (used on agent switch / new thread). */
  resetThread: () => void;
  /** Snapshot the live view into the persisted per-agent thread record. */
  snapshotThread: () => void;
  /** Restore an agent's latest thread into the live view (instant, no network), optionally scoped to a workspace cwd. */
  restoreThread: (agentId: string, targetCwd?: string | null) => ChatThread | null;
  /** Start a fresh empty thread for an agent, optionally scoped to a workspace cwd. */
  newThread: (agentId: string, targetCwd?: string | null) => ChatThread;
  /** MCP servers carried by an agent's live/latest thread (auto new/resume). */
  threadMcpServers: (agentId: string) => unknown[] | undefined;
  /** Bind an ACP sessionId to the live thread (same agent only). */
  bindThreadSession: (sessionId: string | null, cwd?: string | null, mcpServers?: unknown[]) => void;
  /** Mark the live thread stale after a failed resume (visible degrade). */
  markThreadStale: () => void;
  /** Session-level code mode (PTC): applies when this thread's session is created or resumed. */
  setThreadCodeMode: (enabled: boolean) => void;
  /** Optimistic switch to a session: instant UI mount from local thread cache without blocking spinners. */
  optimisticOpenSession: (
    agentId: string,
    sessionId: string,
    title?: string | null,
    cwd?: string | null
  ) => ChatThread;
  /** Full reset (tests / logout flows). */
  resetStudio: () => void;
}

const cmdKey = (agentId: string | null | undefined, sid: string) => `${agentId || ""}:${sid}`;
function cmdsFor(s: { commandsBySession: Record<string, SlashCommand[]> }, agentId: string | null | undefined, sid: string | null | undefined): SlashCommand[] {
  return sid ? s.commandsBySession[cmdKey(agentId, sid)] ?? [] : [];
}

const initialThread = {
  messages: [] as Message[],
  activeTurn: null as ActiveTurn | null,
  sessionError: null as string | null,
  sessionLoading: false as boolean,
  modes: null as ModeState | null,
  models: null as ModelCatalog | null,
  configOptions: null as any[] | null,
  availableCommands: [] as SlashCommand[],
  usage: null as UsageState | null,
  quota: null as any | null,
  sessionInfo: null as any,
  pendingPerms: [] as PendingPermission[],
  pendingElic: [] as PendingElicitation[],
  queuedPrompts: [] as QueuedPrompt[],
  attachments: [] as Attachment[],
};

export const WINDOW_WORKSPACE_KEY = "acp_window_workspace";

/**
 * 当前所处环境（local / wsl_<distro> / remote_<host>），用于彻底隔离不同系统的工作区与会话
 */
export function getWorkspaceEnv(): string {
  if (typeof localStorage === "undefined") return "local";
  const distro = localStorage.getItem("acp_wsl_native_distro");
  // 只要设置了 WSL 发行版，即视为 WSL 原生真环境，彻底隔离工作区、历史与会话
  if (distro && distro.trim()) {
    return `wsl_${distro.trim().toLowerCase()}`;
  }
  const base = localStorage.getItem("acp_gateway_base");
  if (base) {
    try {
      const u = new URL(base);
      return `remote_${u.host.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    } catch {
      return "remote";
    }
  }
  return "local";
}

/**
 * 判断当前目标运行环境是否属于 POSIX 体系（Linux / WSL / SSH 远程 Linux / macOS 等）：
 * 在 POSIX 体系下，所有路径必须为纯正的 POSIX 原生绝对路径，绝不包含 Windows 盘符或 UNC 包装。
 */
export function isPosixEnvironment(): boolean {
  const env = getWorkspaceEnv();
  if (env.startsWith("wsl_") || env.startsWith("remote_")) return true;
  if (typeof process !== "undefined" && process.platform && process.platform !== "win32") {
    return true;
  }
  return false;
}

export function isLocalMode(): boolean {
  return getWorkspaceEnv() === "local";
}

export function getWorkspaceStorageKey(): string {
  return `acp_workspace_${getWorkspaceEnv()}`;
}

export function isAppInstallPath(p?: string | null): boolean {
  if (!p) return false;
  const norm = p.replace(/\\/g, "/").toLowerCase();
  return (
    norm.includes("appdata/local/programs/autumnflow") ||
    norm.includes("program files/autumnflow") ||
    norm.includes("program files (x86)/autumnflow")
  );
}

function loadInitialWorkspaces(): { current: string | null; recents: RecentWorkspace[] } {
  try {
    // 多窗口：每个窗口的“当前工作区”优先取地址栏 ?cwd=（新窗口打开文件夹）→ 本窗口 sessionStorage
    // → 当前环境上次使用（localStorage 隔离键，仅作新窗口的默认值）。
    const fromUrl = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("cwd") : null;
    const fromWindow = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(WINDOW_WORKSPACE_KEY) : null;
    const envKey = getWorkspaceStorageKey();
    const isPosix = isPosixEnvironment();

    let current = fromUrl || fromWindow || (typeof localStorage !== "undefined" ? localStorage.getItem(`${envKey}_current`) : null);
    let raw = typeof localStorage !== "undefined" ? localStorage.getItem(`${envKey}_recents`) : null;

    // 本机 Windows 模式兼容旧存储键
    if (isLocalMode() && typeof localStorage !== "undefined") {
      if (!current) current = localStorage.getItem("acp_current_workspace");
      if (!raw) raw = localStorage.getItem("acp_recent_workspaces");
    }

    // 绝对不允许将应用程序安装目录作为工作区缓存
    if (current && isAppInstallPath(current)) {
      current = null;
    }

    // 路径提纯为当前目标环境的原生格式（若为 POSIX 自动剥离 UNC 包装与残留盘符）
    if (current) {
      current = toEnvironmentNativeCwd(current, isPosix);
      if (isPosix && /^[a-zA-Z]:/.test(current)) {
        current = null;
      }
    }

    if (fromUrl && typeof sessionStorage !== "undefined") sessionStorage.setItem(WINDOW_WORKSPACE_KEY, fromUrl);
    const recents = raw ? JSON.parse(raw) : [];
    const validRecents: RecentWorkspace[] = [];
    if (Array.isArray(recents)) {
      for (const r of recents) {
        if (!r?.path || isAppInstallPath(r.path)) continue;
        const nativePath = toEnvironmentNativeCwd(r.path, isPosix);
        if (isPosix && /^[a-zA-Z]:/.test(nativePath)) continue;
        if (!isPosix && nativePath.startsWith("/") && !/^[a-zA-Z]:/.test(nativePath)) continue;
        validRecents.push({ ...r, path: nativePath });
      }
    }
    return { current: current || null, recents: validRecents };
  } catch {
    return { current: null, recents: [] };
  }
}

const initialWorkspaces = loadInitialWorkspaces();

const AGENT_PREFS_KEY = "acp_agent_prefs_v1";

function loadAgentPrefs(): Record<string, AgentPrefs> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(AGENT_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, AgentPrefs>;
    }
    return {};
  } catch {
    return {};
  }
}

function persistAgentPrefs(prefs: Record<string, AgentPrefs>) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(AGENT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage errors (private mode / quota)
  }
}

const initialAgentPrefs = loadAgentPrefs();
const initialThreads = loadThreads();

const AUTO_UPDATE_KEY = "acp_auto_update_v1";

function loadAutoUpdate(): Record<string, boolean> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(AUTO_UPDATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === true) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function persistAutoUpdate(map: Record<string, boolean>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(AUTO_UPDATE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors (private mode / quota)
  }
}

const ACTIVE_AGENT_KEY = "acp_active_agent_id_v1";

function loadInitialActiveAgentId(): string {
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const p = new URLSearchParams(window.location.search).get("agent");
      if (p && p.trim()) return p.trim();
    }
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(ACTIVE_AGENT_KEY);
      if (saved && typeof saved === "string" && saved.trim()) {
        return saved.trim();
      }
    }
    return "codex";
  } catch {
    return "codex";
  }
}

function persistActiveAgentId(id: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(ACTIVE_AGENT_KEY, id);
  } catch {
    // ignore storage errors
  }
}

/**
 * Last-known model catalog per agent. OpenCode builds its provider/model list
 * lazily on the first session/new after process start (measured ~6s on this
 * machine, ~0.4s once warm). Hydrating this cache makes the model picker
 * usable immediately; session/new still refreshes it in the background.
 */
const MODEL_CATALOG_KEY = "acp_model_catalog_v1";
interface CachedModelCatalog {
  models: ModelCatalog | null;
  configOptions: any[] | null;
  at: number;
}

function readCachedCatalog(agentId: string): CachedModelCatalog | null {
  try {
    if (typeof localStorage === "undefined" || !agentId) return null;
    const all = JSON.parse(localStorage.getItem(MODEL_CATALOG_KEY) || "{}") as Record<string, CachedModelCatalog>;
    const row = all?.[agentId];
    if (!row || typeof row !== "object") return null;
    if (row.models !== null && typeof row.models !== "object") return null;
    if (row.configOptions !== null && !Array.isArray(row.configOptions)) return null;
    return row;
  } catch (err) {
    console.debug("[Studio] 读取模型目录缓存失败 (已忽略):", err);
    return null;
  }
}

function saveCachedCatalog(agentId: string, models: ModelCatalog | null, configOptions: any[] | null): void {
  try {
    if (typeof localStorage === "undefined" || !agentId) return;
    const all = JSON.parse(localStorage.getItem(MODEL_CATALOG_KEY) || "{}") as Record<string, CachedModelCatalog>;
    all[agentId] = { models, configOptions, at: Date.now() };
    // Bound the cache to the most recent agents so it cannot grow unbounded.
    const rows = Object.entries(all).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, 8);
    localStorage.setItem(MODEL_CATALOG_KEY, JSON.stringify(Object.fromEntries(rows)));
  } catch (err) {
    console.debug("[Studio] 写入模型目录缓存失败 (已忽略):", err);
  }
}

const initialCatalog = readCachedCatalog(loadInitialActiveAgentId());

export const useStudioStore = create<StudioState>()((set, get) => ({
  activeAgentId: loadInitialActiveAgentId(),
  connectingId: null,
  authOk: {},
  sessionId: null,
  commandsBySession: {} as Record<string, SlashCommand[]>,
  threads: initialThreads,
  activeThreadId: null,
  autoUpdate: loadAutoUpdate(),
  ...initialThread,
  // Show the last known catalog instantly; a fresh session/new will replace it.
  models: initialCatalog?.models ?? null,
  configOptions: initialCatalog?.configOptions ?? null,
  isStreaming: false,
  streamingSessionId: null,
  runningSessions: {} as Record<string, boolean>,
  messageOwner: {} as Record<string, string>,
  drafts: {} as Record<string, string>,
  busy: false,
  discovering: false,
  authOpen: false,
  settingsOpen: false,
  providersOpen: false,
  modelsOpen: false,
  respondingId: null,

  // workspace & desktop tools
  currentWorkspace: initialWorkspaces.current,
  recentWorkspaces: initialWorkspaces.recents,
  terminalOpen: false,
  terminalPrefill: null,
  terminalCwd: null,
  gitChangesOpen: false,
  gitDiffFile: null,

  agentPrefs: initialAgentPrefs,

  setWorkspace: (targetPath, optName) =>
    set((s) => {
      // Runtime boundary: workspace pickers/menus occasionally hand over an
      // event or a recent-workspace record instead of a path string. Treating
      // it as a path used to crash the caller in toEnvironmentNativeCwd.
      if (typeof targetPath !== "string" || !targetPath.trim()) {
        console.warn("[Studio] setWorkspace 收到非路径值，已忽略:", targetPath);
        return {};
      }
      const isPosix = isPosixEnvironment();
      // 提纯为当前目标环境的原生 CWD 路径（零硬编码，剥离 Windows UNC 或误拼盘符）
      const cleanPath = toEnvironmentNativeCwd(targetPath, isPosix);

      // 环境合法性检验：
      // POSIX 环境（WSL / SSH / Linux）绝不允许接收 Windows 盘符路径；
      // Windows 本地环境绝不允许接收纯 Linux 路径
      if (isPosix && /^[a-zA-Z]:/.test(cleanPath)) {
        return {};
      }
      if (!isPosix && cleanPath.startsWith("/") && !/^[a-zA-Z]:/.test(cleanPath)) {
        return {};
      }
      if (isAppInstallPath(cleanPath)) {
        return {};
      }

      const name = optName || cleanPath.split(/[/\\]/).filter(Boolean).pop() || cleanPath;
      const prevRecents = Array.isArray(s.recentWorkspaces) ? s.recentWorkspaces : [];
      const filtered = prevRecents.filter((r) => r.path !== cleanPath);
      const nextRecents = [{ path: cleanPath, name, lastOpened: Date.now() }, ...filtered].slice(0, 8);
      const envKey = getWorkspaceStorageKey();
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(`${envKey}_current`, cleanPath);
          localStorage.setItem(`${envKey}_recents`, JSON.stringify(nextRecents));
          if (isLocalMode()) {
            localStorage.setItem("acp_current_workspace", cleanPath);
            localStorage.setItem("acp_recent_workspaces", JSON.stringify(nextRecents));
          }
        }
        if (typeof sessionStorage !== "undefined") sessionStorage.setItem(WINDOW_WORKSPACE_KEY, cleanPath);
        void window.autumnflow?.workbench?.recentAdd(cleanPath)?.catch?.(() => {});
      } catch {
        // ignore storage errors
      }

      // 若工作区发生改变，自动切换到目标工作区专属的会话上下文，杜绝跨工作区串话
      if (s.currentWorkspace !== cleanPath) {
        // 1. 若当前会话有内容，先妥善保存到当前工作区
        if (s.activeThreadId && s.messages.length > 0) {
          const cur = s.threads[s.activeThreadId];
          if (cur) {
            const updated = {
              ...cur,
              messages: s.messages,
              sessionId: s.sessionId ?? (cur.stale ? cur.sessionId : null),
              cwd: s.currentWorkspace,
              updatedAt: Date.now(),
            };
            const nextThreads = pruneThreads({ ...s.threads, [cur.id]: updated }, [cur.id]);
            saveThreads(nextThreads);
          }
        }

        // 2. 检索目标工作区是否已有历史会话
        const existing = threadForAgent(s.threads, s.activeAgentId, targetPath);
        const cached = readCachedCatalog(s.activeAgentId);
        if (existing) {
          const existingTitle = titleForThread(existing);
          return {
            currentWorkspace: targetPath,
            recentWorkspaces: nextRecents,
            ...initialThread,
            models: cached?.models ?? null,
            configOptions: cached?.configOptions ?? null,
            messages: existing.messages.map((m) => ({ ...m })),
            sessionId: existing.stale ? null : existing.sessionId,
            availableCommands: cmdsFor(s, s.activeAgentId, existing.stale ? null : existing.sessionId),
            sessionInfo: existingTitle ? { title: existingTitle } : null,
            activeThreadId: existing.id,
          };
        } else {
          // 3. 目标工作区尚无会话：就地清空为崭新的新会话准备状态
          return {
            currentWorkspace: targetPath,
            recentWorkspaces: nextRecents,
            ...initialThread,
            models: cached?.models ?? null,
            configOptions: cached?.configOptions ?? null,
            sessionId: null,
            activeThreadId: null,
            messages: [],
          };
        }
      }

      return { currentWorkspace: targetPath, recentWorkspaces: nextRecents };
    }),
  setTerminalOpen: (v) => set({ terminalOpen: v }),
  setTerminalPrefill: (cmd) => set({ terminalPrefill: cmd }),
  setTerminalCwd: (cwd) => set({ terminalCwd: cwd }),
  setGitChangesOpen: (v, file) => set({ gitChangesOpen: v, gitDiffFile: file ?? null }),

  setActiveAgentId: (id) => {
    persistActiveAgentId(id);
    const cached = readCachedCatalog(id);
    set((s) =>
      s.activeAgentId === id
        ? { activeAgentId: id }
        : {
            activeAgentId: id,
            // Agent switch is a hard isolation boundary: another agent's live
            // session/messages/models must never remain visible under this id.
            // The caller restores the target agent's own thread immediately
            // afterwards (or starts a fresh one).
            ...initialThread,
            models: cached?.models ?? null,
            configOptions: cached?.configOptions ?? null,
            sessionId: null,
            activeThreadId: null,
            // A switch also stops treating the old turn/draft as live input.
            isStreaming: false,
            streamingSessionId: null,
            runningSessions: {} as Record<string, boolean>,
            messageOwner: {} as Record<string, string>,
            drafts: {} as Record<string, string>,
            busy: false,
          }
    );
  },
  setConnectingId: (id) => set({ connectingId: id }),
  setAuthOk: (agentId, ok) => set((s) => ({ authOk: { ...s.authOk, [agentId]: ok } })),
  setSessionId: (id) =>
    set((s) => (id === s.sessionId ? { sessionId: id } : { sessionId: id, availableCommands: cmdsFor(s, s.activeAgentId, id) })),
  setSessionError: (e) => set({ sessionError: e }),
  setSessionLoading: (v) => set({ sessionLoading: v }),
  applySessionResult: (res: any, expectedAgentId?: string) =>
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
      modes: res?.modes ?? s.modes,
      models: nextModels,
      configOptions: nextConfigOptions,
      availableCommands: fromRes ?? (sid === s.sessionId && s.availableCommands.length ? s.availableCommands : map[cmdKey(s.activeAgentId, sid)] ?? []),
      };
    }),
  setModes: (m) => set({ modes: m }),
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
      let next: any[];
      if (!s.configOptions) {
        next = [opt];
      } else {
        const i = s.configOptions.findIndex((x) => x.id === opt.id);
        next = [...s.configOptions];
        if (i >= 0) next[i] = opt;
        else next.push(opt);
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
  setUsage: (u) => set({ usage: u }),
  setQuota: (q) => set({ quota: q }),
  setSessionInfo: (info) => set({ sessionInfo: info }),
  setMessages: (m) => set({ messages: mergeAssistantTurns(m) }),
  appendMessage: (m) => set((s) => ({
    messages: mergeAssistantTurns([...s.messages, m]),
    // 记住这条消息属于哪个会话：后台那一轮的输出要写回它自己的会话，
    // 不能掉进用户正在看的那个会话里。
    messageOwner: s.activeThreadId ? { ...s.messageOwner, [m.id]: s.activeThreadId } : s.messageOwner,
  })),
  enqueuePrompt: (text) => {
    const item: QueuedPrompt = { id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, text, createdAt: Date.now() };
    // 排队是会话内的事：挂在所属会话上，别让 A 会话的队列跑到 B 会话去。
    set((s) => {
      const id = s.activeThreadId;
      if (!id) return { queuedPrompts: [...s.queuedPrompts, item] };
      const thread = s.threads[id];
      if (!thread) return { queuedPrompts: [...s.queuedPrompts, item] };
      return {
        queuedPrompts: s.queuedPrompts,
        threads: { ...s.threads, [id]: { ...thread, queuedPrompts: [...(thread.queuedPrompts || []), item] } },
      };
    });
    return item.id;
  },
  removeQueuedPrompt: (id) => set((s) => {
    const threadId = s.activeThreadId;
    const thread = threadId ? s.threads[threadId] : undefined;
    const rest = s.queuedPrompts.filter((item) => item.id !== id);
    if (thread) {
      return {
        queuedPrompts: rest,
        threads: { ...s.threads, [threadId!]: { ...thread, queuedPrompts: (thread.queuedPrompts || []).filter((item) => item.id !== id) } },
      };
    }
    return { queuedPrompts: rest };
  }),
  clearQueuedPrompts: () => set((s) => {
    const threadId = s.activeThreadId;
    const thread = threadId ? s.threads[threadId] : undefined;
    if (thread) return { threads: { ...s.threads, [threadId!]: { ...thread, queuedPrompts: [] } } };
    return { queuedPrompts: [] };
  }),
  patchMessage: (id, patch) =>
    set((s) => {
      const apply = (m: any) =>
        m.id === id ? (typeof patch === "function" ? patch(m) : { ...m, ...patch }) : m;
      // 这条消息可能属于后台正在跑的那个会话：改在它自己的会话里，
      // 当前视图只有正好是同一个会话时才跟着更新。
      const owner = s.messageOwner[id];
      if (owner && owner !== s.activeThreadId) {
        const thread = s.threads[owner];
        if (!thread) return { messages: s.messages.map(apply) };
        return {
          threads: { ...s.threads, [owner]: { ...thread, messages: thread.messages.map(apply) } },
        };
      }
      return { messages: s.messages.map(apply) };
    }),
  setActiveTurn: (turn) => set({ activeTurn: turn }),
  patchActiveTurn: (patch) =>
    set((s) => ({ activeTurn: s.activeTurn ? { ...s.activeTurn, ...patch } : null })),
  setDraft: (sessionId, text) => set((s) => {
    const key = sessionId || "";
    if (!text) {
      if (!(key in s.drafts)) return s;
      const { [key]: _dropped, ...rest } = s.drafts;
      return { drafts: rest };
    }
    return { drafts: { ...s.drafts, [key]: text } };
  }),
  setAttachments: (a) => set({ attachments: a }),
  setStreaming: (v) => get().setSessionRunning(get().sessionId, v),
  setSessionRunning: (sessionId, running) => set((s) => {
    const key = sessionId || "";
    const next = { ...s.runningSessions };
    if (running) next[key] = true;
    else delete next[key];
    return {
      runningSessions: next,
      // 视图这一格跟着"当前会话"走：切到在跑的会话就是 busy，切到跑完的就不是。
      isStreaming: !!next[s.sessionId ?? ""],
      streamingSessionId: running
        ? (sessionId ?? null)
        : (s.streamingSessionId === sessionId ? null : s.streamingSessionId),
    };
  }),
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
  setAutoUpdate: (agentId, on) =>
    set((s) => {
      const next = { ...(s.autoUpdate || {}) };
      if (on) next[agentId] = true;
      else delete next[agentId];
      persistAutoUpdate(next);
      return { autoUpdate: next };
    }),
  resetThread: () => set({ ...initialThread }),
  snapshotThread: () =>
    set((s) => {
      const id = s.activeThreadId ?? newThreadId();
      const prev = s.activeThreadId ? s.threads[s.activeThreadId] : undefined;
      const thread: ChatThread = {
        id,
        agentId: s.activeAgentId,
        // Keep the user-facing name on the persisted record so the sidebar can
        // show content instead of an opaque session id.
        title: titleForThread({ title: prev?.title, messages: s.messages }),
        // Keep the historical id, and keep the stale marker so the next boot
        // does not try to resume the same dead id all over again.
        sessionId: s.sessionId ?? (prev?.stale ? prev.sessionId : null),
        stale: prev?.stale ? true : undefined,
        cwd: s.currentWorkspace ?? prev?.cwd ?? null,
        messages: s.messages,
        activeTurn: s.activeTurn ? { ...s.activeTurn, persistedSeq: s.activeTurn.lastSeq } : undefined,
        // Preserve the thread's MCP servers across snapshots (auto new/resume).
        mcpServers: prev?.mcpServers,
        updatedAt: Date.now(),
      };
      const next = pruneThreads({ ...s.threads, [id]: thread }, [id]);
      saveThreads(next);
      return { threads: next, activeThreadId: id };
    }),
  restoreThread: (agentId, targetCwd) => {
    const s = useStudioStore.getState();
    const cwd = targetCwd !== undefined ? targetCwd : s.currentWorkspace;
    const t = threadForAgent(s.threads, agentId, cwd);
    if (!t) return null;
    const title = titleForThread(t);
    const cached = readCachedCatalog(agentId);
    set({
      ...initialThread,
      models: cached?.models ?? null,
      configOptions: cached?.configOptions ?? null,
      messages: t.messages.map((m) => ({ ...m })),
      activeTurn: t.activeTurn ?? null,
      // A stale thread is a read-only historical transcript: showing its dead
      // id as the live session is what made resume/ensureSession loop forever.
      sessionId: t.stale ? null : t.sessionId,
      availableCommands: cmdsFor(s, agentId, t.stale ? null : t.sessionId),
      sessionInfo: title ? { title } : null,
      activeThreadId: t.id,
      isStreaming: !!s.runningSessions[(t.stale ? null : t.sessionId) ?? ""],
    });
    return t;
  },
  newThread: (agentId, targetCwd) => {
    // (same NOTE as threadMcpServers: use creator `get()`, not self-reference)
    const s0 = get();
    const cwd = targetCwd !== undefined ? targetCwd : s0.currentWorkspace;
    // Continuity: a fresh thread inherits the agent's latest MCP servers so
    // auto-created sessions keep working tools until the user changes them.
    const inherited = threadForAgent(s0.threads, agentId, cwd)?.mcpServers;
    const liveThread = s0.activeThreadId ? s0.threads[s0.activeThreadId] : undefined;
    const inheritedCodeMode =
      liveThread && liveThread.agentId === agentId
        ? liveThread.codeMode
        : threadForAgent(s0.threads, agentId, cwd)?.codeMode;
    const t: ChatThread = {
      id: newThreadId(),
      agentId,
      sessionId: null,
      cwd,
      messages: [],
      mcpServers: inherited,
      ...(inheritedCodeMode !== undefined ? { codeMode: inheritedCodeMode } : {}),
      updatedAt: Date.now(),
    };
    const next = pruneThreads({ ...s0.threads, [t.id]: t }, [t.id]);
    saveThreads(next);
    const cached = readCachedCatalog(agentId);
    set({
      ...initialThread,
      models: cached?.models ?? null,
      configOptions: cached?.configOptions ?? null,
      sessionId: null,
      threads: next,
      activeThreadId: t.id,
      // 新会话还没跑，视图不该以为自己忙（别的会话在跑是它们自己的事）。
      isStreaming: false,
    });
    return t;
  },
  threadMcpServers: (agentId) => {
    // NOTE: use the creator `get()` here, never useStudioStore.getState() —
    // self-referencing the store under construction degrades downstream type
    // inference (st.threads collapses to unknown in consumers).
    const s = get();
    const live = s.activeThreadId ? s.threads[s.activeThreadId] : undefined;
    const mine = live && live.agentId === agentId ? live : threadForAgent(s.threads, agentId);
    return mine?.mcpServers;
  },
  bindThreadSession: (sessionId, cwd, mcpServers) =>
    set((s) => {
      if (!s.activeThreadId) return { sessionId };
      const cur = s.threads[s.activeThreadId];
      // Isolation: only bind when the live thread belongs to the active agent.
      if (!cur || cur.agentId !== s.activeAgentId) return { sessionId };
      const next = {
        ...cur,
        sessionId,
        title: titleForThread(cur),
        cwd: cwd !== undefined ? cwd : cur.cwd,
        mcpServers: mcpServers !== undefined ? mcpServers : cur.mcpServers,
        stale: false,
        updatedAt: Date.now(),
      };
      const threads = pruneThreads({ ...s.threads, [next.id]: next }, [next.id]);
      saveThreads(threads);
      return { sessionId, threads };
    }),
  markThreadStale: () =>
    set((s) => {
      if (!s.activeThreadId) return {};
      const cur = s.threads[s.activeThreadId];
      if (!cur) return {};
      const next = { ...cur, stale: true, updatedAt: Date.now() };
      const threads = pruneThreads({ ...s.threads, [next.id]: next }, [next.id]);
      saveThreads(threads);
      // The id remains on the historical thread record for display, but it is
      // no longer a live session: leaving it in `sessionId` made ensureSession
      // return the dead id forever (the "点击加载模型" button did nothing).
      return { threads, sessionId: null };
    }),
  setThreadCodeMode: (enabled) =>
    set((s) => {
      if (!s.activeThreadId) return {};
      const cur = s.threads[s.activeThreadId];
      if (!cur) return {};
      const next = { ...cur, codeMode: enabled, updatedAt: Date.now() };
      const threads = pruneThreads({ ...s.threads, [next.id]: next }, [next.id]);
      saveThreads(threads);
      return { threads };
    }),
  optimisticOpenSession: (agentId, sessionId, title, cwd) => {
    const s0 = get();
    // 1. Snapshot current active thread first
    s0.snapshotThread();
    const st = get();

    // 2. Lookup existing thread in local cache (0ms instant switch)
    const existing = findThreadBySessionId(st.threads, agentId, sessionId);
    if (existing) {
      set({
        sessionId,
        availableCommands: cmdsFor(st, agentId, sessionId),
        activeThreadId: existing.id,
        messages: mergeAssistantTurns(existing.messages).map((m) => ({ ...m })),
        activeTurn: existing.activeTurn ?? null,
        sessionInfo: {
          ...(st.sessionInfo || {}),
          title: titleForThread(existing) || title || st.sessionInfo?.title,
        },
        sessionError: null,
        sessionLoading: true, // indicates background sync
        // 视图状态跟着这个会话走：它在后台跑着，切过来就是"运行中"。
        isStreaming: !!st.runningSessions[sessionId],
      });
      return existing;
    }

    // 3. Not yet in local cache: create optimistic thread instantly (0ms)
    const newId = newThreadId();
    const inheritedMcp = threadForAgent(st.threads, agentId)?.mcpServers;
    const optimisticThread: ChatThread = {
      id: newId,
      agentId,
      sessionId,
      cwd: cwd || st.currentWorkspace,
      mcpServers: inheritedMcp,
      title: title || null,
      messages: [],
      updatedAt: Date.now(),
    };
    const nextThreads = pruneThreads({ ...st.threads, [newId]: optimisticThread }, [newId]);
    saveThreads(nextThreads);
    set({
      ...initialThread,
      sessionId,
      availableCommands: cmdsFor(st, agentId, sessionId),
      activeThreadId: newId,
      threads: nextThreads,
      sessionInfo: { ...(st.sessionInfo || {}), title: title || st.sessionInfo?.title },
      sessionError: null,
      sessionLoading: true,
      isStreaming: !!st.runningSessions[sessionId],
    });
    return optimisticThread;
  },
  resetStudio: () => {
    const s = useStudioStore.getState();
    set({
      ...initialThread,
      activeAgentId: "codex",
      connectingId: null,
      authOk: {},
      sessionId: null,
      commandsBySession: {},
      activeThreadId: null,
      // Persisted thread records survive a full reset (tests clear storage).
      threads: s.threads,
      isStreaming: false,
      streamingSessionId: null,
      runningSessions: {} as Record<string, boolean>,
      messageOwner: {} as Record<string, string>,
      drafts: {} as Record<string, string>,
      busy: false,
      discovering: false,
      authOpen: false,
      settingsOpen: false,
      providersOpen: false,
      modelsOpen: false,
      respondingId: null,
      pendingPerms: [],
      pendingElic: [],
      queuedPrompts: [],
      terminalOpen: false,
      terminalPrefill: null,
      terminalCwd: null,
      gitChangesOpen: false,
      gitDiffFile: null,
    })
  }
}));

/**
 * Shallow-selected view of the studio store.
 *
 * IMPORTANT: this deliberately does **not** subscribe to `messages`. The
 * streaming hot path writes `messages` once per token; subscribing to it at
 * shell level made App re-render (and re-render every layout child) on every
 * chunk. `messages` is consumed by the leaves that actually render it
 * (`AssistantChatView` via `useStudioStore((s) => s.messages)`), while stream callbacks
 * write through `getState()` actions, which needs no subscription at all.
 *
 * Per .agents/rules/state_management.md: subscribe with selectors, never the
 * whole store. `transients` (AbortController, StrictMode guards) stay in refs.
 */
const STUDIO_SHALLOW_SELECTOR = (s: StudioState) => ({
  // connection
  activeAgentId: s.activeAgentId,
  connectingId: s.connectingId,
  authOk: s.authOk,
  // session view
  sessionId: s.sessionId,
  sessionError: s.sessionError,
  sessionLoading: s.sessionLoading,
  modes: s.modes,
  models: s.models,
  configOptions: s.configOptions,
  availableCommands: s.availableCommands,
  usage: s.usage,
  quota: s.quota,
  sessionInfo: s.sessionInfo,
  // composer / busy
  drafts: s.drafts,
  setDraft: s.setDraft,
  attachments: s.attachments,
  isStreaming: s.isStreaming,
  streamingSessionId: s.streamingSessionId,
  runningSessions: s.runningSessions,
  setSessionRunning: s.setSessionRunning,
  busy: s.busy,
  discovering: s.discovering,
  // overlays
  authOpen: s.authOpen,
  settingsOpen: s.settingsOpen,
  providersOpen: s.providersOpen,
  modelsOpen: s.modelsOpen,
  // pending agent requests
  pendingPerms: s.pendingPerms,
  pendingElic: s.pendingElic,
  respondingId: s.respondingId,
  queuedPrompts: s.queuedPrompts,
  // workspace & desktop tools
  currentWorkspace: s.currentWorkspace,
  recentWorkspaces: s.recentWorkspaces,
  terminalOpen: s.terminalOpen,
  terminalPrefill: s.terminalPrefill,
  terminalCwd: s.terminalCwd,
  gitChangesOpen: s.gitChangesOpen,
  gitDiffFile: s.gitDiffFile,
  // thread bookkeeping
  threads: s.threads,
  activeThreadId: s.activeThreadId,
  agentPrefs: s.agentPrefs,
  autoUpdate: s.autoUpdate,
  // actions used directly from JSX (stable identity — never trigger a shallow
  // change, so including them costs nothing and avoids `getState()` in render)
  setWorkspace: s.setWorkspace,
  setTerminalOpen: s.setTerminalOpen,
  setTerminalPrefill: s.setTerminalPrefill,
  setTerminalCwd: s.setTerminalCwd,
  setGitChangesOpen: s.setGitChangesOpen,
  setAuthOpen: s.setAuthOpen,
  setSettingsOpen: s.setSettingsOpen,
  setProvidersOpen: s.setProvidersOpen,
  setModelsOpen: s.setModelsOpen,
  setAttachments: s.setAttachments,
  setMessages: s.setMessages,
  setQuota: s.setQuota,
});

export type StudioShallow = ReturnType<typeof STUDIO_SHALLOW_SELECTOR>;

/** Subscribe to the studio view state without re-rendering on `messages` writes. */
export function useStudioShallow(): StudioShallow {
  return useStudioStore(useShallow(STUDIO_SHALLOW_SELECTOR));
}

/**
 * Focused subscription for the single field the stream hot path mutates.
 * Kept separate so only the component that renders the transcript pays for it.
 */
export function useStudioMessages(): Message[] {
  return useStudioStore((s) => s.messages);
}

if (typeof window !== "undefined") {
  (window as any).__studioStore = useStudioStore;
}
