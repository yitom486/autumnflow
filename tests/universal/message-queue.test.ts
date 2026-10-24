import { describe, it, expect, vi } from "vitest";
import { createElement as h, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useAui, createMessageQueue } from "@assistant-ui/react";
import { AcpAssistantProvider } from "@/components/assistant/AcpAssistantProvider";
import { activeKey, useStudioStore } from "@/stores/useStudioStore";
import { setStudio } from "../helpers/studio";

async function flushRounds(n = 8) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

function Probe({ onReady }: { onReady: (aui: ReturnType<typeof useAui>) => void }) {
  const aui = useAui();
  useEffect(() => {
    onReady(aui);
  }, []);
  return null;
}

describe("message queue (排队)", () => {
  it("buffers sends during a run and drains in order after settle", async () => {
    setStudio({ messages: [], isStreaming: false } as any);
    const calls: string[] = [];
    let resolveFirst!: () => void;
    const onSend = vi.fn((text?: string) => {
      calls.push(text || "");
      if (calls.length === 1) return new Promise<void>((r) => (resolveFirst = r));
      return Promise.resolve();
    });

    let aui!: ReturnType<typeof useAui>;
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(AcpAssistantProvider, { onSend, onStop: () => {} } as any,
          h(Probe, { onReady: (a) => (aui = a) }))
      );
    });

    // 第一条：直接 dispatch（idle）
    await act(async () => {
      aui.composer.setText("first");
    });
    await act(async () => {
      aui.composer.send();
    });
    expect(calls).toEqual(["first"]);

    // 运行中（外部置 busy）：第二条只进队列，不 dispatch
    await act(async () => {
      useStudioStore.getState().setSessionRunning(activeKey(useStudioStore.getState()), true);
    });
    await act(async () => {
      aui.composer.setText("second");
    });
    await act(async () => {
      aui.composer.send();
    });
    await flushRounds();
    expect(calls).toEqual(["first"]);

    // 第一轮落定：队列排出第二条
    await act(async () => {
      resolveFirst();
      useStudioStore.getState().setSessionRunning(activeKey(useStudioStore.getState()), false);
    });
    await flushRounds();
    expect(calls).toEqual(["first", "second"]);

    root.unmount();
    el.remove();
    setStudio({ messages: [], isStreaming: false } as any);
  });

  it("clear() drops pending items so edit/reload never drains stale sends", async () => {
    // 直接验证控制器语义：provider 的 onEdit/onReload 调的就是这个 clear。
    const ran: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const controller = createMessageQueue({
      run: (message: any) => {
        const text = (message.content?.[0] as any)?.text || "";
        ran.push(text);
        if (ran.length === 1) {
          controller.notifyBusy();
          void gate.then(() => controller.notifyIdle());
          return;
        }
      },
    });
    const msg = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] }) as any;
    controller.adapter.enqueue(msg("run1"));
    // run1 正在跑时，stale 进队列
    await new Promise((r) => setTimeout(r, 50));
    controller.adapter.enqueue(msg("stale"));
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual(["run1"]);
    // edit/reload 路径：先 clear 再落定
    controller.clear();
    release();
    await new Promise((r) => setTimeout(r, 50));
    controller.notifyIdle();
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual(["run1"]);
  });
});
