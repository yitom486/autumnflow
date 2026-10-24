import type { AcpAgentQuota } from "@yitom/acp-client";
import type { Message } from "@/lib/message-types";
import type { Attachment } from "@/lib/universal-api";
import type { ActiveTurn, QueuedPrompt } from "@/lib/threads";
import type { AgentSlice } from "./agentSlice";
import type { PrefsSlice } from "./prefsSlice";
import type { SessionSlice } from "./sessionSlice";
import type { UiSlice } from "./uiSlice";
import type { WorkspaceSlice } from "./workspaceSlice";

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
  sessionInfo: SessionInfo | null;
  modes: ModeState | null;
  /** Last ensureSession failure (non-auth), surfaced in the welcome banner. */
  sessionError: string | null;
  /** session/new in flight (drives the composer's loading shimmer). */
  sessionLoading: boolean;
  ui: SessionUi;
}

/** 会话的键：线程 id（从建线程起就稳定；ACP sessionId 要等 session/new 之后才有）。 */
export type SessionKey = string;

/** Session metadata the agent reports (session_info_update) or the app derives. */
export interface SessionInfo {
  title?: string | null;
  /** Agent-specific goal text (`_meta.goal`), shown as-is. */
  goal?: string | null;
  updatedAt?: string | null;
}

/** Account quota / rate limits of the active agent (same contract as the gateway). */
export type QuotaState = AcpAgentQuota;

/**
 * The whole studio store. Each slice owns one concern; actions may still read
 * and write across slices (an agent switch moves the session pointer, a
 * workspace switch picks that workspace's session).
 */
export type StudioState = AgentSlice &
  SessionSlice &
  WorkspaceSlice &
  PrefsSlice &
  UiSlice & {
    /** Full reset (tests / logout flows). */
    resetStudio: () => void;
  };
