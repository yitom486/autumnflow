import { describe, expect, it, vi, beforeAll } from "vitest";
import React, { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  AgentActivity,
  type AgentActivityItem,
} from "@/components/agents/agent-activity";
import {
  Citation,
  Citations,
  type CitationItem,
} from "@/components/primitives/Citations";
import { AcpMarkdownText } from "@/components/assistant/AcpMarkdown";

describe("Stage 2: beUI AgentActivity & Citations", () => {
  beforeAll(() => {
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

  it("renders AgentActivity in working state with ThinkingShimmer", async () => {
    const items: AgentActivityItem[] = [
      { id: "step-1", type: "step", label: "分析项目结构", status: "active" },
    ];

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);

    await act(async () => {
      root.render(
        h(AgentActivity, {
          items,
          status: "working",
          duration: 3.2,
        }),
      );
    });

    const activity = el.querySelector('[data-content][data-state]');
    expect(activity).toBeTruthy();
    expect(activity?.getAttribute("data-state")).toBe("working");
    expect(activity?.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      root.unmount();
    });
    el.remove();
  });

  it("renders AgentActivity completed state with tool calls, diff counts and disclosure", async () => {
    const items: AgentActivityItem[] = [
      { id: "step-1", type: "step", label: "阅读需求文档", status: "complete" },
      {
        id: "tool-1",
        type: "tool",
        action: "edit",
        target: "launch-plan.ts",
        additions: 42,
        deletions: 8,
      },
      {
        id: "search-1",
        type: "search",
        query: "beUI motion primitives",
        results: [{ id: "r1", title: "Motion Specs", domain: "beui.dev" }],
      },
    ];

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);

    await act(async () => {
      root.render(
        h(AgentActivity, {
          items,
          status: "complete",
          duration: 4.8,
          defaultOpen: true,
        }),
      );
    });

    const activity = el.querySelector('[data-content][data-state]');
    expect(activity).toBeTruthy();
    expect(activity?.getAttribute("data-state")).toBe("open");

    // Check additions and deletions diff badges
    expect(el.textContent).toContain("+42");
    expect(el.textContent).toContain("−8");
    expect(el.textContent).toContain("launch-plan.ts");
    expect(el.textContent).toContain("beUI motion primitives");

    await act(async () => {
      root.unmount();
    });
    el.remove();
  });

  it("renders Citations badge and collapsible sources drawer", async () => {
    const citations: CitationItem[] = [
      {
        id: "c1",
        title: "Motion Documentation",
        domain: "motion.dev",
        url: "https://motion.dev/docs",
      },
      {
        id: "c2",
        title: "W3C Accessibility Standards",
        domain: "w3.org",
        url: "https://www.w3.org/WAI",
      },
    ];

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);

    await act(async () => {
      root.render(
        h("div", null,
          h("p", null,
            "参考官方文档",
            h(Citation, { citationId: "c1", index: 1, idPrefix: "test" }),
            "以及无障碍标准",
            h(Citation, { citationId: "c2", index: 2, idPrefix: "test" }),
          ),
          h(Citations, { citations, defaultOpen: true, idPrefix: "test" }),
        ),
      );
    });

    // Check badges
    const badges = el.querySelectorAll('[data-slot="citation-badge"]');
    expect(badges.length).toBe(2);
    expect(badges[0].textContent).toBe("1");
    expect(badges[1].textContent).toBe("2");

    // Check citations drawer
    const drawer = el.querySelector('[data-slot="citations"]');
    expect(drawer).toBeTruthy();
    expect(el.textContent).toContain("引用来源");
    expect(el.textContent).toContain("Motion Documentation");
    expect(el.textContent).toContain("motion.dev");
    expect(el.textContent).toContain("W3C Accessibility Standards");

    await act(async () => {
      root.unmount();
    });
    el.remove();
  });

  it("renders AgentActivity thinking trace with defaultExpanded fullContent visible", async () => {
    const { AgentActivity: AgentActivityNew } = await import("@/components/agents/agent-activity");
    const items = [
      {
        id: "thought-1",
        type: "trace" as const,
        kind: "thinking" as const,
        label: "思考过程",
        detail: "(111 字)",
        fullContent: h("div", { "data-testid": "thought-body" }, "深入分析 VSCode 渲染架构限制..."),
      },
    ];

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);

    await act(async () => {
      root.render(
        h(AgentActivityNew, {
          items,
          status: "working",
          duration: 2.5,
        }),
      );
    });

    const thoughtBody = el.querySelector('[data-testid="thought-body"]');
    expect(thoughtBody).toBeTruthy();
    expect(thoughtBody?.textContent).toContain("深入分析 VSCode 渲染架构限制...");

    await act(async () => {
      root.unmount();
    });
    el.remove();
  });
});
