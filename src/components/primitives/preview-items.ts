/**
 * Preview-rail item derivation.
 *
 * The rail shows one tick per message and, on hover, a card with the question
 * (label) and the answer (description). The derivation runs on every mutation
 * of the chat viewport, so it must stay linear: a previous version looked the
 * message index up with `indexOf` inside a `map` and extracted every message
 * body twice, which made a long conversation rescan quadratically while a
 * response was streaming.
 */
import type { PreviewRailItem } from "@/components/primitives/PreviewRail";

/** Longest label kept for a single message (the rail renders one truncated line). */
export const PREVIEW_LABEL_MAX = 240;
/** Longest answer text kept for the preview card body. */
export const PREVIEW_DESCRIPTION_MAX = 1200;

export interface PreviewMessageInput {
  id: string;
  /** "user" | "assistant" | anything else for system messages. */
  from: string;
  /** Already-extracted plain text of the message body. */
  text: string;
}

/**
 * Build the rail items from a message list.
 *
 * A user message owns the assistant messages that follow it (up to the next
 * user message): the question becomes the label and the replies the
 * description. System messages keep their own text as description.
 */
export function buildPreviewRailItems(
  messages: PreviewMessageInput[],
  targetRole: "user" | "all" = "all"
): PreviewRailItem[] {
  // One pass: every body is read once and reused by the label and the answer.
  const items: PreviewRailItem[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const isUser = message.from === "user";
    if (targetRole === "user" && !isUser) continue;

    const label = isUser
      ? message.text || "（附件消息）"
      : message.from === "assistant"
        ? "智能体回复"
        : "系统消息";

    if (!isUser) {
      items.push({ id: message.id, label, ariaLabel: label, description: message.text || "（空消息）" });
      continue;
    }

    // The reply block of a user message is the contiguous run of assistant
    // messages after it, so the total work stays linear across the list.
    const replies: string[] = [];
    for (let next = index + 1; next < messages.length; next++) {
      const candidate = messages[next];
      if (candidate.from === "user") break;
      if (candidate.from === "assistant" && candidate.text) replies.push(candidate.text);
    }
    const answer = replies.join(" ").slice(0, PREVIEW_DESCRIPTION_MAX);
    items.push({ id: message.id, label, ariaLabel: label, description: answer || "暂无回答" });
  }
  return items;
}
