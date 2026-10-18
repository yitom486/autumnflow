import { describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorialDiagramCard, type DiagramType } from "../../src/components/assistant/EditorialDiagramCard";
import { editorialCases } from "../fixtures/diagram-cases";

function render(kind: DiagramType, data: Record<string, unknown>) {
  const markup = renderToStaticMarkup(createElement(EditorialDiagramCard, { title: "测试图表", diagramType: kind, data }));
  const container = document.createElement("div");
  container.innerHTML = markup;
  const svg = container.querySelector<SVGSVGElement>('svg[viewBox]:not([viewBox="0 0 24 24"])')!;
  expect(svg).not.toBeNull();
  expect(svg.outerHTML).not.toMatch(/NaN|Infinity|undefined/);
  return svg;
}

describe("Structured diagram payload contracts", () => {
  for (const scenario of editorialCases) {
    it(`${scenario.kind} preserves the agent's labels and valid SVG geometry`, () => {
      const svg = render(scenario.kind, scenario.data);
      for (const label of scenario.labels) expect(svg.textContent).toContain(label);
      expect(svg.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/);
    });
    it(`${scenario.kind} handles empty collections without invalid SVG coordinates`, () => {
      render(scenario.kind, {});
    });
  }

  it("architecture accurately aligns connections along center spine or node coordinates without fake modulo offsets", () => {
    const svg = render("architecture", {
      layers: [
        { id: "app", title: "应用层", nodes: [{ id: "n1", label: "PyTorch" }, { id: "n2", label: "LLM" }] },
        { id: "lib", title: "库层", nodes: [{ id: "n3", label: "cuBLAS" }, { id: "n4", label: "NCCL" }] },
        { id: "hw", title: "硬件层", nodes: [{ id: "n5", label: "SM" }, { id: "n6", label: "HBM" }] },
      ],
      connections: [
        { from: "app", to: "lib", label: "调用" },
        { from: "lib", to: "hw", label: "PTX" },
        { from: "n3", to: "n5", label: "SASS" },
      ],
    });

    const paths = svg.querySelectorAll("path[marker-end]");
    expect(paths).toHaveLength(3);
    // 层间调用应居中于 320（不再出现 (idx % 3 - 1) * 60 导致的伪随机偏斜）
    expect(paths[0].getAttribute("d")).toBe("M 320 118 L 320 152");
    expect(paths[1].getAttribute("d")).toBe("M 320 246 L 320 280");
    // 节点间调用（n3 cuBLAS 到 n5 SM）应垂直对齐到节点 X 坐标
    expect(paths[2].getAttribute("d")).toContain("M 168");
    expect(paths[2].getAttribute("d")).toContain("L 168");
  });

  it("flowchart supports nodes/edges aliases and drops unresolved connections", () => {
    const svg = render("flowchart", {
      nodes: [{ id: "a", name: "开始" }, { id: "b", name: "完成" }],
      edges: [{ source: "a", target: "b" }, { source: "missing", target: "b" }],
    });
    expect(svg.textContent).toContain("开始");
    expect(svg.textContent).toContain("完成");
    expect(svg.querySelectorAll("line[marker-end]")).toHaveLength(1);
  });

  it("sequence supports explicit participants, self calls and dashed replies", () => {
    const svg = render("sequence", {
      participants: [{ id: "client", label: "客户端" }, { id: "server", label: "服务端" }],
      messages: [{ from: "client", to: "server", label: "请求" },
        { from: "server", to: "server", label: "内部处理" },
        { from: "server", to: "client", label: "响应", type: "reply" }],
    });
    expect(svg.querySelectorAll("[marker-end]")).toHaveLength(3);
    expect(svg.querySelector("path[marker-end]")).not.toBeNull();
    expect(svg.querySelector('line[marker-end][stroke-dasharray="3 3"]')).not.toBeNull();
  });

  it("fullscreen escapes transformed chat containers and restores scrolling on Escape", async () => {
    const host = document.createElement("div");
    host.style.transform = "translateZ(0)";
    host.style.contain = "paint";
    document.body.appendChild(host);
    const root = createRoot(host);
    const overflow = document.body.style.overflow;
    try {
      await act(async () => root.render(createElement(EditorialDiagramCard, {
        title: "全屏回归", diagramType: "flowchart", data: editorialCases.find(item => item.kind === "flowchart")!.data,
      })));
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="全屏放大"]')!.click());
      const dialog = document.querySelector('[role="dialog"][aria-label="全屏回归 全屏预览"]')!;
      expect(dialog.parentElement).toBe(document.body);
      expect(document.body.style.overflow).toBe("hidden");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("退出全屏");
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
      expect(document.querySelector('[aria-label="全屏回归 全屏预览"]')).toBeNull();
      expect(host.querySelector('[aria-label="全屏放大"]')).not.toBeNull();
      expect(document.body.style.overflow).toBe(overflow);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      document.body.style.overflow = overflow;
    }
  });
});
