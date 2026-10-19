import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { MessagePrimitive, ThreadPrimitive, useAui, useAuiState, useMessagePartText, useSmooth } from "@assistant-ui/react";
import { AcpAssistantProvider } from "@/components/assistant/AcpAssistantProvider";
import { StableTextPart } from "@/components/assistant/StableTextPart";
import { useStudioStore } from "@/stores/useStudioStore";

let root: ReturnType<typeof createRoot> | undefined;
let element: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  element?.remove();
});

it("keeps the same text runtime and DOM across tool insertions, then appends only new text", async () => {
  const seen: Array<{ runtime: unknown; text: string; shown: string }> = [];
  const Probe = () => {
    const aui = useAui();
    const runtime = useAuiState(() => aui.part);
    const part = useMessagePartText();
    // Exercise production smoothing; AcpMarkdown's test-mode shortcut would hide this regression.
    const smooth = useSmooth(part, { drainMs: 10, maxCharIntervalMs: 1 });
    seen.push({ runtime, text: part.text, shown: smooth.text });
    return <p data-text-part>{smooth.text}</p>;
  };
  const Text = () => <StableTextPart><Probe /></StableTextPart>;
  const components = { Text, Reasoning: () => null, tools: { Fallback: () => null } };
  const Message = () => <MessagePrimitive.Parts components={components} />;
  useStudioStore.setState({ sessionId: "stable-text", activeThreadId: "stable-text", isStreaming: true,
    messages: [{ id: "a1", role: "assistant", content: "阶段输出：已定位问题。", isStreaming: true, timestamp: "12:00" }] } as any);
  element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
  await act(async () => root!.render(
    <AcpAssistantProvider onSend={() => {}} onStop={() => {}}>
      <ThreadPrimitive.Messages components={{ AssistantMessage: Message }} />
    </AcpAssistantProvider>
  ));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
  const node = element.querySelector("[data-text-part]");
  const first = seen.at(-1)!;
  expect(first.shown).toBe(first.text);
  for (let i = 1; i <= 3; i++) {
    await act(async () => useStudioStore.getState().patchMessage("a1", {
      thought: "继续核对",
      toolCalls: Array.from({ length: i }, (_, index) => ({ id: `t${index}`, title: "Read", status: "completed" as const })),
    }));
    expect(element.querySelector("[data-text-part]")).toBe(node);
    expect(seen.at(-1)!.runtime).toBe(first.runtime);
    expect(node?.textContent).toBe(first.text);
  }
  await act(async () => useStudioStore.getState().patchMessage("a1", { content: first.text + "现在修复。" }));
  expect(seen.at(-1)!.runtime).toBe(first.runtime);
  expect(node?.textContent?.startsWith(first.text)).toBe(true);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
  expect(node?.textContent).toBe(first.text + "现在修复。");
});
