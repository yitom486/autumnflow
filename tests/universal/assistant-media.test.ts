import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import {
  buildTranscriptFromReplay,
  consumeUniversalChat,
  toChatImage,
} from "@/lib/universal-api";
import { freezeMessage } from "@/lib/threads";
import { AcpAssistantProvider } from "@/components/assistant/AcpAssistantProvider";
import { AssistantChatView } from "@/components/assistant/AssistantChatView";
import { useStudioStore } from "@/stores/useStudioStore";
import { setStudio } from "../helpers/studio";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function sseResponse(frames: unknown[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function renderChat() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
        h(AssistantChatView, { agentName: "Codex", onSelectSuggestion: () => {} } as any))
    );
    await new Promise((r) => setTimeout(r, 50));
  });
  return { el, root };
}

describe("chat images and SVG", () => {
  it("normalizes image blocks and rejects unsafe sources", () => {
    expect(toChatImage({ type: "image", data: "aGVsbG8=", mimeType: "image/png" })).toMatchObject({
      src: "data:image/png;base64,aGVsbG8=",
      mimeType: "image/png",
    });
    expect(toChatImage({ type: "image", url: "https://x.com/a.png" })).toMatchObject({
      src: "https://x.com/a.png",
    });
    expect(toChatImage({ type: "image", data: "x", mimeType: "image/svg+xml" })?.src).toContain("image/svg+xml");
    expect(toChatImage({ type: "image", url: "javascript:alert(1)" })).toBeNull();
    expect(toChatImage(null)).toBeNull();
    expect(toChatImage({ type: "text", text: "hi" })).toBeNull();
  });

  it("live consumer surfaces image chunks without touching text flow", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "看图" } } },
        { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } } },
        { type: "done", stopReason: "end_turn" },
      ])
    ) as unknown as typeof fetch;
    const texts: string[] = [];
    const imgs: any[] = [];
    await consumeUniversalChat(
      { agentId: "codex", prompt: "hi" },
      { onTextChunk: (t) => texts.push(t), onImageChunk: (i) => imgs.push(i) }
    );
    expect(texts).toEqual(["看图"]);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].src).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("replay collects images and keeps image-only messages", () => {
    const t = buildTranscriptFromReplay([
      { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } },
    ]);
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0].images).toHaveLength(1);
    expect(t.messages[0].images?.[0].src).toContain("base64");
  });

  it("freezeMessage strips images like tool calls (storage policy)", () => {
    const f = freezeMessage({
      id: "a", role: "assistant", content: "hi", timestamp: "t",
      images: [{ src: "data:image/png;base64,xxxx", mimeType: "image/png" }],
    } as any);
    expect(f.images).toBeUndefined();
  });

  it("renders agent images with a lightbox", async () => {
    setStudio({
      messages: [
        {
          id: "a5", role: "assistant", content: "看这张图", timestamp: "03:19",
          images: [{ src: "https://example.com/a.png", mimeType: "image/png" }],
        } as any,
      ],
      isStreaming: false,
    } as any);
    const { el, root } = await renderChat();
    const img = el.querySelector("img");
    expect(img).toBeTruthy();
    await act(async () => {
      (img as HTMLElement).closest("button")!.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    root.unmount();
    el.remove();
    setStudio({ messages: [], isStreaming: false } as any);
  });

  it("renders markdown images, blocks unsafe schemes and links", async () => {
    setStudio({
      messages: [
        {
          id: "a6", role: "assistant", timestamp: "03:20",
          content: "![ok](https://example.com/b.png)\n\n![evil](javascript:alert(1))\n\n[evil](javascript:alert(1))",
        } as any,
      ],
      isStreaming: false,
    } as any);
    const { el, root } = await renderChat();
    const imgs = el.querySelectorAll("img");
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute("src")).toBe("https://example.com/b.png");
    expect(el.innerHTML).not.toContain("javascript:");
    root.unmount();
    el.remove();
    setStudio({ messages: [], isStreaming: false } as any);
  });
});
