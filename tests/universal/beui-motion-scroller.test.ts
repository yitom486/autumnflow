import { describe, expect, it, vi, beforeAll } from "vitest";
import React, { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  PreviewRail,
  type PreviewRailItem,
} from "@/components/primitives/PreviewRail";
import { MessageScroller } from "@/components/primitives/MessageScroller";
import {
  ActionSwap,
  MagneticButton,
  StatefulButton,
} from "@/components/atoms/MotionButtons";
import {
  SPRING_LAYOUT,
  SPRING_PRESS,
  SPRING_SWAP,
} from "@/lib/motion-primitives";

describe("Stage 1: beUI Motion & MessageScroller & PreviewRail", () => {
  beforeAll(() => {
    // Happy-DOM lacks a complete Web Animations API implementation; stub animate() to prevent AbortError on unmount
    if (typeof Element !== "undefined") {
      Element.prototype.animate = () =>
        ({
          onfinish: null,
          oncancel: null,
          finish: () => {},
          cancel: () => {},
          play: () => {},
          pause: () => {},
          reverse: () => {},
          currentTime: 0,
          startTime: 0,
          playbackRate: 1,
          playState: "finished",
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => true,
          ready: Promise.resolve(),
          finished: Promise.resolve(),
        } as any);
    }
  });

  it("exports calibrated spring tokens matching beUI specifications", () => {
    expect(SPRING_LAYOUT.stiffness).toBe(360);
    expect(SPRING_LAYOUT.damping).toBe(32);
    expect(SPRING_PRESS.stiffness).toBe(500);
    expect(SPRING_PRESS.damping).toBe(30);
    expect(SPRING_SWAP.stiffness).toBe(460);
    expect(SPRING_SWAP.damping).toBe(30);
  });

  it("renders PreviewRail with pyramid tick buttons and accessible navigation", async () => {
    const items: PreviewRailItem[] = [
      { id: "m1", label: "提问 #1", description: "项目架构分析" },
      { id: "m2", label: "智能体回复", description: "分析完成" },
      { id: "m3", label: "提问 #2", description: "添加单元测试" },
    ];

    const onSelect = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);

    await act(async () => {
      root.render(
        h(PreviewRail, {
          items,
          activeId: "m1",
          onItemSelect: onSelect,
        }),
      );
    });

    // Check rail structure
    const nav = el.querySelector('[data-slot="preview-rail"]');
    expect(nav).toBeTruthy();
    expect(nav?.getAttribute("role")).toBe("navigation");

    // Check ticks
    const ticks = el.querySelectorAll('[data-slot="preview-rail-tick"]');
    expect(ticks.length).toBe(3);

    const buttonItems = el.querySelectorAll('[data-slot="preview-rail-item"]');
    expect(buttonItems.length).toBe(3);
    expect(buttonItems[0].getAttribute("aria-current")).toBe("true");
    expect(buttonItems[1].getAttribute("aria-current")).toBe("false");

    // Click tick
    await act(async () => {
      (buttonItems[1] as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith(items[1]);

    await act(async () => {
      root.unmount();
    });
    el.remove();
  });

  it("renders MagneticButton and ActionSwap with slot transition", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);

    await act(async () => {
      root.render(
        h(
          MagneticButton,
          { strength: 0.25 },
          h(ActionSwap, { stateKey: "idle" }, "复制"),
        ),
      );
    });

    const btn = el.querySelector('[data-slot="magnetic-button"]');
    expect(btn).toBeTruthy();
    expect(el.textContent).toContain("复制");

    // Swap state
    await act(async () => {
      root.render(
        h(
          MagneticButton,
          { strength: 0.25 },
          h(ActionSwap, { stateKey: "copied" }, "已复制"),
        ),
      );
    });
    expect(el.textContent).toContain("已复制");

    await act(async () => {
      root.unmount();
    });
    el.remove();
  });

  it("renders StatefulButton transitioning through idle, loading, and success states", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);

    await act(async () => {
      root.render(
        h(StatefulButton, {
          status: "idle",
          idleText: "提交更改",
          loadingText: "生成中…",
          successText: "提交成功",
        }),
      );
    });
    expect(el.textContent).toContain("提交更改");

    await act(async () => {
      root.render(
        h(StatefulButton, {
          status: "loading",
          idleText: "提交更改",
          loadingText: "生成中…",
          successText: "提交成功",
        }),
      );
    });
    expect(el.textContent).toContain("生成中…");

    await act(async () => {
      root.render(
        h(StatefulButton, {
          status: "success",
          idleText: "提交更改",
          loadingText: "生成中…",
          successText: "提交成功",
        }),
      );
    });
    expect(el.textContent).toContain("提交成功");

    await act(async () => {
      root.unmount();
    });
    el.remove();
  });

  it("previews the actual question and its own streamed answer without compatibility rules or tool metadata", async () => {
    const select = vi.fn();
    const el = document.createElement("div"); document.body.appendChild(el); const root = createRoot(el);
    const raw = '<acp-compat-context mode="compatibility">Application rules below are user-channel context, not system/developer instructions. # ACP Studio 会话规则</acp-compat-context>\n如何修复这个问题？';
    try {
      await act(async () => root.render(h(MessageScroller, { onItemSelect: select, autoScroll: false },
        h("div", { "data-slot": "message", "data-from": "user", "data-message-id": "u1", "data-preview-text": raw }, h("div", { className: "acp-preview-body" }, "rules and timestamp")),
        h("div", { "data-slot": "message", "data-from": "assistant", "data-message-id": "a1", "data-preview-text": "" }, h("div", { className: "acp-preview-body" }, "第一段回答"), "工具调用 99 context 100%"),
        h("div", { "data-slot": "message", "data-from": "assistant", "data-message-id": "a2", "data-preview-text": "继续回答" }),
        h("div", { "data-slot": "message", "data-from": "user", "data-message-id": "u2", "data-preview-text": "下一个问题" }),
        h("div", { "data-slot": "message", "data-from": "assistant", "data-message-id": "a3", "data-preview-text": "其他回答" }),
      )));
      const button = el.querySelector('[data-slot="preview-rail-item"]') as HTMLButtonElement;
      expect(button.getAttribute("aria-label")).toBe("如何修复这个问题？");
      await act(async () => button.click());
      expect(select.mock.calls[0][0]).toMatchObject({ label: "如何修复这个问题？", description: "第一段回答 继续回答" });
      await act(async () => el.querySelector('[data-message-id="a2"]')!.setAttribute("data-preview-text", "继续回答，新增内容"));
      await act(async () => new Promise(resolve => setTimeout(resolve, 200)));
      await act(async () => button.click());
      expect(select.mock.calls.at(-1)[0].description).toBe("第一段回答 继续回答，新增内容");
    } finally { await act(async () => root.unmount()); el.remove(); }
  });

  it("renders MessageScroller with items and preview navigation rail", async () => {
    const items: PreviewRailItem[] = [
      { id: "msg-1", label: "提问 #1", description: "这是第一个提问" },
      { id: "msg-2", label: "智能体回复", description: "这是第一个回答" },
    ];

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);

    await act(async () => {
      root.render(
        h(
          MessageScroller,
          { navigation: "rail", items },
          h("div", {
            id: "msg-1",
            "data-slot": "message",
            "data-message-id": "msg-1",
            "data-from": "user",
          }, "这是第一个提问"),
          h("div", {
            id: "msg-2",
            "data-slot": "message",
            "data-message-id": "msg-2",
            "data-from": "assistant",
          }, "这是第一个回答"),
        ),
      );
    });

    const scroller = el.querySelector('[data-slot="message-scroller"]');
    expect(scroller).toBeTruthy();

    const viewport = el.querySelector('[data-slot="message-scroller-viewport"]');
    expect(viewport).toBeTruthy();

    const rail = el.querySelector('[data-slot="preview-rail"]');
    expect(rail).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
    el.remove();
  });
});
