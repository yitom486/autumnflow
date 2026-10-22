import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAui } from "@assistant-ui/react";
import { AcpAssistantProvider } from "@/components/assistant/AcpAssistantProvider";
import { AcpComposer } from "@/components/assistant/AcpComposer";
import { useStudioStore } from "@/stores/useStudioStore";
import type { Attachment } from "@/lib/universal-api";

const realFetch = globalThis.fetch;

// NOTE: this env never fires component-side real timers inside act()
// (verified with a minimal probe), so the debounced search is driven
// with fake timers here. Production browsers are unaffected.
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as any).__fetchCalls = [];
  globalThis.fetch = (async (url: any) => {
    (globalThis as any).__fetchCalls.push(String(url));
    const u = String(url);
    const json = (data: any) => ({ ok: true, json: async () => data });
    if (u.includes("/workspace/files")) {
      return json({ ok: true, repo: "D:/repo", files: [{ path: "src/a.ts", size: 100, mtimeMs: 0 }], truncated: false });
    }
    if (u.includes("/workspace/read")) {
      return json({ ok: true, repo: "D:/repo", file: "src/a.ts", mimeType: "text/plain", size: 12, text: "export {};", truncated: false });
    }
    throw new Error("unexpected fetch: " + u);
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Harness({ onAttachments }: { onAttachments: (a: Attachment[]) => void }) {
  const aui = useAui();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  useEffect(() => {
    // 输入框的文本以 store 草稿为准：预置内容写这一份。
    useStudioStore.getState().setDraft(useStudioStore.getState().sessionId, "看看 @a.t");
  }, []);
  return h(AcpComposer, {
    onSendAttachmentOnly: () => {},
    onClear: () => {},
    isStreaming: false,
    commands: [],
    supportImage: true,
    attachments,
    setAttachments: (a) => {
      setAttachments(a);
      onAttachments(a);
    },
    agentTitle: "Codex",
    configOptions: null,
    connected: false,
    currentWorkspace: "D:/repo",
  } as any);
}

describe("@-mention composer integration", () => {
  it("searches workspace files and attaches the picked one", async () => {
    let latest: Attachment[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        h(QueryClientProvider, { client: qc },
          h(AcpAssistantProvider, { onSend: () => {}, onStop: () => {} } as any,
            h(Harness, { onAttachments: (a) => (latest = a) })))
      );
    });
    // 多轮小步推进 fake 时钟：让 mount effect -> setText -> 搜索 effect ->
    // debounce timer -> fetch -> setState 逐轮 flush（单次大步进会冻住后排的 effect）。
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    // 下拉出现候选
    expect((globalThis as any).__fetchCalls.join("\n")).toContain("/workspace/files");
    expect(el.innerHTML).toContain("src/a.ts");
    // 点击选中 -> 读文件 -> 附件 chip（含资源文本）
    const row = Array.from(el.querySelectorAll("div")).find((d) =>
      d.textContent?.includes("src/a.ts") && d.className.includes("cursor-pointer")
    );
    expect(row).toBeTruthy();
    await act(async () => {
      (row as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest).toHaveLength(1);
    expect(latest[0].name).toBe("src/a.ts");
    expect(latest[0].block).toMatchObject({
      type: "resource",
      resource: { uri: "file:///src/a.ts", text: "export {};" },
    });
    root.unmount();
    el.remove();
  });
});
