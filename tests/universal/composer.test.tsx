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

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  useStudioStore.getState().resetStudio();
});

function Harness(props: {
  isStreaming: boolean;
  onQueue: (text: string) => void;
  onWithdraw: (id: string) => void;
  queuedPrompts?: QueuedPrompt[];
  restoredText?: string;
  initialText?: string;
}) {
  const aui = useAui();
  useEffect(() => {
    if (props.initialText) aui.composer.setText(props.initialText);
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
    onWithdraw: props.onWithdraw,
    queuedPrompts: props.queuedPrompts,
    restoredText: props.restoredText,
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

  it("puts a prompt the app handed back into the composer", async () => {
    const { el, root } = await renderComposer({ restoredText: "别把我弄丢了" });
    try {
      await act(async () => {});
      expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("别把我弄丢了");
    } finally {
      root.unmount();
      el.remove();
    }
  });

  it("never overwrites what the user typed in the meantime", async () => {
    const { el, root } = await renderComposer({ restoredText: "别把我弄丢了", initialText: "我刚打的字" });
    try {
      await act(async () => {});
      expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("我刚打的字");
    } finally {
      root.unmount();
      el.remove();
    }
  });
});

describe("composer draft", () => {
  it("keeps the text the user typed when the runtime rebuilds its thread scope", async () => {
    const { el, root } = await renderComposer();
    try {
      await act(async () => type(el, "我刚打的字"));
      expect(textareaValue(el)).toBe("我刚打的字");
      // The app learns the session id: the runtime drops its thread scope and
      // the composer goes with it.
      await act(async () => { useStudioStore.setState({ sessionId: "s-1" }); });
      expect(textareaValue(el)).toBe("我刚打的字");
    } finally {
      root.unmount();
      el.remove();
    }
  });

  it("does not bring back what the user cleared themselves", async () => {
    const { el, root } = await renderComposer();
    try {
      await act(async () => type(el, "先写点东西"));
      await act(async () => type(el, ""));
      expect(textareaValue(el)).toBe("");
      await act(async () => { useStudioStore.setState({ sessionId: "s-1" }); });
      expect(textareaValue(el)).toBe("");
    } finally {
      root.unmount();
      el.remove();
    }
  });

  it("does not bring back a prompt that was already sent", async () => {
    const { el, root } = await renderComposer();
    try {
      await act(async () => type(el, "发出去的消息"));
      await act(async () => pressEnter(el));
      expect(textareaValue(el)).toBe("");
      await act(async () => { useStudioStore.setState({ sessionId: "s-1" }); });
      expect(textareaValue(el)).toBe("");
    } finally {
      root.unmount();
      el.remove();
    }
  });
});
