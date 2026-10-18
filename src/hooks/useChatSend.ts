import { useCallback, useRef } from "react";
import { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import { applyArtifactUpdate, artifactKey, updateKey } from "../../shared/acp-session-state";
import type { QueryClient } from "@tanstack/react-query";
import { useStudioStore } from "@/stores/useStudioStore";
import { invalidateSessions, acpKeys } from "@/lib/acp-queries";
import type { SessionItem } from "@/components/universal/Sidebar";
import {
  connectAgent,
  sessionRpc,
  consumeUniversalChat,
  respondPermission,
  respondElicitation,
  isAuthRequiredError,
  pickUsageExtras,
  type UsageUpdate,
  type ActivityEvent,
  type AgentSummary,
  type PendingPermission,
  type PendingElicitation,
} from "@/lib/universal-api";
import { parseRateLimitsFromStatusText } from "@/lib/quota-parser";
import { isBootstrapHint, statusTextForUpdate } from "@/lib/agent-status";
import {
  isGenerativeTool,
  appendGenerativeToolPlaceholder,
  hasGenerativeToolPlaceholder,
} from "@/components/assistant/toolkit";
import { resolveToolDisplayTitle } from "@/components/assistant/tool-widget-utils";
import { titleForThread } from "@/lib/threads";
import { FrameBatcher } from "@/lib/frame-batcher";
import { clearTurnLive, markTurnLive } from "@/lib/live-turns";

export interface UseChatSendOptions {
  qc: QueryClient;
  agentsRef: React.RefObject<AgentSummary[]>;
  resolveSession: (agentId: string) => Promise<string | null>;
  now?: () => string;
  /**
   * Stream retry policy. Auto-retries TRANSIENT failures only (network/
   * timeout/5xx class) — never aborts (user stop), auth errors, or
   * semantic failures. Manual retry remains the ↻ regenerate button.
   */
  retry?: {
    max?: number;
    delayMs?: (attempt: number) => number;
  };
}

const DEFAULT_RETRY = {
  max: 2,
  delayMs: (attempt: number) => 1000 * 2 ** (attempt - 1),
};

/** True for failures worth an automatic resend (transport-level, likely fleeting). */
export function isTransientSendError(err: unknown): boolean {
  if (!err) return false;
  if ((err as { name?: unknown } | null)?.name === "AbortError") return false;
  if ((err as { terminal?: unknown } | null)?.terminal === true) return false;
  if (isAuthRequiredError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /fetch failed|failed to fetch|networkerror|network request failed|load failed|timeout|timed out|econnreset|econnrefused|epipe|socket hang up|connection reset|temporarily|try again|rate limit|too many requests|429|50[0234]|service unavailable|bad gateway|gateway timeout|not ready|eof|unexpected eof|eligibility check failed/i.test(
    msg
  );
}

const RETRY_NOTE_RE = /\n\n> 🔁 连接中断，正在重试[^\n]*\n?/g;

/** Strip auto-retry status notes after a successful resend. */
export function stripRetryNotes(content: string): string {
  return content.replace(RETRY_NOTE_RE, "");
}

function sleepAbortable(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const defaultNow = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Appends a formatted system message for non-chat activity notifications (fs, terminal, compaction), or attaches to active assistant turn. */
export function appendActivityMessage(a: ActivityEvent, timestamp: string, assistantId?: string) {
  if (!a?.kind || a.kind === "session_info_update" || a.kind.endsWith("_update") || a.kind === "plan") {
    return;
  }
  let summary = "";
  try {
    const d: any = a.detail || {};
    summary = d.path || d.command || d.terminalId || d.status || (typeof d === "string" ? d : "");
  } catch {
    summary = "";
  }
  if (!summary) return;

  // 智能体流式生成期间：绝不在助手轮次中编造伪工具调用，也绝不插入孤立的 system 消息打断气泡流。
  // 智能体本身会经由 ACP 协议（onToolCall / onToolCallUpdate）自主下发真实的工具调用。
  // 伪造工具或插入额外消息会破坏真实的后端 AI 运行时状态。
  if (assistantId && (a.kind.startsWith("fs_") || a.kind.startsWith("terminal_"))) {
    return;
  }

  const icon =
    a.kind === "fs_read"
      ? "📖"
      : a.kind === "fs_write"
        ? "📝"
        : a.kind.startsWith("terminal")
          ? "▶️"
          : a.kind.startsWith("compaction")
            ? "🗜️"
            : a.kind.startsWith("plan")
              ? "📋"
              : "🔧";
  const line = `${icon} [${a.kind}] ${summary}`.trim();
  useStudioStore.getState().appendMessage({
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role: "system",
    content: line,
    timestamp,
  });
}

/**
 * Chat turn orchestration, streaming SSE consumption, and cancellation hook.
 *
 * Implements:
 * 1. handleSend: atomic turn initialization, wall-clock timing, 17 SSE event handlers,
 *    and async snapshotThread microtask.
 * 2. handleStop: abort controller + sessionRpc("cancel") + completedAt mark.
 * 3. handlePermRespond & handleElicRespond: inline & dialog approval responses.
 */
export function useChatSend({
  qc,
  agentsRef,
  resolveSession,
  now = defaultNow,
  retry,
}: UseChatSendOptions) {
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const retryMax = retry?.max ?? DEFAULT_RETRY.max;
  const retryDelayMs = retry?.delayMs ?? DEFAULT_RETRY.delayMs;

  const handleSend = useCallback(
    async (textToSend?: string) => {
      const st = useStudioStore.getState();
      const prompt = (textToSend ?? st.input).trim();
      if ((!prompt && st.attachments.length === 0) || st.isStreaming || sendingRef.current) return;
      sendingRef.current = true;
      const agentId = st.activeAgentId;
      const blocks: Record<string, unknown>[] = [
        ...st.attachments.map((a) => a.block),
        ...(prompt ? [{ type: "text", text: prompt }] : []),
      ];
      const display =
        prompt +
        (st.attachments.length > 0
          ? `\n\n[附件: ${st.attachments.map((a) => a.name).join(", ")}]`
          : "");
      st.setInput("");
      st.setAttachments([]);

      // If currently active thread was marked stale (historical view), start fresh thread for this prompt
      const curThread0 = st.activeThreadId ? st.threads[st.activeThreadId] : undefined;
      if (curThread0?.stale) {
        st.newThread(agentId);
      }

      const assistantId = "asst-" + Date.now();
      // Server-side idempotency key: retries attach to this turn instead of
      // prompting the agent again.
      const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      // 发出的图片也显示在用户消息里（与历史回放一致）
      const sentImages = st.attachments
        .filter((a) => (a.block as any).type === "image" && typeof (a.block as any).data === "string")
        .map((a) => ({ src: `data:${(a.block as any).mimeType || a.mimeType};base64,${(a.block as any).data}`, mimeType: String((a.block as any).mimeType || a.mimeType) }))
        .slice(-8);
      let turnStarted = false;
      // Assigned once the assistant bubble exists; outer catch/finally still
      // need to flush any coalesced tail before stamping the turn end.
      let flushPending = () => {};
      let disposeBatching = () => {};
      let stopPersisting = () => {};
      const beginTurn = (initialHint?: string) => {
        const current = useStudioStore.getState();
        if (turnStarted && current.messages.some((m) => m.id === assistantId)) {
          if (initialHint) {
            current.patchMessage(assistantId, (m) => ({ ...m, statusHint: initialHint }));
          }
          return;
        }
        turnStarted = true;
        const wasEmpty = !current.messages.some((m) => m.role === "user" && m.content.trim());
        current.appendMessage({ id: "user-" + Date.now(), role: "user", content: display, timestamp: now(), ...(sentImages.length ? { images: sentImages } : {}) });
        if (wasEmpty) {
          const title = titleForThread({ messages: [{ role: "user", content: display } as any] });
          if (title) current.setSessionInfo({ ...(current.sessionInfo || {}), title });
        }
        current.appendMessage({
          id: assistantId,
          role: "assistant",
          turnId,
          content: "",
          thought: "",
          plan: [],
          toolCalls: [],
          timestamp: now(),
          isStreaming: true,
          startedAt: Date.now(),
          statusHint: initialHint,
        });
        current.setActiveTurn({
          turnId,
          lastSeq: 0,
          status: "running",
          assistantId,
          startedAt: Date.now(),
        });
        markTurnLive(turnId);
        // Persist the user prompt immediately so a refresh during the first
        // second can still reattach instead of showing an empty conversation.
        useStudioStore.getState().snapshotThread();
      };
      abortRef.current = new AbortController();

      // Real wall-clock timing (client-observed): tool start = first sighting,
      // tool end = first terminal status; turn end = done/error/abort.
      const TERMINAL_TOOL = new Set(["completed", "failed", "cancelled"]);
      const stampTurnEnd = (id: string) => {
        const t = Date.now();
        useStudioStore.getState().patchMessage(id, (m) => ({
          ...m,
          isStreaming: false,
          statusHint: undefined,
          completedAt: m.completedAt ?? t,
          thoughtTiming:
            m.thoughtTiming?.startedAt && !m.thoughtTiming.completedAt
              ? { ...m.thoughtTiming, completedAt: t }
              : m.thoughtTiming,
        }));
      };

      try {
        const known = agentsRef.current.find((a) => a.id === agentId)?.status?.connected;
        if (!known) {
          await connectAgent(agentId);
        }
        let sid = useStudioStore.getState().sessionId;
        if (!sid) {
          // Resolve the clean draft before marking a turn as streaming. Session
          // resolution intentionally refuses to create sessions during a stream;
          // setting that flag first makes an early first send fail with no ID.
          sid = await resolveSession(agentId);
          if (!sid) throw new Error("无法创建会话");
        }
        // A cold agent (`bunx @deepseek-ai/dsh@latest`) spends its first seconds
        // in spawn + session/new; label that instead of a bare "等待响应…".
        beginTurn(known ? "等待响应…" : "正在启动 Agent…（首次或升级后可能较慢）");
        st.setStreaming(true);
        useStudioStore.getState().patchMessage(assistantId, (m) => ({
          ...m,
          statusHint: m.statusHint || "等待响应…",
        }));
        const cur = useStudioStore.getState();
        // Transient transport failures (dropped SSE, gateway hiccup) resend
        // automatically with backoff; the retry note is stripped on success.
        // Anything else (abort/auth/semantic) falls through to the handlers below.
        let attempt = 0;
        // Once the server has accepted the turn, retries must be read-only
        // GET /follow; only a pre-accept failure may POST the prompt again.
        let accepted = false;
        // Highest SSE sequence already rendered. Sent back as afterSeq so a
        // reconnect replays only the missing tail, never duplicate chunks.
        let lastSeq = 0;
        // Coalesce token-rate writes to one UI commit per animation frame.
        const textBatcher = new FrameBatcher((text) => {
          useStudioStore.getState().patchMessage(assistantId, (m) => ({
            ...m,
            content: m.content + text,
            statusHint: undefined,
          }));
        });
        let thoughtStartedAt = 0;
        const thoughtBatcher = new FrameBatcher((text) => {
          useStudioStore.getState().patchMessage(assistantId, (m) => ({
            ...m,
            thought: (m.thought || "") + text,
            statusHint: "正在思考…",
            thoughtTiming: m.thoughtTiming ?? { startedAt: thoughtStartedAt || Date.now() },
          }));
        });
        const flushPendingNow = () => {
          textBatcher.flush();
          thoughtBatcher.flush();
        };
        flushPending = flushPendingNow;
        disposeBatching = () => {
          textBatcher.dispose();
          thoughtBatcher.dispose();
        };
        const persistActiveTurn = () => {
          const st = useStudioStore.getState();
          if (st.activeTurn?.turnId !== turnId) return;
          st.snapshotThread();
        };
        const persistTimer = setInterval(persistActiveTurn, 1500);
        const onPageHide = () => {
          flushPending();
          persistActiveTurn();
        };
        window.addEventListener("pagehide", onPageHide);
        stopPersisting = () => {
          clearInterval(persistTimer);
          window.removeEventListener("pagehide", onPageHide);
        };
        // Terminal error reporting (auth modal, ❌ note, turn stamp).
        // Stale retry notes are stripped first so a dead "retrying…" line
        // never survives next to the final error.
        const reportError = (err: any) => {
          const c2 = useStudioStore.getState();
          if (isAuthRequiredError(err)) {
            c2.setAuthOk(agentId, false);
            c2.setAuthOpen(true);
          }
          const isToolCallDesync =
            typeof err?.message === "string" &&
            (err.message.includes("No tool output found") ||
              err.message.includes("tool call output") ||
              err.message.includes("tool_call_id"));
          // DSH composes two DeepSeek routes: `deepseek-official` (API key) and
          // `deepseek-account` (platform login). The ACP profile defaults to the
          // API-key route, so a logged-in account without DEEPSEEK_API_KEY fails
          // every turn until the model is switched or the key is stored.
          const isDeepseekKeyMissing =
            typeof err?.message === "string" && /no API key for provider route/i.test(err.message);
          const diagnosticHint = isToolCallDesync
            ? "\n\n> 💡 **会话上下文失步诊断**：智能体在工具调用异常后遗漏了回包（Tool Call 状态断裂），导致上游模型服务拒绝了当前历史记录。建议点击**新建会话**以开启干净上下文继续任务。"
            : isDeepseekKeyMissing
              ? "\n\n> 💡 **DeepSeek 凭据未配置**：当前模型走 `deepseek-official`（API Key 路由），但 DSH 里没有 `DEEPSEEK_API_KEY`。\n> 1. 打开模型菜单，切换到 **DeepSeek Account** 分组里的同名模型（复用你已登录的平台账户）；\n> 2. 或在 DSH 设置（`dsh --profile web` → 设置 → 模型）里保存 API Key，或在启动 AutumnFlow 前 `export DEEPSEEK_API_KEY=…`。"
              : "";
          c2.patchMessage(assistantId, (m) => ({
            ...m,
            content: stripRetryNotes(m.content) + `\n\n> ❌ [${agentId}] ${err.message}${diagnosticHint}`,
          }));
          c2.patchActiveTurn({ status: "error", lastSeq });
          stampTurnEnd(assistantId);
        };
        // Retryable when: budget left, not user-aborted, transport-level failure.
        // Auth/semantic errors and aborts are never retried.
        const shouldRetry = (err: any) =>
          attempt < retryMax &&
          !abortRef.current?.signal.aborted &&
          isTransientSendError(err);
        for (;;) {
          let failedErr: any = null;
          try {
            const result = await consumeUniversalChat(
              { agentId, sessionId: sid, prompt: blocks, turnId, afterSeq: lastSeq },
              {
            onSequence: (seq) => {
              lastSeq = seq;
              useStudioStore.getState().patchActiveTurn({ lastSeq: seq });
            },
            onReset: (reset) => {
              if (reset.reason !== "gap" && reset.reason !== "ahead") return;
              // The server retained only a suffix (or we are ahead of it).
              // Rebuild the assistant bubble from the retained replay instead
              // of duplicating a prefix we can no longer reconcile.
              lastSeq = Math.max(0, reset.firstSeq - 1);
              useStudioStore.getState().patchActiveTurn({ lastSeq });
              useStudioStore.getState().patchMessage(assistantId, (m) => ({
                ...m,
                content: "",
                thought: "",
                toolCalls: [],
              }));
            },
            onConnect: () => {
              accepted = true;
              // 传输通道连接就绪，不写入虚假「深入思考」文案，等待后端下发首个真实事件
            },
            onSessionId: (id) => {
              useStudioStore.getState().setSessionId(id);
            },
            onStateUpdate: (state) => {
              if (state === "idle") {
                useStudioStore.getState().patchMessage(assistantId, (m) => ({ ...m, statusHint: undefined }));
                return;
              }
              const text = statusTextForUpdate("state_update", { state });
              if (!text) return;
              useStudioStore.getState().patchMessage(assistantId, (m) => {
                // running 是兜底态：已经有更具体的事件文案（工具 / 子智能体 / 压缩）时不要顶掉
                if (state === "running" && m.statusHint && !isBootstrapHint(m.statusHint)) return m;
                return { ...m, statusHint: text };
              });
            },
            onNotice: (n) => {
              const text = statusTextForUpdate("notice", { message: n.message });
              if (text) {
                useStudioStore.getState().patchMessage(assistantId, (m) => ({ ...m, statusHint: text }));
              }
            },
            onTextChunk: (chunk) => textBatcher.push(chunk),
            onThoughtChunk: (chunk) => {
              if (!thoughtStartedAt) thoughtStartedAt = Date.now();
              thoughtBatcher.push(chunk);
            },
            onImageChunk: (img) => {
              flushPending();
              useStudioStore.getState().patchMessage(assistantId, (m) => {
                const images = [...(m.images || []), img];
                if (images.length > 8) {
                  console.debug("[App] 图片附件超限，已丢弃旧图 (保留最新 8 张)");
                }
                return { ...m, images: images.slice(-8) };
              });
            },
            onToolCall: (c) => {
              flushPending();
              useStudioStore.getState().patchMessage(assistantId, (m) => {
                const isGen = isGenerativeTool(c);
                const displayTitle = resolveToolDisplayTitle(c);
                let newContent = m.content;

                if (isGen) {
                  // 生成式 UI 工具与前文属于同一完整阅读流，直接在正文当前位置打入内联占位符
                  newContent = appendGenerativeToolPlaceholder(newContent, c.id);
                }

                return {
                  ...m,
                  content: newContent,
                  statusHint: statusTextForUpdate("tool_call", { title: displayTitle }) ?? m.statusHint,
                  toolCalls: [
                    ...(m.toolCalls || []),
                    {
                      ...c,
                      startedAt: Date.now(),
                    },
                  ],
                };
              });
            },
            onToolCallUpdate: (c) => {
              flushPending();
              useStudioStore.getState().patchMessage(assistantId, (m) => {
                const calls = [...(m.toolCalls || [])];
                const i = calls.findIndex((x) => x.id === c.id);
                const terminal = c.status != null && TERMINAL_TOOL.has(c.status);
                let targetCall: any;
                if (i >= 0) {
                  const prevCall = calls[i];
                  let mergedOutput = c.rawOutput !== undefined ? c.rawOutput : prevCall.rawOutput;
                  if ((c as any)._deltaChunk && typeof (c as any)._deltaChunk === "string") {
                    const prevText = typeof prevCall.rawOutput === "string" ? prevCall.rawOutput : "";
                    mergedOutput = prevText + (c as any)._deltaChunk;
                  }
                  targetCall = {
                    ...prevCall,
                    ...c,
                    title: c.title || prevCall.title,
                    rawOutput: mergedOutput,
                    startedAt: prevCall.startedAt ?? Date.now(),
                    completedAt: terminal ? (prevCall.completedAt ?? Date.now()) : prevCall.completedAt,
                  };
                  delete (targetCall as any)._deltaChunk;
                  calls[i] = targetCall;
                } else {
                  targetCall = {
                    ...c,
                    title: c.title ?? "Tool call",
                    status: c.status ?? "running",
                    rawOutput: (c as any)._deltaChunk || c.rawOutput,
                    startedAt: Date.now(),
                    completedAt: terminal ? Date.now() : undefined,
                  };
                  delete (targetCall as any)._deltaChunk;
                  calls.push(targetCall);
                }

                let newContent = m.content;
                if (isGenerativeTool(targetCall) && !hasGenerativeToolPlaceholder(newContent, targetCall.id)) {
                  newContent = appendGenerativeToolPlaceholder(newContent, targetCall.id);
                }

                const displayTitle = resolveToolDisplayTitle(targetCall);
                const hint =
                  statusTextForUpdate("tool_call_update", {
                    title: displayTitle,
                    status: targetCall.status,
                  }) ?? m.statusHint;

                return {
                  ...m,
                  content: newContent,
                  statusHint: hint,
                  toolCalls: calls,
                };
              });
            },
            onPlan: (entries) =>
              useStudioStore.getState().patchMessage(assistantId, (m) => {
                const hint = statusTextForUpdate("plan", { entries });
                return hint ? { ...m, plan: entries, statusHint: hint } : { ...m, plan: entries };
              }),
            onAvailableCommands: (cmds) => useStudioStore.getState().setAvailableCommands(cmds, sid),
            onConfigOptions: (options) => useStudioStore.getState().setConfigOptions(options),
            onContentBlock: (content) => {
              flushPending();
              useStudioStore.getState().patchMessage(assistantId, (m) => ({
                ...m,
                contentBlocks: [...(m.contentBlocks ?? []), content],
                statusHint: undefined,
              }));
            },
            onArtifactUpdate: (update) => {
              const state = useStudioStore.getState();
              const owner = state.messages.find(m => m.artifacts?.some(entry => artifactKey(entry) === updateKey(update)));
              state.patchMessage(owner?.id ?? assistantId, m => ({ ...m, artifacts: applyArtifactUpdate(m.artifacts ?? [], update) }));
            },
            onModeUpdate: (modeId) => {
              const stNow = useStudioStore.getState();
              if (stNow.modes) stNow.setModes({ ...stNow.modes, currentModeId: modeId });
              useStudioStore.getState().saveAgentPref(agentId, { modeId });
            },
            onConfigUpdate: (opt) => {
              const stNow = useStudioStore.getState();
              stNow.patchConfigOption(opt);
              if (opt?.id) {
                stNow.rememberAgentConfig(
                  agentId,
                  opt.id,
                  (opt.currentValue as any)?.value ?? opt.currentValue
                );
              }
            },
            onSessionInfo: (info) => useStudioStore.getState().setSessionInfo(info),
            onUsage: (u) => {
              const c2 = useStudioStore.getState();
              const existingSize = c2.usage?.size;
              const normalized: UsageUpdate = {
                ...u,
                size: u.size > 0 ? u.size : (existingSize && existingSize > 0 ? existingSize : u.size),
              };
              c2.setUsage(normalized);
              c2.patchMessage(assistantId, { usage: normalized });
            },
            onQuota: (q) => {
              if (q) useStudioStore.getState().setQuota(q);
            },
            onActivity: (a) => {
              if (a.kind === "subagent_active") {
                const d = (a.detail || {}) as { childId?: string; title?: string; updateType?: string };
                const hint = statusTextForUpdate("subagent_active", { subagentTitle: d.title });
                if (hint) {
                  useStudioStore.getState().patchMessage(assistantId, (m) => ({ ...m, statusHint: hint }));
                }
                return;
              }
              if (a.kind === "compaction_update" || a.kind === "compaction_summary_chunk") {
                const hint = statusTextForUpdate(a.kind);
                if (hint) {
                  useStudioStore.getState().patchMessage(assistantId, (m) => ({ ...m, statusHint: hint }));
                }
                return;
              }
              appendActivityMessage(a, now(), assistantId);
            },
            onPermissionRequest: (p) => useStudioStore.getState().addPermission(p),
            onElicitationRequest: (e) => useStudioStore.getState().addElicitation(e),
            onElicitationClosed: (id) => useStudioStore.getState().removeElicitation(id),
            onDone: (_stopReason, resp) => {
              flushPending();
              useStudioStore.getState().patchActiveTurn({ status: "done", lastSeq });
              if (resp && (resp.usage || resp._meta)) {
                const extras = pickUsageExtras({ ...(resp.usage || {}), _meta: resp._meta });
                const c2 = useStudioStore.getState();
                const cur = c2.usage;
                if (Object.keys(extras).length > 0) {
                  const merged: UsageUpdate = {
                    used: cur?.used ?? (typeof resp.usage?.used === "number" ? resp.usage.used : (extras.totalTokens ?? 0)),
                    size: cur?.size && cur.size > 0 ? cur.size : (typeof resp.usage?.size === "number" ? resp.usage.size : 0),
                    cost: resp.usage?.cost ?? cur?.cost,
                    ...cur,
                    ...extras,
                  };
                  c2.setUsage(merged);
                  c2.patchMessage(assistantId, { usage: merged });
                }
              }
              // 若该轮次结束且没有最终正文输出（仅工具前有阶段说明），将阶段说明回退为正文保证不丢失任何内容
              useStudioStore.getState().patchMessage(assistantId, (m) => {
                if (!m.content?.trim() && m.progressContent) {
                  return {
                    ...m,
                    content: m.progressContent,
                    progressContent: undefined,
                  };
                }
                return m;
              });
              stampTurnEnd(assistantId);
            },
            onError: (err) => {
              flushPending();
              // Mid-stream error frame: consumeUniversalChat reports but does
              // NOT throw, so transient ones defer to the resend below.
              if (shouldRetry(err)) {
                failedErr = err;
                return;
              }
              reportError(err);
            },
          },
          abortRef.current.signal,
          { follow: accepted && attempt > 0 }
          );
          lastSeq = result.lastEventId ?? lastSeq;
        } catch (e: any) {
          // Pre-stream throw (connect/session/chat-POST failure).
          if (e?.name === "AbortError") throw e;
          if (isAuthRequiredError(e)) throw e;
          if (shouldRetry(e)) failedErr = e;
          else throw e;
        }
        if (!failedErr) {
          if (attempt > 0) {
            useStudioStore.getState().patchMessage(assistantId, (m) => ({ ...m, content: stripRetryNotes(m.content) }));
          }
          break;
        }
        attempt += 1;
        useStudioStore.getState().patchMessage(assistantId, (m) => ({
          // Trailing newline keeps the note self-delimiting: streamed text
          // lands on the next line so stripRetryNotes can never eat content.
          ...m,
          content: m.content + `\n\n> 🔁 连接中断，正在重试 (${attempt}/${retryMax})…\n`,
        }));
        // Abort during backoff surfaces as AbortError -> outer catch swallows.
        await sleepAbortable(retryDelayMs(attempt), abortRef.current?.signal);
      }
        const done = useStudioStore.getState();
        done.setAuthOk(agentId, true);

        // 自动解析状态响应中的实时额度与速率限制（例如 /status 输出）
        try {
          const finalMsg = done.messages.find((m) => m.id === assistantId);
          if (finalMsg?.content && /5-hour limit|rate limit|weekly limit|resets in|resets at|limit:/i.test(finalMsg.content)) {
            const parsed = parseRateLimitsFromStatusText(finalMsg.content);
            if (parsed && (parsed.primaryWindow || parsed.secondaryWindow)) {
              const curQuota = done.quota;
              done.setQuota({
                ...curQuota,
                ...parsed,
                account: curQuota?.account || parsed.account,
              });
            }
          }
        } catch (e) {
          console.debug("[useChatSend] 解析限额文本容错:", e);
        }

        // Fine-grained session list update:
        // 1. Do NOT invalidateAgents(qc) — agent process/capabilities do not mutate on turn-end.
        // 2. For sessions: if the active session already has a defined title (not a generic placeholder),
        //    update its updatedAt and glide it to top via in-place setQueryData (0 HTTP requests, 0 whole-tree flicker).
        // 3. For new / untitled sessions: trigger background invalidateSessions so the agent-generated title is loaded silently.
        const cachedSessions = qc.getQueryData<SessionItem[]>(acpKeys.sessions(agentId));
        const currentItem = cachedSessions?.find((s) => s.sessionId === sid);
        const hasCustomTitle =
          currentItem?.title &&
          !currentItem.title.toLowerCase().startsWith("new session") &&
          !currentItem.title.toLowerCase().startsWith("新会话");

        if (cachedSessions && hasCustomTitle) {
          const nowIso = new Date().toISOString();
          qc.setQueryData<SessionItem[]>(acpKeys.sessions(agentId), (old) => {
            if (!old) return old;
            const updated = old.map((s) =>
              s.sessionId === sid ? { ...s, updatedAt: nowIso } : s
            );
            const idx = updated.findIndex((s) => s.sessionId === sid);
            if (idx > 0) {
              const [activeItem] = updated.splice(idx, 1);
              updated.unshift(activeItem);
            }
            return updated;
          });
        } else {
          invalidateSessions(qc, agentId);
        }
      } catch (e: any) {
        flushPending();
        if (e?.name !== "AbortError") {
          beginTurn();
          const c2 = useStudioStore.getState();
          if (isAuthRequiredError(e)) {
            c2.setAuthOk(agentId, false);
            c2.setAuthOpen(true);
          }
          const prev = stripRetryNotes(c2.messages.find((m) => m.id === assistantId)?.content || "");
          const rawMsg = e?.message && e.message !== "null" ? e.message : "连接异常或请求超时";
          let errorText = rawMsg;
          if (/referenced reasoning item .* expired|not found or has expired/i.test(rawMsg)) {
            errorText = `上游模型推理上下文已过期 (Reasoning Cache Expired)。\n\n> 💡 **原理说明**：上游推理模型（o1/o3/Thinking）在服务端的推理上下文缓存已超时（通常 > 15-30 分钟）被自动回收，当前旧会话无法在原推理节点继续追加。\n> 🚀 **解决方案**：请点击侧边栏或主界面的 **「+ 新会话」** 开启干净上下文即可恢复正常。`;
          }
          c2.patchMessage(assistantId, (m) => ({ ...m, content: prev ? `${prev}\n\n> ❌ [连接异常] ${errorText}` : `> ❌ [连接异常] ${errorText}` }));
          stampTurnEnd(assistantId);
        }
      } finally {
        stopPersisting();
        clearTurnLive(turnId);
        flushPending();
        disposeBatching();
        sendingRef.current = false;
        const c2 = useStudioStore.getState();
        if (c2.activeTurn?.turnId === turnId && c2.activeTurn.status === "running") {
          c2.patchActiveTurn({
            status: abortRef.current?.signal.aborted ? "interrupted" : "error",
            lastSeq: c2.activeTurn.lastSeq,
          });
        }
        c2.setStreaming(false);
        c2.setBusy(false);
        stampTurnEnd(assistantId);
        // Turn-end marker (done / error / abort): splice this turn's final
        // text and persist ASYNC — fire-and-forget microtask so storage I/O
        // never blocks the UI thread.
        void Promise.resolve().then(() => {
          try {
            useStudioStore.getState().snapshotThread();
          } catch (err) {
            console.error("[App] turn persist failed:", err);
          }
        });
      }
    },
    [qc, agentsRef, resolveSession, now]
  );

  const handleStop = useCallback(async () => {
    abortRef.current?.abort();
    const st = useStudioStore.getState();
    if (st.sessionId) {
      try {
        await sessionRpc(st.activeAgentId, "cancel", { sessionId: st.sessionId });
      } catch {
        // ignore
      }
    }
    const cur = useStudioStore.getState();
    cur.setStreaming(false);
    const t = Date.now();
    cur.setMessages(
      cur.messages.map((m) =>
        m.isStreaming
          ? {
              ...m,
              isStreaming: false,
              completedAt: m.completedAt ?? t,
              thoughtTiming:
                m.thoughtTiming?.startedAt && !m.thoughtTiming.completedAt
                  ? { ...m.thoughtTiming, completedAt: t }
                  : m.thoughtTiming,
            }
          : m
      )
    );
  }, []);

  const handlePermRespond = useCallback(
    async (p: PendingPermission, optionId: string | null) => {
      const st = useStudioStore.getState();
      st.setRespondingId(p.permissionId);
      try {
        await respondPermission(
          p.agentId,
          p.permissionId,
          optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" }
        );
        useStudioStore.getState().removePermission(p.permissionId);
      } catch (e: any) {
        alert(`permission respond 失败: ${e.message}`);
      } finally {
        useStudioStore.getState().setRespondingId(null);
      }
    },
    []
  );

  const handleElicRespond = useCallback(
    async (e: PendingElicitation, result: CreateElicitationResponse) => {
      const st = useStudioStore.getState();
      st.setRespondingId(e.elicitationId);
      try {
        await respondElicitation(e.agentId, e.elicitationId, result);
        if (CreateElicitationRequest.isUrl(e.schema) && CreateElicitationResponse.isAccept(result)) {
          if (useStudioStore.getState().pendingElic.some(p => p.elicitationId === e.elicitationId)) {
            useStudioStore.getState().addElicitation({ ...e, status: "accepted" });
          }
        } else useStudioStore.getState().removeElicitation(e.elicitationId);
      } finally {
        useStudioStore.getState().setRespondingId(null);
      }
    },
    []
  );

  return {
    abortRef,
    handleSend,
    handleStop,
    handlePermRespond,
    handleElicRespond,
  };
}
