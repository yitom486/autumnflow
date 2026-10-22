import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityPanel } from "../../src/components/universal/CapabilityPanel";

const { fetchCapabilities, setCapabilityTool, setCapabilitySkill } = vi.hoisted(() => ({
  fetchCapabilities: vi.fn(),
  setCapabilityTool: vi.fn(),
  setCapabilitySkill: vi.fn(),
}));

vi.mock("../../src/lib/universal-api", async original => ({
  ...(await original<typeof import("../../src/lib/universal-api")>()),
  fetchCapabilities,
  setCapabilityTool,
  setCapabilitySkill,
}));

const snapshot = {
  mcp: {
    server: { name: "studio-ui", url: "http://127.0.0.1:25920/mcp", port: 25920, running: true },
    agentSupports: { http: true, stdio: false },
    tools: [
      { name: "show_interactive_card", title: "富交互卡片", summary: "决策 / 清单 / 指标 / 表单四类结构化卡片", enabled: true },
      { name: "render_editorial_diagram", title: "出版级图表", summary: "架构 / 时序 / 流程矢量图", enabled: false },
    ],
  },
  skills: [
    { name: "diagram-design", title: "出版级矢量图表设计", description: "图表设计规范", enabled: true },
    { name: "generative-ui", title: "生成式交互卡片规范", description: "卡片设计规范", enabled: false },
  ],
};

beforeEach(() => {
  fetchCapabilities.mockReset();
  setCapabilityTool.mockReset();
  setCapabilitySkill.mockReset();
  fetchCapabilities.mockResolvedValue(snapshot);
  setCapabilityTool.mockResolvedValue(undefined);
  setCapabilitySkill.mockResolvedValue(undefined);
});

afterEach(() => {
  fetchCapabilities.mockReset();
  setCapabilityTool.mockReset();
  setCapabilitySkill.mockReset();
  document.body.innerHTML = "";
});

// The panel renders in a portal on document.body (native <dialog>), so the
// queries look at the document rather than the React container.
function switches(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[role="switch"]')) as HTMLElement[];
}

function panel(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

async function renderPanel(props: Partial<React.ComponentProps<typeof CapabilityPanel>> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<CapabilityPanel isOpen agentId="codex" onClose={() => {}} {...props} />));
  return {
    root,
    host,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("capability panel", () => {
  it("shows the MCP server, the tools and the skills with their state", async () => {
    const view = await renderPanel();
    try {
      expect(fetchCapabilities).toHaveBeenCalledWith("codex");
      const text = panel()?.textContent ?? "";
      expect(text).toContain("studio-ui");
      expect(text).toContain("25920");
      expect(text).toContain("富交互卡片");
      expect(text).toContain("出版级矢量图表设计");
      // 1 of 2 tools and 1 of 2 skills are on.
      expect(text).toContain("1/2 已启用");
      const states = switches().map((el) => el.getAttribute("aria-checked"));
      expect(states).toEqual(["true", "false", "true", "false"]);
      // Every toggle must carry an accessible name.
      const names = switches().map((el) => el.getAttribute("aria-label"));
      expect(names).toEqual([
        "富交互卡片 开关",
        "出版级图表 开关",
        "出版级矢量图表设计 开关",
        "生成式交互卡片规范 开关",
      ]);
    } finally {
      await view.unmount();
    }
  });

  it("turns a tool off and keeps the switch in the new state", async () => {
    const view = await renderPanel();
    try {
      const toolSwitch = switches()[0];
      await act(async () => toolSwitch.click());
      expect(setCapabilityTool).toHaveBeenCalledWith("show_interactive_card", false);
      expect(switches()[0].getAttribute("aria-checked")).toBe("false");
    } finally {
      await view.unmount();
    }
  });

  it("turns a skill on and reports a failure instead of lying about the state", async () => {
    const view = await renderPanel();
    try {
      const skillSwitch = switches()[3];
      await act(async () => skillSwitch.click());
      expect(setCapabilitySkill).toHaveBeenCalledWith("generative-ui", true);

      setCapabilitySkill.mockRejectedValueOnce(new Error("切换技能失败"));
      await act(async () => skillSwitch.click());
      expect(panel()?.querySelector('[role="alert"]')?.textContent).toContain("切换技能失败");
      // The optimistic state is rolled back to the server truth.
      expect(switches()[3].getAttribute("aria-checked")).toBe("false");
    } finally {
      await view.unmount();
    }
  });

  it("does not render anything while closed", async () => {
    const view = await renderPanel({ isOpen: false });
    try {
      expect(panel()).toBeNull();
      expect(fetchCapabilities).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });
});
