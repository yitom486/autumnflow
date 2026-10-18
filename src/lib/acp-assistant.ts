import type { ThreadMessageLike } from "@assistant-ui/react";
import type { Message } from "@/lib/message-types";
import type { PendingPermission } from "@/lib/universal-api";
import { partitionTurnContent } from "@/lib/threads";
import { preprocessMarkdown } from "@/lib/markdown-preprocess";
import {
  isGenerativeTool,
  splitInterleavedGenerativeContent,
} from "@/components/assistant/toolkit";

function toToolCallPart(tc: NonNullable<Message["toolCalls"]>[number]) {
  const rawName = tc.name || tc.title || "tool";
  const cleanName = rawName.replace(/^studio[-_]ui[:_./]/i, "");
  const toolName = cleanName || rawName;
  let args: Record<string, any> = {};
  if (tc.rawInput && typeof tc.rawInput === "object") {
    args = tc.rawInput as Record<string, any>;
  } else if (typeof tc.rawInput === "string") {
    try {
      const parsed = JSON.parse(tc.rawInput);
      if (parsed && typeof parsed === "object") args = parsed;
      else args = { rawText: tc.rawInput };
    } catch {
      args = { rawText: tc.rawInput };
    }
  } else {
    args = { kind: tc.kind ?? "", status: tc.status };
  }
  const argsText =
    typeof tc.rawInput === "string"
      ? tc.rawInput
      : tc.rawInput
        ? JSON.stringify(tc.rawInput)
        : tc.kind
          ? `[${tc.kind}] ${tc.title}`
          : tc.title;

  return {
    type: "tool-call" as const,
    toolCallId: tc.id,
    toolName,
    args,
    argsText,
    result: tc.rawOutput !== undefined ? tc.rawOutput : tc.content ?? tc.status,
    isError: tc.status === "failed" || tc.status === "cancelled",
    ...(tc.startedAt ? { timing: { startedAt: tc.startedAt, ...(tc.completedAt ? { completedAt: tc.completedAt } : {}) } } : {}),
  };
}

/**
 * ACP Message -> assistant-ui ThreadMessageLike.
 *
 * Mapping preserves all ACP-specific state so the custom Thread UI can
 * render it without loss:
 * - thought      -> reasoning part
 * - toolCalls[]  -> regular tool-call parts first, generative tool-call parts interleaved with text via placeholders
 * - content      -> text part(s)
 * - plan/usage/model/mode/timestamp/isStreaming -> metadata.custom
 */
export interface AcpCustomMetadata {
  plan?: Message["plan"];
  usage?: Message["usage"];
  model?: string;
  mode?: string;
  timestamp?: string;
  isStreaming?: boolean;
  statusHint?: string;
  originalRole?: Message["role"];
  startedAt?: number;
  completedAt?: number;
  thoughtTiming?: Message["thoughtTiming"];
}

export function convertAcpMessage(msg: Message): ThreadMessageLike {
  if (msg.role === "user") {
    return {
      id: msg.id,
      role: "user",
      content: [
        { type: "text", id: "body-0", text: preprocessMarkdown(msg.content || "") },
        ...(msg.images || []).filter((img) => img && typeof img.src === "string" && img.src).map((img) => ({ type: "image" as const, image: img.src })),
      ],
      metadata: {
        custom: {
          timestamp: msg.timestamp,
        } satisfies AcpCustomMetadata,
      },
    };
  }

  if (msg.role === "system") {
    return {
      id: msg.id,
      role: "system",
      content: [{ type: "text", text: msg.content || "" }],
      metadata: {
        custom: {
          timestamp: msg.timestamp,
          originalRole: "system",
        } satisfies AcpCustomMetadata,
      },
    };
  }

  // assistant
  const content: Array<
    | { type: "text"; id?: string; text: string }
    | { type: "reasoning"; id?: string; text: string; timing?: { startedAt: number; completedAt?: number } }
    | { type: "image"; image: string }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        args: Record<string, string>;
        argsText: string;
        result: unknown;
        isError: boolean;
        timing?: { startedAt: number; completedAt?: number };
      }
  > = [];

  if (msg.thought) {
    content.push({
      type: "reasoning",
      // 稳定 part id：assistant-ui 用 `${type}:${id}` 作为 part 的渲染/存储键。
      // 没有 id 时退化为 `${type}@${index}`，一旦前面的 part 增减（工具调用插入），
      // 正文 part 的键就会漂移，useSmooth 判定 part 已更换并清空重打。
      id: "thought",
      text: msg.thought,
      ...(msg.thoughtTiming?.startedAt ? { timing: { ...msg.thoughtTiming, startedAt: msg.thoughtTiming.startedAt } } : {}),
    });
  }

  const allTools = msg.toolCalls || [];
  const regularTools = allTools.filter((tc) => !isGenerativeTool(tc));
  const generativeTools = allTools.filter((tc) => isGenerativeTool(tc));

  for (const tc of regularTools) {
    content.push(toToolCallPart(tc));
  }

  // Interleave text segments and generative UI tool calls at their inline placeholder positions.
  // 保持流式期间文本单调递增：流式生成过程中（msg.isStreaming 为 true）绝不后验切分正文与进度，
  // 否则 part.text 突然缩水会导致 useSmooth 触发 !text.startsWith(displayedText) 进而清空界面重头打字。
  let rawBodyText = msg.content || "";
  if (!msg.isStreaming) {
    const { conclusion } = partitionTurnContent(
      msg.content,
      (msg as any).progressContent,
      allTools.length > 0
    );
    rawBodyText = conclusion || msg.content || "";
  }
  const normalizedBody = msg.isStreaming ? rawBodyText : preprocessMarkdown(rawBodyText);
  const segments = splitInterleavedGenerativeContent(normalizedBody, generativeTools);
  let hasTextPart = false;
  let textSegmentIndex = 0;
  for (const seg of segments) {
    if (seg.type === "text") {
      hasTextPart = true;
      content.push({
        type: "text",
        // 同上：正文 part 用位置稳定的 id，避免流式期间因 part 插入导致的键漂移。
        id: `body-${textSegmentIndex}`,
        text: seg.text,
      });
      textSegmentIndex += 1;
    } else {
      content.push(toToolCallPart(seg.tool));
    }
  }
  if (!hasTextPart) {
    content.push({ type: "text", id: "body-0", text: "" });
  }

  // Agent-sent images (after text; order within a turn is text-then-images).
  for (const img of msg.images || []) {
    if (img && typeof img.src === "string" && img.src) {
      content.push({ type: "image", image: img.src });
    }
  }

  return {
    id: msg.id,
    role: "assistant",
    content,
    status: msg.isStreaming ? { type: "running" } : { type: "complete", reason: "stop" },
    metadata: {
      custom: {
        plan: msg.plan,
        usage: msg.usage,
        model: msg.model,
        mode: msg.mode,
        timestamp: msg.timestamp,
        isStreaming: msg.isStreaming,
        statusHint: msg.statusHint,
        originalRole: "assistant",
        startedAt: msg.startedAt,
        completedAt: msg.completedAt,
        thoughtTiming: msg.thoughtTiming,
      } satisfies AcpCustomMetadata,
    },
  };
}

/**
 * 逐条转换缓存（按 ACP Message 的引用身份）。
 *
 * assistant-ui 的 external store 用「源对象引用」作为转换缓存键：
 * `ThreadMessageConverter.cache` 与 `createExternalMessageConversionCache().callbackCache`
 * 都是 `WeakMap<源消息, 转换结果>`。只要某条消息的对象引用变了，即使内容一字未动，
 * 也会被重新转换成一个全新的 ThreadMessage —— 进而让该消息的全部 part 重新计算、
 * 组件树整体重渲染。
 *
 * 流式期间 `patchMessage` 只替换目标消息，其余消息引用天然稳定；这里再按引用缓存，
 * 保证「没变的消息 → 同一个 ThreadMessageLike 引用」，把每 token 的 O(整条线程) 重建
 * 收敛成 O(1)。
 */
const threadMessageCache = new WeakMap<Message, ThreadMessageLike>();

export function convertAcpMessageCached(msg: Message): ThreadMessageLike {
  const cached = threadMessageCache.get(msg);
  if (cached) return cached;
  const converted = convertAcpMessage(msg);
  threadMessageCache.set(msg, converted);
  return converted;
}

export function convertAcpMessages(messages: Message[]): ThreadMessageLike[] {
  const filtered: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") {
      const prev = filtered[filtered.length - 1];
      if (prev && prev.role === "system" && prev.content?.trim() === msg.content?.trim()) {
        continue; // 连续重复的系统提示直接去重折叠
      }
    }
    filtered.push(msg);
  }
  return filtered.map(convertAcpMessageCached);
}

/** Extract plain text from an assistant-ui AppendMessage (for onNew/onEdit). */
export function extractAppendText(message: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
  return message.content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

export interface InlinePermMatch {
  messageId: string;
  toolCallId: string;
}

/**
 * Match an ACP permission request to a visible tool-call part so it can be
 * approved inline in the tool card. Matches by toolCallId first, falls back
 * to title; requires same session when one is bound.
 */
export function matchPermToToolCalls(
  perm: PendingPermission,
  messages: Message[],
  sessionId: string | null,
): InlinePermMatch | null {
  if (sessionId && perm.sessionId !== sessionId) return null;
  const tool = (perm.toolCall ?? {}) as {
    toolCallId?: string;
    id?: string;
    title?: string;
  };
  const wantId = tool.toolCallId || tool.id || null;
  const wantTitle = tool.title || null;
  if (!wantId && !wantTitle) return null;
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if ((wantId && tc.id === wantId) || (wantTitle && tc.title === wantTitle)) {
        return { messageId: m.id, toolCallId: tc.id };
      }
    }
  }
  return null;
}
