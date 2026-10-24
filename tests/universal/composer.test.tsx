import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement as h, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAui } from "@assistant-ui/react";
import { AcpAssistantProvider } from "@/components/assistant/AcpAssistantProvider";
import { AcpComposer } from "@/components/assistant/AcpComposer";
import { useStudioStore } from "@/stores/useStudioStore";
import type { QueuedPrompt } from "@/stores/useStudioStore";
import { setStudio } from "../helpers/studio";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  useStudioStore.getState().resetStudio();
});

function Harness(props: {
  isStreaming: boolean;
  onQueue: (text: string) => void;
  onSubmitPrompt?: (text: string) => void;
  onWithdraw: (id: string) => void;
  queuedPrompts?: QueuedPrompt[];
  initialText?: string;
}) {
  useEffect(() => {
    // 输入框的文本以 store 草稿为准：预置内容就写这一份。
    if (props.initialText) {
      useStudioStore.getState().setDraft(props.initialText);
    }
  }, []);
  return h(AcpComposer, {
    onSendAttachmentOnly: () => {},
    onClear: () => {},
    isStreaming: props.isStreaming,
    commands: [],
    supportImage: false,
    attachments: [],
    setAttachments: () => {},
    agentTitle: "Codex",
    configOptions: null,
    connected: false,
    currentWorkspace: "D:/repo",
    onQueue: props.onQueue,
    onSubmitPrompt: props.onSubmitPrompt,
    onWithdraw: props.onWithdraw,
    queuedPrompts: props.queuedPrompts,
  } as any);
}

async function renderComposer(props: Partial<React.ComponentProps<typeof Harness>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      h(QueryClientProvider, { client: qc },
        h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
          h(Harness, {
            isStreaming: false,
            onQueue: () => {},
            onWithdraw: () => {},
            ...props,
          } as any)))
    );
  });
  return { el, root };
}

function pressEnter(el: HTMLElement) {
  const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea).toBeTruthy();
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

/** Type into the composer the way a user does. */
function type(el: HTMLElement, value: string) {
  const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function textareaValue(el: HTMLElement) {
  return (el.querySelector("textarea") as HTMLTextAreaElement).value;
}

describe("composer queue", () => {
  it("queues the prompt while the agent is working instead of sending it", async () => {
    const onQueue = vi.fn();
    const { el, root } = await renderComposer({ isStreaming: true, onQueue, initialText: "排队的这条" });
    try {
      pressEnter(el);
      expect(onQueue).toHaveBeenCalledWith("排队的这条");
      // The composer is emptied: the prompt now lives in the queue.
      await act(async () => {});
      expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    } finally {
      root.unmount();
      el.remove();
    }
  });

  it("does not send the Enter that confirms an IME candidate", async () => {
    // 微信/搜狗等输入法在 compositionend 之后才发 Enter 的 keydown：此时 isComposing
    // 已经是 false，只剩 keyCode 229。这个 Enter 是"确认候选词"，不是"发送"——
    // 当成发送的话中文根本打不进去，字一出来就没了。
    const onSubmitPrompt = vi.fn();
    const { el, root } = await renderComposer({ isStreaming: false, onQueue: () => {}, onSubmitPrompt, initialText: "中文" });
    try {
      const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
      const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
      Object.defineProperty(enter, "keyCode", { value: 229 });
      textarea.dispatchEvent(enter);
      expect(onSubmitPrompt).not.toHaveBeenCalled();
      await act(async () => {});
      expect(textareaValue(el)).toBe("中文");
    } finally {
      root.unmount();
      el.remove();
    }
  });

  it("hands the prompt to the app even when the agent is not working", async () => {
    // assistant-ui 的 composer.send() 在运行时就绪前是空操作：刷新页面后恢复会话的
    // 那段时间里按 Enter，消息会静默留在输入框里发不出去。所以发送一律走应用。
    const onSubmitPrompt = vi.fn();
    const { el, root } = await renderComposer({ isStreaming: false, onQueue: () => {}, onSubmitPrompt, initialText: "这条要发出去" });
    try {
      pressEnter(el);
      expect(onSubmitPrompt).toHaveBeenCalledWith("这条要发出去");
      await act(async () => {});
      expect(textareaValue(el)).toBe("");
    } finally {
      root.unmount();
      el.remove();
    }
  });

  it("shows the queued prompts and lets the user withdraw one", async () => {
    const onWithdraw = vi.fn();
    const { el, root } = await renderComposer({
      isStreaming: true,
      onQueue: () => {},
      onWithdraw,
      queuedPrompts: [{ id: "q1", text: "排队的这条", createdAt: 1 }],
    });
    try {
      const queue = el.querySelector('[data-testid="composer-queue"]');
      expect(queue).toBeTruthy();
      expect(queue?.textContent).toContain("排队的这条");
      const button = el.querySelector('button[aria-label^="撤回排队消息"]') as HTMLButtonElement;
      expect(button).toBeTruthy();
      await act(async () => button.click());
      expect(onWithdraw).toHaveBeenCalledWith("q1");
    } finally {
      root.unmount();
      el.remove();
    }
  });

  it("shows what the app writes into this session's draft", async () => {
    // 发送失败时应用把提示词还回这个会话的草稿，composer 直接显示这一份。
    const { el, root } = await renderComposer();
    try {
      await act(async () => { setStudio({ sessionId: "s-1" }); });
      await act(async () => { useStudioStore.getState().setDraft("别把我弄丢了"); });
      expect(textareaValue(el)).toBe("别把我弄丢了");
    } finally {
      root.unmount();
      el.remove();
    }
  });
});

describe("composer draft", () => {
  it("keeps each session's own text when switching between them", async () => {
    const { el, root } = await renderComposer();
    try {
      await act(async () => { setStudio({ activeThreadId: "t-1", sessionId: "s-1" }); });
      await act(async () => type(el, "我刚打的字"));
      expect(textareaValue(el)).toBe("我刚打的字");

      // 切到另一个会话：那边是空的
      await act(async () => { setStudio({ activeThreadId: "t-2", sessionId: "s-2" }); });
      expect(textareaValue(el)).toBe("");

      // 切回来：自己的字还在
      await act(async () => { setStudio({ activeThreadId: "t-1", sessionId: "s-1" }); });
      expect(textareaValue(el)).toBe("我刚打的字");
    } finally {
      root.unmount();
      el.remove();
    }
  });

  it("does not bring back what the user cleared themselves", async () => {
    const { el, root } = await renderComposer();
    try {
      await act(async () => { setStudio({ activeThreadId: "t-1", sessionId: "s-1" }); });
      await act(async () => type(el, "先写点东西"));
      await act(async () => type(el, ""));
      expect(textareaValue(el)).toBe("");
      await act(async () => { setStudio({ activeThreadId: "t-2", sessionId: "s-2" }); });
      expect(textareaValue(el)).toBe("");
    } finally {
      root.unmount();
      el.remove();
    }
  });

  it("does not bring back a prompt that was already sent", async () => {
    const { el, root } = await renderComposer();
    try {
      await act(async () => { setStudio({ activeThreadId: "t-1", sessionId: "s-1" }); });
      await act(async () => type(el, "发出去的消息"));
      await act(async () => pressEnter(el));
      expect(textareaValue(el)).toBe("");
      await act(async () => { setStudio({ activeThreadId: "t-2", sessionId: "s-2" }); });
      expect(textareaValue(el)).toBe("");
    } finally {
      root.unmount();
      el.remove();
    }
  });
});
