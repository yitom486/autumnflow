/** 前端统一消息模型（store / assistant-ui 适配 / 线程持久化共用）。 */
export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 中间阶段执行过程文本（多阶段/工具调用时自动收拢折叠，正文区仅展示最终结论）。 */
  progressContent?: string;
  thought?: string;
  contentBlocks?: import("@agentclientprotocol/sdk").ContentBlock[];
  artifacts?: import("../../shared/acp-session-state").SessionArtifact[];
  plan?: Array<{ content: string; priority?: string; status?: string }>;
  usage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string };
    /** 可选的缓存/输入/输出计数（agent 下发才有，UsagePanel 按需显示）。 */
    cachedTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    sessionInputTokens?: number;
    sessionOutputTokens?: number;
    sessionTotalTokens?: number;
  };
  model?: string;
  mode?: string;
  timestamp: string;
  toolCalls?: Array<{
    id: string;
    title: string;
    kind?: string;
    status: "pending" | "in_progress" | "running" | "completed" | "failed" | "cancelled";
    /** Client-observed wall clock (epoch ms): first sighting / terminal update. */
    startedAt?: number;
    completedAt?: number;
    /** Rich payloads (allowlisted from tool_call(_update), display-only). */
    name?: string;
    rawInput?: unknown;
    content?: import("@agentclientprotocol/sdk").ToolCallContent[];
    locations?: Array<{ path: string; line?: number }>;
    rawOutput?: unknown;
    rawError?: unknown;
  }>;
  isStreaming?: boolean;
  /** Agent-sent images (live-view only, stripped on persist like toolCalls). */
  images?: Array<{ src: string; mimeType: string }>;
  /** Client-observed turn timing (epoch ms): placeholder append -> turn end. */
  startedAt?: number;
  completedAt?: number;
  /** Client-observed reasoning timing: first thought chunk -> turn end. */
  thoughtTiming?: { startedAt?: number; completedAt?: number };
  /** Grounded citations or reference sources. */
  citations?: Array<{ id: string; title: string; domain?: string; url?: string; icon?: any }>;
  /** Background subagent or runtime status hint (e.g. "子智能体协同生成中", "深度推理与计算中"). */
  statusHint?: string;
}
