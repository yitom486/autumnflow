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

/** 会话里那些"看的人"的状态：展开了哪张卡、打字机打到哪、滚到哪。 */
export interface SessionUi {
  /** 卡片 / 折叠区的展开状态，按 `${messageId}:${区块}` 记。 */
  open: Record<string, boolean>;
  /** 打字机已经揭示到的长度，按文本片段记：组件卸载时写入，重挂时从这里接着打。 */
  revealed: Record<string, number>;
  /** 切走时的滚动位置；null = 还没离开过，贴底。 */
  scroll: { top: number; pinned: boolean } | null;
}

/**
 * 一个会话的全部状态。
 *
 * 切会话只是把 `activeThreadId` 指过去，这里的东西一样不动：后台那一轮照样往
 * 自己的格子里写，组件卸载/重挂也不影响它。`threads` 只是它的持久化快照。
 */
export interface SessionState {
  messages: Message[];
  /** Durable pointer used by refresh/window recovery to follow a live turn. */
  activeTurn: ActiveTurn | null;
  /**
   * Prompts typed while the agent is still working. They are shown to the
   * user (and can be withdrawn) and are sent one by one once the current turn
   * ends. A prompt is never dropped silently.
   */
  queuedPrompts: QueuedPrompt[];
  /** 输入框草稿。 */
  draft: string;
  attachments: Attachment[];
  /** 这个会话有一轮正在跑。 */
  running: boolean;
  usage: UsageState | null;
  sessionInfo: any;
  modes: ModeState | null;
  /** Last ensureSession failure (non-auth), surfaced in the welcome banner. */
  sessionError: string | null;
  /** session/new in flight (drives the composer's loading shimmer). */
  sessionLoading: boolean;
  ui: SessionUi;
}

/** 会话的键：线程 id（从建线程起就稳定；ACP sessionId 要等 session/new 之后才有）。 */
export type SessionKey = string;

interface StudioState {
  // connection (client)
  activeAgentId: string;
  connectingId: string | null;
  authOk: Record<string, boolean | null>;
  // session (client view of server state)
  /** 当前在看的会话的 ACP sessionId。 */
  sessionId: string | null;
  models: ModelCatalog | null;
  configOptions: any[] | null;
  availableCommands: SlashCommand[];
  /** Commands per ACP session (agentId:sessionId) — survives thread/session switches. */
  commandsBySession: Record<string, SlashCommand[]>;
  quota: any | null;
  /** 每个会话一格，键是线程 id；没有线程的草稿视图用 ""。 */
  sessions: Record<SessionKey, SessionState>;
  busy: boolean;
  discovering: boolean;
  // overlays
  authOpen: boolean;
  settingsOpen: boolean;
  providersOpen: boolean;
  modelsOpen: boolean;
  // pending agent requests (each one carries its own agentId/sessionId)
  pendingPerms: PendingPermission[];
  pendingElic: PendingElicitation[];
  respondingId: string | null;

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
  /**
   * 一个会话换了 ACP sessionId（服务端把失效的会话接到新会话上）：记到它自己的
   * 线程里；是当前会话才同步到视图。
   */
  setThreadSessionId: (key: SessionKey, sessionId: string) => void;
  applySessionResult: (res: any, expectedAgentId?: string) => void;
  setModels: (m: ModelCatalog | null) => void;
  setConfigOptions: (c: any[] | null) => void;
  patchConfigOption: (opt: any) => void;
  /** Store commands for a session (defaults to the current one); updates the view when it is current. */
  setAvailableCommands: (c: unknown, sessionId?: string | null) => void;
  setQuota: (q: any | null) => void;
  // ---- 会话内的写入：不传 key 就是当前在看的会话；后台那一轮必须传自己的 key ----
  setSessionError: (e: string | null, key?: SessionKey | null) => void;
  setSessionLoading: (v: boolean, key?: SessionKey | null) => void;
  setModes: (m: ModeState | null, key?: SessionKey | null) => void;
  setUsage: (u: UsageState | null, key?: SessionKey | null) => void;
  setSessionInfo: (info: any, key?: SessionKey | null) => void;
  setMessages: (m: Message[], key?: SessionKey | null) => void;
  appendMessage: (m: Message, key?: SessionKey | null) => void;
  patchMessage: (id: string, patch: Partial<Message> | ((m: Message) => Message), key?: SessionKey | null) => void;
  /** Queue a prompt typed while the agent is still working. */
  enqueuePrompt: (text: string, key?: SessionKey | null) => string;
  /** Withdraw a queued prompt before it is sent. */
  removeQueuedPrompt: (id: string, key?: SessionKey | null) => void;
  /** Drop every queued prompt (the user stopped the run). */
  clearQueuedPrompts: (key?: SessionKey | null) => void;
  setActiveTurn: (turn: ActiveTurn | null, key?: SessionKey | null) => void;
  patchActiveTurn: (patch: Partial<ActiveTurn>, key?: SessionKey | null) => void;
  setDraft: (text: string, key?: SessionKey | null) => void;
  setAttachments: (a: Attachment[], key?: SessionKey | null) => void;
  /** 标记某个会话在跑/跑完：会话之间互不影响。 */
  setSessionRunning: (key: SessionKey, running: boolean) => void;
  /** 记下一张卡片/折叠区的展开状态。 */
  setUiOpen: (key: SessionKey, id: string, open: boolean) => void;
  /** 记下一段文本已经揭示到的长度（打字机重挂时从这里接着打）。 */
  setRevealed: (key: SessionKey, id: string, length: number) => void;
  /** 记下切走时的滚动位置。 */
  setScroll: (key: SessionKey, scroll: SessionUi["scroll"]) => void;
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
  /** Clear the current session's state (its thread record is untouched). */
  resetThread: () => void;
  /**
   * Persist a session into its thread record (defaults to the current one).
   * The current view without a thread gets one allocated here.
   */
  snapshotThread: (key?: SessionKey | null) => void;
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

/** 没有线程的草稿视图（刚切到一个还没开会话的运行时/工作区）。 */
const DRAFT_KEY: SessionKey = "";

function emptySession(): SessionState {
  return {
    messages: [],
    activeTurn: null,
    queuedPrompts: [],
    draft: "",
    attachments: [],
    running: false,
    usage: null,
    sessionInfo: null,
    modes: null,
    sessionError: null,
    sessionLoading: false,
    ui: { open: {}, revealed: {}, scroll: null },
  };
}

/** 读不到的会话一律读这一份（固定引用，selector 不会因此每次都变）。 */
export const EMPTY_SESSION: SessionState = emptySession();

/** 当前在看的会话的键。 */
export const activeKey = (s: { activeThreadId: string | null }): SessionKey => s.activeThreadId ?? DRAFT_KEY;

/** 某个会话的状态（默认当前在看的那个）。 */
export function sessionOf(
  s: { sessions: Record<SessionKey, SessionState>; activeThreadId: string | null },
  key?: SessionKey | null
): SessionState {
  return s.sessions[key ?? activeKey(s)] ?? EMPTY_SESSION;
}

/** 从持久化的线程记录铺出一个会话（第一次打开它时）。 */
function sessionFromThread(t: ChatThread | undefined): SessionState {
  const b = emptySession();
  if (!t) return b;
  const title = titleForThread(t);
  return {
    ...b,
    messages: mergeAssistantTurns(t.messages),
    activeTurn: t.activeTurn ?? null,
    queuedPrompts: t.queuedPrompts ?? [],
    sessionInfo: title ? { title } : null,
  };
}

type SessionsSlice = Pick<StudioState, "sessions" | "threads" | "activeThreadId">;

/** 改一个会话的格子（不管它是不是当前在看的）。 */
function patchSessionIn(
  s: SessionsSlice,
  key: SessionKey | null | undefined,
  patch: Partial<SessionState> | ((b: SessionState) => Partial<SessionState>)
): { sessions: Record<SessionKey, SessionState> } {
  const k = key ?? activeKey(s);
  const cur = s.sessions[k] ?? sessionFromThread(s.threads[k]);
  const next = typeof patch === "function" ? patch(cur) : patch;
  return { sessions: { ...s.sessions, [k]: { ...cur, ...next } } };
}

/** 切到一个会话时保证它有格子：已经有就原样用（后台跑着的那一轮就在里面）。 */
function ensureSessionIn(s: SessionsSlice, key: SessionKey): Record<SessionKey, SessionState> {
  const live = s.sessions[key];
  if (!live) return { ...s.sessions, [key]: sessionFromThread(s.threads[key]) };
  // The header title lives on the record once the thread has one.
  const title = live.sessionInfo?.title ? null : titleForThread(s.threads[key]);
  if (!title) return s.sessions;
  return { ...s.sessions, [key]: { ...live, sessionInfo: { ...(live.sessionInfo || {}), title } } };
}

/**
 * Prune + persist with every session's live state folded into its record: a
 * session that has not been snapshotted yet (opened from a replay, running in
 * the background) must never be dropped as an empty thread.
 */
function pruneLive(
  s: Pick<StudioState, "sessions">,
  threads: Record<string, ChatThread>,
  preserveIds: string[]
): Record<string, ChatThread> {
  const merged = { ...threads };
  const keep = [...preserveIds];
  for (const [key, b] of Object.entries(s.sessions)) {
    const t = merged[key];
    if (!t) continue;
    if (b.messages.length) merged[key] = { ...t, messages: b.messages, queuedPrompts: b.queuedPrompts };
    if (b.running) keep.push(key);
  }
  return pruneThreads(merged, keep);
}

/** 有一轮在跑的会话，按 ACP sessionId 列出（侧栏的"运行中"标记用）。 */
export function runningSessionIds(s: Pick<StudioState, "sessions" | "threads">): Record<string, true> {
  const out: Record<string, true> = {};
  for (const [key, b] of Object.entries(s.sessions)) {
    const sid = b.running ? s.threads[key]?.sessionId : null;
    if (sid) out[sid] = true;
  }
  return out;
}

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
  sessions: {} as Record<SessionKey, SessionState>,
  autoUpdate: loadAutoUpdate(),
  // Show the last known catalog instantly; a fresh session/new will replace it.
  models: initialCatalog?.models ?? null,
  configOptions: initialCatalog?.configOptions ?? null,
  availableCommands: [] as SlashCommand[],
  quota: null,
  pendingPerms: [] as PendingPermission[],
  pendingElic: [] as PendingElicitation[],
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
        const live = sessionOf(s);
        if (s.activeThreadId && live.messages.length > 0) {
          const cur = s.threads[s.activeThreadId];
          if (cur) {
            const updated = {
              ...cur,
              messages: live.messages,
              sessionId: s.sessionId ?? (cur.stale ? cur.sessionId : null),
              cwd: s.currentWorkspace,
              updatedAt: Date.now(),
            };
            const nextThreads = pruneLive(s, { ...s.threads, [cur.id]: updated }, [cur.id]);
            saveThreads(nextThreads);
          }
        }

        // 2. 检索目标工作区是否已有历史会话：切过去只是换指针，它自己的格子原样在
        const existing = threadForAgent(s.threads, s.activeAgentId, targetPath);
        const cached = readCachedCatalog(s.activeAgentId);
        if (existing) {
          const sid = existing.stale ? null : existing.sessionId;
          return {
            currentWorkspace: targetPath,
            recentWorkspaces: nextRecents,
            models: cached?.models ?? null,
            configOptions: cached?.configOptions ?? null,
            sessionId: sid,
            availableCommands: cmdsFor(s, s.activeAgentId, sid),
            activeThreadId: existing.id,
            sessions: ensureSessionIn(s, existing.id),
          };
        } else {
          // 3. 目标工作区尚无会话：指向一份崭新的草稿
          return {
            currentWorkspace: targetPath,
            recentWorkspaces: nextRecents,
            models: cached?.models ?? null,
            configOptions: cached?.configOptions ?? null,
            sessionId: null,
            availableCommands: [],
            activeThreadId: null,
            sessions: { ...s.sessions, [DRAFT_KEY]: emptySession() },
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
  setThreadSessionId: (key, sessionId) => {
    if (key === activeKey(get())) {
      get().setSessionId(sessionId);
      return;
    }
    set((s) => {
      const t = s.threads[key];
      if (!t || t.sessionId === sessionId) return {};
      return { threads: { ...s.threads, [key]: { ...t, sessionId, stale: false } } };
    });
  },
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
        models: nextModels,
        configOptions: nextConfigOptions,
        availableCommands: fromRes ?? (sid === s.sessionId && s.availableCommands.length ? s.availableCommands : map[cmdKey(s.activeAgentId, sid)] ?? []),
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
  setQuota: (q) => set({ quota: q }),
  setSessionError: (e, key) => set((s) => patchSessionIn(s, key, { sessionError: e })),
  setSessionLoading: (v, key) => set((s) => patchSessionIn(s, key, { sessionLoading: v })),
  setModes: (m, key) => set((s) => patchSessionIn(s, key, { modes: m })),
  setUsage: (u, key) => set((s) => patchSessionIn(s, key, { usage: u })),
  setSessionInfo: (info, key) => set((s) => patchSessionIn(s, key, { sessionInfo: info })),
  setMessages: (m, key) => set((s) => patchSessionIn(s, key, { messages: mergeAssistantTurns(m) })),
  appendMessage: (m, key) =>
    set((s) => patchSessionIn(s, key, (b) => ({ messages: mergeAssistantTurns([...b.messages, m]) }))),
  patchMessage: (id, patch, key) =>
    set((s) =>
      patchSessionIn(s, key, (b) => ({
        messages: b.messages.map((m) =>
          m.id === id ? (typeof patch === "function" ? patch(m) : { ...m, ...patch }) : m
        ),
      }))
    ),
  enqueuePrompt: (text, key) => {
    const item: QueuedPrompt = { id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, text, createdAt: Date.now() };
    // 排队是会话内的事：挂在所属会话上，别让 A 会话的队列跑到 B 会话去。
    set((s) => patchSessionIn(s, key, (b) => ({ queuedPrompts: [...b.queuedPrompts, item] })));
    return item.id;
  },
  removeQueuedPrompt: (id, key) =>
    set((s) => patchSessionIn(s, key, (b) => ({ queuedPrompts: b.queuedPrompts.filter((item) => item.id !== id) }))),
  clearQueuedPrompts: (key) => set((s) => patchSessionIn(s, key, { queuedPrompts: [] })),
  setActiveTurn: (turn, key) => set((s) => patchSessionIn(s, key, { activeTurn: turn })),
  patchActiveTurn: (patch, key) =>
    set((s) => patchSessionIn(s, key, (b) => ({ activeTurn: b.activeTurn ? { ...b.activeTurn, ...patch } : null }))),
  setDraft: (text, key) => set((s) => (sessionOf(s, key).draft === text ? s : patchSessionIn(s, key, { draft: text }))),
  setAttachments: (a, key) => set((s) => patchSessionIn(s, key, { attachments: a })),
  setSessionRunning: (key, running) =>
    set((s) => (sessionOf(s, key).running === running ? s : patchSessionIn(s, key, { running }))),
  setUiOpen: (key, id, open) =>
    set((s) => patchSessionIn(s, key, (b) => ({ ui: { ...b.ui, open: { ...b.ui.open, [id]: open } } }))),
  setRevealed: (key, id, length) =>
    set((s) =>
      sessionOf(s, key).ui.revealed[id] === length
        ? s
        : patchSessionIn(s, key, (b) => ({ ui: { ...b.ui, revealed: { ...b.ui.revealed, [id]: length } } }))
    ),
  setScroll: (key, scroll) => set((s) => patchSessionIn(s, key, (b) => ({ ui: { ...b.ui, scroll } }))),
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
  resetThread: () =>
    set((s) => ({
      models: null,
      configOptions: null,
      availableCommands: [],
      quota: null,
      sessions: { ...s.sessions, [activeKey(s)]: emptySession() },
    })),
  snapshotThread: (key) =>
    set((s) => {
      const isView = key == null || key === activeKey(s);
      // 后台的会话：只有已经有线程记录的才落盘（它的元数据都在记录上）。
      if (!isView && !s.threads[key!]) return {};
      const id = isView ? s.activeThreadId ?? newThreadId() : key!;
      const live = sessionOf(s, isView ? activeKey(s) : key);
      const prev = s.threads[id];
      const thread: ChatThread = {
        ...prev,
        id,
        // The view's thread belongs to the active agent; a background one
        // keeps the agent/session/cwd it was recorded with.
        agentId: isView ? s.activeAgentId : prev!.agentId,
        // Keep the user-facing name on the persisted record so the sidebar can
        // show content instead of an opaque session id.
        title: titleForThread({ title: prev?.title, messages: live.messages }),
        // Keep the historical id, and keep the stale marker so the next boot
        // does not try to resume the same dead id all over again.
        sessionId: isView ? s.sessionId ?? (prev?.stale ? prev.sessionId : null) : prev!.sessionId,
        stale: prev?.stale ? true : undefined,
        cwd: isView ? s.currentWorkspace ?? prev?.cwd ?? null : prev!.cwd,
        messages: live.messages,
        activeTurn: live.activeTurn ? { ...live.activeTurn, persistedSeq: live.activeTurn.lastSeq } : undefined,
        queuedPrompts: live.queuedPrompts,
        // Preserve the thread's MCP servers across snapshots (auto new/resume).
        mcpServers: prev?.mcpServers,
        updatedAt: Date.now(),
      };
      const next = pruneLive(s, { ...s.threads, [id]: thread }, [id]);
      saveThreads(next);
      // 草稿视图第一次落盘：它的格子搬到新线程名下，指针跟过去。
      if (isView && !s.activeThreadId) {
        const { [DRAFT_KEY]: draft, ...rest } = s.sessions;
        return { threads: next, activeThreadId: id, sessions: { ...rest, [id]: draft ?? emptySession() } };
      }
      return { threads: next };
    }),
  restoreThread: (agentId, targetCwd) => {
    const s = get();
    const cwd = targetCwd !== undefined ? targetCwd : s.currentWorkspace;
    const t = threadForAgent(s.threads, agentId, cwd);
    if (!t) return null;
    const cached = readCachedCatalog(agentId);
    // A stale thread is a read-only historical transcript: showing its dead
    // id as the live session is what made resume/ensureSession loop forever.
    const sid = t.stale ? null : t.sessionId;
    set({
      models: cached?.models ?? null,
      configOptions: cached?.configOptions ?? null,
      sessionId: sid,
      availableCommands: cmdsFor(s, agentId, sid),
      activeThreadId: t.id,
      sessions: ensureSessionIn(s, t.id),
    });
    return t;
  },
  newThread: (agentId, targetCwd) => {
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
    const next = pruneLive(s0, { ...s0.threads, [t.id]: t }, [t.id]);
    saveThreads(next);
    const cached = readCachedCatalog(agentId);
    set((s) => ({
      models: cached?.models ?? null,
      configOptions: cached?.configOptions ?? null,
      availableCommands: [],
      sessionId: null,
      threads: next,
      activeThreadId: t.id,
      sessions: { ...s.sessions, [t.id]: emptySession() },
    }));
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
        title: titleForThread({ title: cur.title, messages: sessionOf(s).messages.length ? sessionOf(s).messages : cur.messages }),
        cwd: cwd !== undefined ? cwd : cur.cwd,
        mcpServers: mcpServers !== undefined ? mcpServers : cur.mcpServers,
        stale: false,
        updatedAt: Date.now(),
      };
      const threads = pruneLive(s, { ...s.threads, [next.id]: next }, [next.id]);
      saveThreads(threads);
      return { sessionId, threads };
    }),
  markThreadStale: () =>
    set((s) => {
      if (!s.activeThreadId) return {};
      const cur = s.threads[s.activeThreadId];
      if (!cur) return {};
      const next = { ...cur, stale: true, updatedAt: Date.now() };
      const threads = pruneLive(s, { ...s.threads, [next.id]: next }, [next.id]);
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
      const threads = pruneLive(s, { ...s.threads, [next.id]: next }, [next.id]);
      saveThreads(threads);
      return { threads };
    }),
  optimisticOpenSession: (agentId, sessionId, title, cwd) => {
    // 1. Persist the session we are leaving (its live state stays in memory).
    get().snapshotThread();
    const st = get();

    // 2. Known session: point the view at it. Its own state — a turn still
    //    running in the background included — is exactly what shows up.
    const existing = findThreadBySessionId(st.threads, agentId, sessionId);
    if (existing) {
      set((s) => {
        const sessions = ensureSessionIn(s, existing.id);
        const b = sessions[existing.id];
        return {
          sessionId,
          availableCommands: cmdsFor(s, agentId, sessionId),
          activeThreadId: existing.id,
          sessions: {
            ...sessions,
            [existing.id]: {
              ...b,
              sessionInfo: { ...(b.sessionInfo || {}), title: titleForThread(existing) || title || b.sessionInfo?.title },
              sessionError: null,
              sessionLoading: true, // indicates background sync
            },
          },
        };
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
    const nextThreads = pruneLive(st, { ...st.threads, [newId]: optimisticThread }, [newId]);
    saveThreads(nextThreads);
    set((s) => ({
      sessionId,
      availableCommands: cmdsFor(s, agentId, sessionId),
      activeThreadId: newId,
      threads: nextThreads,
      sessions: {
        ...s.sessions,
        [newId]: { ...emptySession(), sessionInfo: title ? { title } : null, sessionLoading: true },
      },
    }));
    return optimisticThread;
  },
  resetStudio: () => {
    const s = get();
    set({
      activeAgentId: "codex",
      connectingId: null,
      authOk: {},
      sessionId: null,
      commandsBySession: {},
      activeThreadId: null,
      sessions: {},
      models: null,
      configOptions: null,
      availableCommands: [],
      quota: null,
      // Persisted thread records survive a full reset (tests clear storage).
      threads: s.threads,
      busy: false,
      discovering: false,
      authOpen: false,
      settingsOpen: false,
      providersOpen: false,
      modelsOpen: false,
      respondingId: null,
      pendingPerms: [],
      pendingElic: [],
      terminalOpen: false,
      terminalPrefill: null,
      terminalCwd: null,
      gitChangesOpen: false,
      gitDiffFile: null,
    });
  },
}));

/**
 * Shallow-selected view of the studio store.
 *
 * IMPORTANT: this deliberately does **not** subscribe to `messages`. The
 * streaming hot path writes `messages` once per token; subscribing to it at
 * shell level made App re-render (and re-render every layout child) on every
 * chunk. `messages` is consumed by the leaves that actually render it
 * (`AssistantChatView` via `useStudioMessages`), while stream callbacks
 * write through `getState()` actions, which needs no subscription at all.
 *
 * The session fields below are read through the view pointer: they belong to
 * the session being looked at, not to the store.
 *
 * Per .agents/rules/state_management.md: subscribe with selectors, never the
 * whole store. `transients` (AbortController, StrictMode guards) stay in refs.
 */
const STUDIO_SHALLOW_SELECTOR = (s: StudioState) => {
  const view = sessionOf(s);
  return {
    // connection
    activeAgentId: s.activeAgentId,
    connectingId: s.connectingId,
    authOk: s.authOk,
    // session view (the session the pointer is on)
    sessionId: s.sessionId,
    sessionError: view.sessionError,
    sessionLoading: view.sessionLoading,
    modes: view.modes,
    usage: view.usage,
    sessionInfo: view.sessionInfo,
    queuedPrompts: view.queuedPrompts,
    attachments: view.attachments,
    isStreaming: view.running,
    models: s.models,
    configOptions: s.configOptions,
    availableCommands: s.availableCommands,
    quota: s.quota,
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
  };
};

export type StudioShallow = ReturnType<typeof STUDIO_SHALLOW_SELECTOR>;

/** Subscribe to the studio view state without re-rendering on `messages` writes. */
export function useStudioShallow(): StudioShallow {
  return useStudioStore(useShallow(STUDIO_SHALLOW_SELECTOR));
}

/** Read one thing from the session the view is on. */
export function useActiveSession<T>(select: (b: SessionState) => T): T {
  return useStudioStore((s) => select(sessionOf(s)));
}

/**
 * Focused subscription for the single field the stream hot path mutates.
 * Kept separate so only the component that renders the transcript pays for it.
 */
export function useStudioMessages(): Message[] {
  return useStudioStore((s) => sessionOf(s).messages);
}

/** ACP session ids with a turn running right now (one per session, in parallel). */
export function useRunningSessionIds(): Record<string, true> {
  return useStudioStore(useShallow(runningSessionIds));
}

if (typeof window !== "undefined") {
  (window as any).__studioStore = useStudioStore;
}
